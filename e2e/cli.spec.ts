import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseURL, createUser, loginAdmin, unique } from "./helpers";

const root = join(import.meta.dirname, "..");
const bin = join(root, "cli", "target", "release", process.platform === "win32" ? "ether.exe" : "ether");

// Isolated from the developer's own git and ether configuration.
function runner(configDir: string) {
  const emptyGitConfig = join(configDir, "empty.gitconfig");
  writeFileSync(emptyGitConfig, "");
  const env = {
    ...process.env,
    ETHER_CONFIG_DIR: configDir,
    GIT_CONFIG_GLOBAL: emptyGitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_AUTHOR_NAME: "CLI",
    GIT_AUTHOR_EMAIL: "cli@ether.test",
    GIT_COMMITTER_NAME: "CLI",
    GIT_COMMITTER_EMAIL: "cli@ether.test",
  };
  const ether = (args: string[], opts: { cwd?: string; input?: string } = {}) => {
    const r = spawnSync(bin, args, { cwd: opts.cwd ?? configDir, env, input: opts.input, encoding: "utf8" });
    return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
  };
  const ok = (args: string[], opts: { cwd?: string; input?: string } = {}) => {
    const r = ether(args, opts);
    if (r.code !== 0) throw new Error(`ether ${args.join(" ")} failed (${r.code}):\n${r.err}${r.out}`);
    return r.out;
  };
  const gitOk = (cwd: string, args: string[]) => {
    const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed:\n${r.stderr}`);
    return r.stdout;
  };
  return { ether, ok, gitOk };
}

test.beforeAll(async () => {
  test.setTimeout(15 * 60 * 1000);
  const build = spawnSync("cargo", ["build", "--release", "--quiet"], { cwd: join(root, "cli"), encoding: "utf8" });
  if (build.status !== 0) throw new Error(`cargo build failed:\n${build.stderr}`);
  expect(existsSync(bin)).toBe(true);
});

test("the ether CLI logs in, manages repositories, issues and pull requests, and works as a git credential helper", async () => {
  const admin = await loginAdmin();
  const me = await createUser(admin);
  const home = mkdtempSync(join(tmpdir(), "ether-cli-"));
  const { ether, ok, gitOk } = runner(home);

  // A wrong token is refused and nothing is saved.
  expect(ether(["auth", "login", "--host", baseURL(), "--with-token"], { input: "eth_not-a-real-token\n" }).code).not.toBe(0);
  expect(ether(["auth", "status"]).code).not.toBe(0);

  expect(ok(["auth", "login", "--host", baseURL(), "--with-token"], { input: `${me.token}\n` })).toContain(`Logged in to ${baseURL()} as ${me.username}`);
  expect(ok(["auth", "status"])).toContain(me.username);

  const repo = unique("cli");
  expect(ok(["repo", "create", repo, "--description", "made from the CLI", "--public"])).toContain(`${me.username}/${repo}`);
  expect(ok(["repo", "list"])).toContain(`${me.username}/${repo}`);
  const view = JSON.parse(ok(["repo", "view", `${me.username}/${repo}`, "--json"]));
  expect(view.repo).toMatchObject({ name: repo, description: "made from the CLI", visibility: "public" });

  // Clone sets up the credential helper, so plain git push works afterwards.
  const work = mkdtempSync(join(tmpdir(), "ether-cli-work-"));
  ok(["repo", "clone", `${me.username}/${repo}`, "w"], { cwd: work });
  const dir = join(work, "w");
  writeFileSync(join(dir, "README.md"), "# from the CLI\n");
  gitOk(dir, ["add", "-A"]);
  gitOk(dir, ["commit", "-q", "-m", "first"]);
  gitOk(dir, ["branch", "-M", "main"]);
  gitOk(dir, ["push", "-q", "origin", "main"]);

  // Issues, with the repository inferred from the clone's origin.
  expect(ok(["issue", "create", "--title", "Filed from the terminal", "--body", "It works"], { cwd: dir })).toMatch(/#1\b/);
  expect(ok(["issue", "list"], { cwd: dir })).toContain("Filed from the terminal");
  ok(["issue", "comment", "1", "--body", "Following up"], { cwd: dir });
  expect(ok(["issue", "view", "1"], { cwd: dir })).toContain("Following up");
  ok(["issue", "close", "1"], { cwd: dir });
  expect(ok(["issue", "list"], { cwd: dir })).not.toContain("Filed from the terminal");
  expect(ok(["issue", "list", "--state", "closed", "-R", `${me.username}/${repo}`])).toContain("Filed from the terminal");

  // A pull request from a pushed branch, merged from the CLI.
  gitOk(dir, ["checkout", "-q", "-b", "feature/cli"]);
  writeFileSync(join(dir, "feature.txt"), "feature\n");
  gitOk(dir, ["add", "-A"]);
  gitOk(dir, ["commit", "-q", "-m", "feature"]);
  gitOk(dir, ["push", "-q", "origin", "feature/cli"]);
  expect(ok(["pr", "create", "--base", "main", "--title", "Add the feature"], { cwd: dir })).toMatch(/#2\b/);
  expect(ok(["pr", "list"], { cwd: dir })).toContain("Add the feature");
  expect(ok(["pr", "view", "2"], { cwd: dir })).toContain("feature/cli");
  ok(["pr", "merge", "2"], { cwd: dir });
  expect(JSON.parse(ok(["pr", "view", "2", "--json"], { cwd: dir })).pull.state).toBe("merged");
  gitOk(dir, ["fetch", "-q", "origin"]);
  expect(gitOk(dir, ["show", "origin/main:feature.txt"])).toBe("feature\n");

  // Raw API access for anything else.
  expect(JSON.parse(ok(["api", "/api/me"])).user.username).toBe(me.username);

  ok(["auth", "logout"]);
  expect(ether(["auth", "status"]).code).not.toBe(0);
});

test("the CLI drives drafts, reviews, stacks and squash merges, and prints shell completions", async () => {
  const admin = await loginAdmin();
  const me = await createUser(admin);
  const reviewer = await createUser(admin);
  const { ether, ok, gitOk } = runner(mkdtempSync(join(tmpdir(), "ether-cli-")));
  const other = runner(mkdtempSync(join(tmpdir(), "ether-cli-")));
  ok(["auth", "login", "--host", baseURL(), "--with-token"], { input: `${me.token}\n` });
  other.ok(["auth", "login", "--host", baseURL(), "--with-token"], { input: `${reviewer.token}\n` });

  expect(ok(["completion", "zsh"])).toContain("#compdef ether");
  expect(ok(["completion", "bash"])).toContain("_ether()");

  const repo = unique("cli-pr");
  const full = `${me.username}/${repo}`;
  ok(["repo", "create", repo]);
  await me.ctx.put(`/api/repos/${full}/collaborators/${reviewer.username}`, { data: { role: "write" }, headers: { Origin: baseURL() } });
  const work = mkdtempSync(join(tmpdir(), "ether-cli-work-"));
  ok(["repo", "clone", full, "w"], { cwd: work });
  const dir = join(work, "w");
  const commit = (file: string, msg: string) => {
    writeFileSync(join(dir, file), `${msg}\n`);
    gitOk(dir, ["add", "-A"]);
    gitOk(dir, ["commit", "-q", "-m", msg]);
  };
  commit("README.md", "first");
  gitOk(dir, ["branch", "-M", "main"]);
  gitOk(dir, ["push", "-q", "origin", "main"]);
  gitOk(dir, ["checkout", "-q", "-b", "lower"]);
  commit("a.txt", "lower one");
  commit("b.txt", "lower two");
  gitOk(dir, ["push", "-q", "origin", "lower"]);
  gitOk(dir, ["checkout", "-q", "-b", "upper"]);
  commit("c.txt", "upper");
  gitOk(dir, ["push", "-q", "origin", "upper"]);

  // A draft can't be merged until it's ready.
  expect(ok(["pr", "create", "--base", "main", "--head", "lower", "--title", "Lower", "--draft"], { cwd: dir })).toContain("Created draft pull request #1");
  expect(ok(["pr", "view", "1"], { cwd: dir })).toContain("Draft: mark it ready");
  const refused = ether(["pr", "merge", "1"], { cwd: dir });
  expect([refused.code, refused.err]).toEqual([1, expect.stringContaining("still a draft")]);
  ok(["pr", "ready", "1"], { cwd: dir });

  // Stack a second one on it; both see the stack.
  ok(["pr", "create", "--base", "lower", "--head", "upper", "--title", "Upper"], { cwd: dir });
  expect(ok(["pr", "view", "2"], { cwd: dir })).toContain("Stack: #1 → [#2]");

  // Ask for a review, and the reviewer approves from their own login.
  ok(["pr", "edit", "1", "--add-reviewer", reviewer.username], { cwd: dir });
  expect(ok(["pr", "view", "1"], { cwd: dir })).toContain(`${reviewer.username} (pending)`);
  other.ok(["pr", "review", "1", "-R", full, "--approve", "-b", "Looks good"]);
  expect(ok(["pr", "view", "1"], { cwd: dir })).toContain(`${reviewer.username} (approved)`);

  // Checks and diff.
  expect(ok(["pr", "checks", "1"], { cwd: dir })).toContain("No checks ran");
  expect(ok(["pr", "diff", "1", "--name-only"], { cwd: dir }).trim().split("\n")).toEqual(["a.txt", "b.txt"]);
  expect(ok(["pr", "diff", "2"], { cwd: dir })).toContain("+++ b/c.txt");

  // Squash with a subject and delete the branch: the upper one moves to main and is rebuilt on the squash.
  const merged = ok(["pr", "merge", "1", "--squash", "--delete-branch", "--subject", "Lower, squashed (#1)"], { cwd: dir });
  expect(merged).toContain("Squashed and merged #1");
  expect(merged).toContain("Moved onto its base: #2");
  expect(merged).toContain("Rebuilt on the new commits: #2");
  gitOk(dir, ["fetch", "-q", "--prune", "origin"]);
  expect(gitOk(dir, ["log", "--format=%s", "origin/main"]).trim().split("\n")).toEqual(["Lower, squashed (#1)", "first"]);
  const upper = JSON.parse(ok(["pr", "view", "2", "--json"], { cwd: dir }));
  expect([upper.pull.base, upper.commits.map((c: { subject: string }) => c.subject)]).toEqual(["main", ["upper"]]);
  expect(ok(["pr", "view", "1"], { cwd: dir })).toContain(`Squashed and merged by ${me.username}`);

  // Edit the base, and nothing to edit is an error.
  gitOk(dir, ["push", "-q", "origin", "main:release"]);
  ok(["pr", "edit", "2", "--base", "release", "--title", "Upper, retitled"], { cwd: dir });
  expect(JSON.parse(ok(["pr", "view", "2", "--json"], { cwd: dir })).pull).toMatchObject({ base: "release", title: "Upper, retitled" });
  expect(ether(["pr", "edit", "2"], { cwd: dir }).code).toBe(1);
});
