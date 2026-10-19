import { request, type APIRequestContext, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADMIN } from "./global-setup";

export { ADMIN };
export const baseURL = () => process.env.ETHER_URL!;

let counter = 0;
export const unique = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${counter++}`;

export async function login(username: string, password: string): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL: baseURL() });
  const res = await ctx.post("/api/auth/sign-in/username", { data: { username, password } });
  if (!res.ok()) throw new Error(`login ${username} failed: ${res.status()} ${await res.text()}`);
  return ctx;
}

export const loginAdmin = () => login(ADMIN.username, ADMIN.password);

export async function inviteCode(admin: APIRequestContext): Promise<string> {
  const res = await admin.post("/api/invites", { data: {} });
  if (!res.ok()) throw new Error(`invite failed: ${res.status()}`);
  return (await res.json()).code;
}

export async function createUser(admin: APIRequestContext, username = unique("user")) {
  const password = "friend-password-1";
  const anon = await request.newContext({ baseURL: baseURL() });
  const res = await anon.post("/api/register", { data: { code: await inviteCode(admin), username, password } });
  if (!res.ok()) throw new Error(`register failed: ${res.status()} ${await res.text()}`);
  const ctx = await login(username, password);
  return { username, password, ctx, token: await createToken(ctx) };
}

export async function createToken(ctx: APIRequestContext): Promise<string> {
  const res = await ctx.post("/api/tokens", { data: { name: unique("token") } });
  if (!res.ok()) throw new Error(`token failed: ${res.status()}`);
  return (await res.json()).token;
}

export async function createRepo(ctx: APIRequestContext, name = unique("repo")) {
  const res = await ctx.post("/api/repos", { data: { name, description: "e2e repo" } });
  if (!res.ok()) throw new Error(`create repo failed: ${res.status()} ${await res.text()}`);
  return name;
}

export const cloneUrl = (owner: string, repo: string) => `${baseURL()}/${owner}/${repo}.git`;

export const workdir = () => mkdtempSync(join(tmpdir(), "ether-wd-"));

// Runs the real git CLI with no system/global config so Git Credential Manager can never
// prompt or persist anything; credentials go in an explicit Authorization header instead.
export function git(cwd: string, args: string[], auth?: { username: string; token: string }, env: Record<string, string> = {}) {
  const emptyConfig = join(tmpdir(), "ether-e2e-empty.gitconfig");
  writeFileSync(emptyConfig, "");
  const pre = ["-c", "credential.helper=", "-c", "user.name=E2E", "-c", "user.email=e2e@ether.test", "-c", "init.defaultBranch=main"];
  if (auth) {
    const basic = Buffer.from(`${auth.username}:${auth.token}`).toString("base64");
    pre.push("-c", `http.extraHeader=Authorization: Basic ${basic}`);
  }
  const res = spawnSync("git", [...pre, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: emptyConfig, GCM_INTERACTIVE: "never", ...env },
  });
  return { code: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

export function gitOk(cwd: string, args: string[], auth?: { username: string; token: string }, env?: Record<string, string>) {
  const res = git(cwd, args, auth, env);
  if (res.code !== 0) throw new Error(`git ${args.join(" ")} failed (${res.code}):\n${res.stderr}`);
  return res.stdout;
}

export async function uiLogin(page: Page, username: string, password: string) {
  await page.goto(`${baseURL()}/login`);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "New repository" }).waitFor();
}
