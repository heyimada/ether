// Building blocks for driving a verification instance started by launch.sh.
// Ad-hoc scripts outside the repo import everything, Playwright included, from this file by
// absolute path: bare imports resolve from the importing file, and only the repo has node_modules.
import { chromium, request, type APIRequestContext, type Browser, type Page } from "@playwright/test";
export { chromium, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../../..");

export type RunState = {
  RUN_DIR: string;
  EVIDENCE_DIR: string;
  ETHER_URL: string;
  ETHER_SSH_PORT: string;
  ETHER_DATA: string;
  ADMIN_USER: string;
  ADMIN_PASSWORD: string;
};

// ETHER_VERIFY_RUN=<run dir> picks a run; otherwise the newest one.
export function loadRun(): RunState {
  const dir = process.env.ETHER_VERIFY_RUN ?? join(ROOT, "e2e-report/verify/latest");
  const file = join(dir, "state.env");
  if (!existsSync(file)) throw new Error(`No ${file}. Run .claude/skills/verify-ether/scripts/launch.sh first.`);
  const state = Object.fromEntries(
    readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  if (readFileSync(file, "utf8").includes("STOPPED_AT=")) throw new Error(`${dir} was cleaned up; launch a new run.`);
  return state as RunState;
}

let counter = 0;
export const unique = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${counter++}`;

// One evidence folder per feature: numbered screenshots + ARIA snapshots, a transcript, side-effect dumps.
export function evidence(run: RunState, feature: string) {
  const dir = join(run.EVIDENCE_DIR, feature);
  mkdirSync(dir, { recursive: true });
  let step = 0;
  const log = (line: string) => appendFileSync(join(dir, "transcript.txt"), `${new Date().toISOString()} ${line}\n`);
  return {
    dir,
    log,
    // Call before and after each user action, so the proof shows the action and its result.
    async shot(page: Page, name: string) {
      const base = join(dir, `${String(++step).padStart(2, "0")}-${name}`);
      await page.screenshot({ path: `${base}.png`, fullPage: true });
      writeFileSync(`${base}.aria.txt`, `${page.url()}\n\n${await page.locator("body").ariaSnapshot()}\n`);
      log(`shot ${base}.png  (${page.url()})`);
    },
    write(name: string, body: string) {
      writeFileSync(join(dir, name), body);
      log(`wrote ${name}`);
    },
  };
}

export async function browser(): Promise<Browser> {
  return chromium.launch({ headless: process.env.HEADED !== "1" });
}

export async function newPage(b: Browser, run: RunState): Promise<Page> {
  const ctx = await b.newContext({ baseURL: run.ETHER_URL, viewport: { width: 1280, height: 900 } });
  return ctx.newPage();
}

// The same sign-in a person does on /login; resolves once the dashboard shows "New repository".
export async function uiLogin(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "New repository" }).waitFor();
}

// A signed-in API session. Use it for setup and for read-only second views of state,
// never as a substitute for the UI step being verified.
export async function api(run: RunState, username = run.ADMIN_USER, password = run.ADMIN_PASSWORD): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL: run.ETHER_URL, extraHTTPHeaders: { Origin: run.ETHER_URL } });
  const res = await ctx.post("/api/auth/sign-in/username", { data: { username, password } });
  if (!res.ok()) throw new Error(`sign-in ${username} failed: ${res.status()} ${await res.text()}`);
  return ctx;
}

export async function json(res: Awaited<ReturnType<APIRequestContext["get"]>>) {
  if (!res.ok()) throw new Error(`${res.url()} -> ${res.status()} ${await res.text()}`);
  return res.json();
}

export async function createToken(ctx: APIRequestContext) {
  return (await json(await ctx.post("/api/tokens", { data: { name: unique("verify") } }))).token as string;
}

// Invite + register through the API, for features that need a second person.
export async function createUser(run: RunState, admin: APIRequestContext, username = unique("user")) {
  const password = "friend-password-1";
  const { code } = await json(await admin.post("/api/invites", { data: {} }));
  const anon = await request.newContext({ baseURL: run.ETHER_URL, extraHTTPHeaders: { Origin: run.ETHER_URL } });
  await json(await anon.post("/api/register", { data: { code, username, password } }));
  return { username, password };
}

export const cloneUrl = (run: RunState, owner: string, repo: string) => `${run.ETHER_URL}/${owner}/${repo}.git`;
export const workdir = () => mkdtempSync(join(tmpdir(), "ether-verify-wd-"));

// A private (0700) directory per process, so no other local user can plant config in it.
let emptyConfig: string | undefined;
function emptyGitConfig() {
  if (!emptyConfig) {
    emptyConfig = join(mkdtempSync(join(tmpdir(), "ether-verify-git-")), "empty.gitconfig");
    writeFileSync(emptyConfig, "", { mode: 0o600 });
  }
  return emptyConfig;
}

// git with no global/system config and no credential helper: a token can never reach the
// macOS Keychain or Git Credential Manager. Auth goes in an explicit header, passed through
// the environment so it never shows up in `ps`.
export function git(cwd: string, args: string[], auth?: { username: string; token: string }, log?: (l: string) => void) {
  const pre = ["-c", "credential.helper=", "-c", "user.name=Verify", "-c", "user.email=verify@ether.test", "-c", "init.defaultBranch=main"];
  const header: Record<string, string> = auth
    ? {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${auth.username}:${auth.token}`).toString("base64")}`,
      }
    : { GIT_CONFIG_COUNT: "0" };
  const r = spawnSync("git", [...pre, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: emptyGitConfig(), GCM_INTERACTIVE: "never", ...header },
  });
  log?.(`$ git ${args.join(" ")}  -> exit ${r.status}\n${r.stdout}${r.stderr}`);
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

export function gitOk(...a: Parameters<typeof git>) {
  const r = git(...a);
  if (r.code !== 0) throw new Error(`git ${a[1].join(" ")} failed (${r.code}): ${r.stderr}`);
  return r.stdout;
}

// Read-only look at the bare repository the server wrote, the side effect behind a push or merge.
export function bareGit(run: RunState, owner: string, repo: string, args: string[]) {
  const dir = join(run.ETHER_DATA, "repos", owner.toLowerCase(), `${repo.toLowerCase()}.git`);
  const r = spawnSync("git", ["--git-dir", dir, ...args], { encoding: "utf8" });
  return `$ git --git-dir ${dir} ${args.join(" ")}  -> exit ${r.status}\n${r.stdout}${r.stderr}`;
}
