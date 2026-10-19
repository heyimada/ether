import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { reposDir } from "./config";

export const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;

export function validRepoName(name: string): boolean {
  return NAME_RE.test(name) && name !== "." && name !== ".." && !name.startsWith(".") && !name.toLowerCase().endsWith(".git");
}

// Resolves the on-disk bare repo and refuses anything that would land outside the repos dir.
export function repoPath(owner: string, name: string): string {
  const root = reposDir();
  const path = resolve(root, owner.toLowerCase(), `${name.toLowerCase()}.git`);
  const rel = relative(root, path);
  if (rel.startsWith("..") || rel.includes(`..${sep}`) || resolve(root, rel) !== path) throw new Error("path escapes repos dir");
  return path;
}

export type GitResult = { code: number; stdout: Uint8Array; stderr: string };

export async function git(repo: string, args: string[], opts: { stdin?: Uint8Array; env?: Record<string, string> } = {}): Promise<GitResult> {
  const proc = Bun.spawn(["git", "--git-dir", repo, ...args], {
    stdin: opts.stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", ...opts.env },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).bytes(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

export async function gitText(repo: string, args: string[]): Promise<string> {
  const res = await git(repo, args);
  if (res.code !== 0) throw new GitError(args, res.stderr);
  return new TextDecoder().decode(res.stdout);
}

export class GitError extends Error {
  constructor(args: string[], public stderr: string) {
    super(`git ${args[0]} failed: ${stderr.trim()}`);
  }
}

export async function initBare(path: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const proc = Bun.spawn(["git", "init", "--bare", "--quiet", "--initial-branch=main", path], { stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`git init failed: ${await new Response(proc.stderr).text()}`);
  await gitText(path, ["config", "receive.denyNonFastForwards", "false"]);
  await gitText(path, ["config", "uploadpack.allowFilter", "true"]);
}

export function removeRepo(path: string) {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true, maxRetries: 5 });
}

// ---------- refs ----------

export type Ref = { name: string; kind: "branch" | "tag"; sha: string };

export async function listRefs(repo: string): Promise<Ref[]> {
  // Newest first, so "latest tag" means latest created rather than last by name.
  const out = await gitText(repo, ["for-each-ref", "--sort=-creatordate", "--format=%(refname)%00%(objectname)", "refs/heads", "refs/tags"]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref, sha] = line.split("\0");
      return ref.startsWith("refs/heads/")
        ? { name: ref.slice(11), kind: "branch" as const, sha }
        : { name: ref.slice(10), kind: "tag" as const, sha };
    });
}

export async function headBranch(repo: string): Promise<string> {
  const res = await git(repo, ["symbolic-ref", "--short", "HEAD"]);
  return new TextDecoder().decode(res.stdout).trim() || "main";
}

// After a push into an empty repo whose HEAD points at a branch that does not exist,
// point HEAD at the first pushed branch so clones check something out.
export async function fixHead(repo: string): Promise<void> {
  const head = await headBranch(repo);
  const branches = (await listRefs(repo)).filter((r) => r.kind === "branch");
  if (branches.length === 0 || branches.some((b) => b.name === head)) return;
  const pick = branches.find((b) => b.name === "main") ?? branches.find((b) => b.name === "master") ?? branches[0];
  await gitText(repo, ["symbolic-ref", "HEAD", `refs/heads/${pick.name}`]);
}

export async function resolveCommit(repo: string, rev: string): Promise<string | null> {
  const res = await git(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`]);
  return res.code === 0 ? new TextDecoder().decode(res.stdout).trim() : null;
}

// ---------- browsing ----------

export type TreeEntry = { name: string; path: string; type: "blob" | "tree" | "commit"; mode: string; size: number | null };

export async function readTree(repo: string, rev: string, path: string): Promise<TreeEntry[] | null> {
  const spec = path ? `${rev}:${path}` : `${rev}^{tree}`;
  const res = await git(repo, ["ls-tree", "-z", "-l", "--end-of-options", spec]);
  if (res.code !== 0) return null;
  const entries = new TextDecoder()
    .decode(res.stdout)
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      const [mode, type, , size] = line.slice(0, tab).split(/\s+/);
      const name = line.slice(tab + 1);
      return { name, path: path ? `${path}/${name}` : name, type: type as TreeEntry["type"], mode, size: size === "-" ? null : Number(size) };
    });
  return entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "tree" ? -1 : 1));
}

export type EntryCommit = { sha: string; subject: string; date: number };
const ENTRY_COMMIT_SCAN = 1000;

// The latest commit touching each direct child of a directory, from one bounded log walk.
// Entries untouched in the newest commits are left out rather than walking all history.
export async function entryCommits(repo: string, rev: string, path: string): Promise<Record<string, EntryCommit>> {
  const out = await gitText(repo, [
    "-c",
    "core.quotepath=false",
    "log",
    "--format=%x1e%H%x1f%s%x1f%ct",
    "--name-only",
    `-n${ENTRY_COMMIT_SCAN}`,
    "--end-of-options",
    rev,
    "--",
    path || ".",
  ]);
  const prefix = path ? `${path}/` : "";
  const found: Record<string, EntryCommit> = {};
  for (const chunk of out.split("\x1e")) {
    if (!chunk) continue;
    const [head, ...files] = chunk.split("\n");
    const [sha, subject, ct] = head.split("\x1f");
    for (const file of files) {
      if (!file.startsWith(prefix)) continue;
      const child = file.slice(prefix.length).split("/")[0];
      if (child && !found[child]) found[child] = { sha, subject, date: Number(ct) * 1000 };
    }
  }
  return found;
}

export const MAX_BLOB_DISPLAY = 1024 * 1024;

export async function readBlob(repo: string, rev: string, path: string) {
  const spec = `${rev}:${path}`;
  const type = await git(repo, ["cat-file", "-t", "--end-of-options", spec]);
  if (type.code !== 0 || new TextDecoder().decode(type.stdout).trim() !== "blob") return null;
  const size = Number(await gitText(repo, ["cat-file", "-s", "--end-of-options", spec]));
  if (size > MAX_BLOB_DISPLAY) return { size, binary: false, tooLarge: true, content: null };
  const blob = await git(repo, ["cat-file", "blob", "--end-of-options", spec]);
  const head = blob.stdout.subarray(0, 8000);
  const binary = head.includes(0);
  return { size, binary, tooLarge: false, content: binary ? null : new TextDecoder().decode(blob.stdout) };
}

export async function rawBlob(repo: string, rev: string, path: string): Promise<Uint8Array | null> {
  const res = await git(repo, ["cat-file", "blob", "--end-of-options", `${rev}:${path}`]);
  return res.code === 0 ? res.stdout : null;
}

export type Commit = { sha: string; parents: string[]; author: string; email: string; date: number; subject: string; body: string };

const LOG_FORMAT = "%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%b%x1e";

function parseLog(out: string): Commit[] {
  return out
    .split("\x1e")
    .map((s) => s.replace(/^\n/, ""))
    .filter(Boolean)
    .map((rec) => {
      const [sha, parents, author, email, at, subject, body] = rec.split("\x1f");
      return { sha, parents: parents ? parents.split(" ") : [], author, email, date: Number(at) * 1000, subject, body: body.trim() };
    });
}

export async function log(repo: string, rev: string, opts: { path?: string; skip?: number; limit?: number } = {}): Promise<Commit[]> {
  const args = ["log", `--format=${LOG_FORMAT}`, `--skip=${opts.skip ?? 0}`, `-n`, String(opts.limit ?? 30), "--end-of-options", rev, "--"];
  if (opts.path) args.push(opts.path);
  return parseLog(await gitText(repo, args));
}

export async function commitCount(repo: string, rev: string): Promise<number> {
  return Number((await gitText(repo, ["rev-list", "--count", "--end-of-options", rev])).trim());
}

export const ACTIVITY_WEEKS = 12;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Non-merge commits reachable from rev in the last 12 weeks, bucketed into 7-day windows
// ending now (oldest first) and grouped by author email. Committer time is used so
// rebased or merged-in work counts as recent activity.
export async function activity(repo: string, rev: string, now = Date.now()) {
  const since = new Date(now - ACTIVITY_WEEKS * WEEK_MS).toISOString();
  const out = await gitText(repo, ["log", "--no-merges", "--format=%ct%x1f%an%x1f%ae", `--since=${since}`, "--end-of-options", rev, "--"]);
  const weeks = new Array<number>(ACTIVITY_WEEKS).fill(0);
  const authors = new Map<string, { name: string; email: string; commits: number }>();
  let total = 0;
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [ct, name, email] = line.split("\x1f");
    const age = now - Number(ct) * 1000;
    if (age >= ACTIVITY_WEEKS * WEEK_MS) continue;
    // Clock skew can put commits slightly in the future; they belong to the current week.
    weeks[ACTIVITY_WEEKS - 1 - Math.max(0, Math.floor(age / WEEK_MS))]++;
    const key = email.toLowerCase() || name;
    const a = authors.get(key) ?? { name, email, commits: 0 };
    a.commits++;
    authors.set(key, a);
    total++;
  }
  return {
    since: now - ACTIVITY_WEEKS * WEEK_MS,
    weeks,
    total,
    authors: [...authors.values()].sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name)),
  };
}

// Author email and commit time of every non-merge commit on rev since the given time.
export async function authorTimes(repo: string, rev: string, since: Date): Promise<{ email: string; at: number }[]> {
  const out = await gitText(repo, ["log", "--no-merges", "--format=%ae%x1f%ct", `--since=${since.toISOString()}`, "--end-of-options", rev, "--"]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [email, ct] = line.split("\x1f");
      return { email: email.toLowerCase(), at: Number(ct) * 1000 };
    });
}

// Author emails of the commits reachable from `after` but from none of `before`, i.e. what a
// push brought in. Bounded so a huge import can't stall the response.
export async function newAuthorEmails(repo: string, before: string[], after: string[]): Promise<string[]> {
  const fresh = after.filter((sha) => !before.includes(sha));
  if (fresh.length === 0) return [];
  const out = await gitText(repo, ["log", "--no-merges", "--format=%ae", "-n", "10000", ...fresh, "--not", ...before, "--"]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((e) => e.toLowerCase());
}

export async function rangeCommits(repo: string, base: string, head: string): Promise<Commit[]> {
  return parseLog(await gitText(repo, ["log", `--format=${LOG_FORMAT}`, "--end-of-options", `${base}..${head}`]));
}

const MAX_DIFF = 4 * 1024 * 1024;

async function boundedDiff(repo: string, args: string[]): Promise<{ diff: string; truncated: boolean }> {
  const res = await git(repo, args);
  if (res.code !== 0) throw new GitError(args, res.stderr);
  const truncated = res.stdout.length > MAX_DIFF;
  return { diff: new TextDecoder().decode(truncated ? res.stdout.subarray(0, MAX_DIFF) : res.stdout), truncated };
}

export async function showCommit(repo: string, sha: string) {
  const [commit] = parseLog(await gitText(repo, ["log", "-1", `--format=${LOG_FORMAT}`, "--end-of-options", sha]));
  // --first-parent style diff for merges keeps the view meaningful.
  const parent = commit.parents[0];
  const { diff, truncated } = parent
    ? await boundedDiff(repo, ["diff", "--no-color", "-M", "--end-of-options", parent, sha])
    : await boundedDiff(repo, ["show", "--no-color", "--format=", "-M", "--end-of-options", sha]);
  return { commit, diff, truncated };
}

export async function compare(repo: string, base: string, head: string) {
  const commits = await rangeCommits(repo, base, head);
  const { diff, truncated } = await boundedDiff(repo, ["diff", "--no-color", "-M", "--end-of-options", `${base}...${head}`]);
  return { commits, diff, truncated };
}

// ---------- merging (bare repo, no worktree) ----------

export async function mergeTree(repo: string, base: string, head: string): Promise<{ clean: true; tree: string } | { clean: false; conflicts: string[] }> {
  const res = await git(repo, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "--end-of-options", base, head]);
  const lines = new TextDecoder().decode(res.stdout).split("\n").filter(Boolean);
  if (res.code === 0) return { clean: true, tree: lines[0] };
  if (res.code === 1) return { clean: false, conflicts: lines.slice(1) };
  throw new GitError(["merge-tree"], res.stderr);
}

export async function mergeBranches(
  repo: string,
  baseBranch: string,
  headBranch: string,
  message: string,
  author: { name: string; email: string },
): Promise<{ ok: true; sha: string } | { ok: false; reason: "conflict" | "missing" | "raced" }> {
  const baseSha = await resolveCommit(repo, `refs/heads/${baseBranch}`);
  const headSha = await resolveCommit(repo, `refs/heads/${headBranch}`);
  if (!baseSha || !headSha) return { ok: false, reason: "missing" };
  const merged = await mergeTree(repo, baseSha, headSha);
  if (!merged.clean) return { ok: false, reason: "conflict" };
  const env = {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  };
  const commit = await git(repo, ["commit-tree", merged.tree, "-p", baseSha, "-p", headSha, "-m", message], { env });
  if (commit.code !== 0) throw new GitError(["commit-tree"], commit.stderr);
  const sha = new TextDecoder().decode(commit.stdout).trim();
  // Compare-and-swap: fails if someone pushed to the base branch meanwhile.
  const update = await git(repo, ["update-ref", "-m", "merge pull request", `refs/heads/${baseBranch}`, sha, baseSha]);
  if (update.code !== 0) return { ok: false, reason: "raced" };
  return { ok: true, sha };
}

export const repoExists = (path: string) => existsSync(join(path, "HEAD"));
