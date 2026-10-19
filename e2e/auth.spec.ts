import { expect, request, test } from "@playwright/test";
import { baseURL, createRepo, createUser, inviteCode, login, loginAdmin, unique } from "./helpers";

test("registration requires a valid invite that can be used only once", async () => {
  const admin = await loginAdmin();
  const anon = await request.newContext({ baseURL: baseURL() });
  const password = "long-enough-password";

  const bogus = await anon.post("/api/register", { data: { code: "not-a-real-invite", username: unique("mallory"), password } });
  expect(bogus.ok()).toBe(false);

  const missing = await anon.post("/api/register", { data: { username: unique("mallory"), password } });
  expect(missing.ok()).toBe(false);

  const code = await inviteCode(admin);
  const friend = unique("friend");
  const first = await anon.post("/api/register", { data: { code, username: friend, password } });
  expect(first.status()).toBe(200);

  const reuse = await anon.post("/api/register", { data: { code, username: unique("second"), password } });
  expect(reuse.ok()).toBe(false);

  const ctx = await login(friend, password);
  const me = await (await ctx.get("/api/me")).json();
  expect(me.user.username).toBe(friend);
  expect(me.user.isAdmin).toBe(false);
});

test("anonymous visitors cannot see anything", async () => {
  const admin = await loginAdmin();
  const repo = await createRepo(admin);
  const anon = await request.newContext({ baseURL: baseURL() });

  expect((await anon.get("/api/repos")).status()).toBe(401);
  expect((await anon.get(`/api/repos/admin/${repo}`)).status()).toBe(401);
  expect((await anon.get(`/api/repos/admin/${repo}/issues`)).status()).toBe(401);
  expect((await anon.get("/api/users")).status()).toBe(401);
});

test("wrong password is rejected", async () => {
  const anon = await request.newContext({ baseURL: baseURL() });
  const res = await anon.post("/api/auth/sign-in/username", { data: { username: "admin", password: "wrong-password" } });
  expect(res.status()).toBe(401);
});

test("cross-origin mutations are rejected even with a valid session", async () => {
  const admin = await loginAdmin();
  const res = await admin.post("/api/repos", {
    data: { name: unique("csrf") },
    headers: { Origin: "https://evil.example" },
  });
  expect(res.status()).toBe(403);
});

test("only admins can invite people", async () => {
  const admin = await loginAdmin();
  const friend = await createUser(admin);
  expect((await friend.ctx.post("/api/invites", { data: {} })).status()).toBe(403);
});

test("users cannot see repositories they are not collaborators on", async () => {
  const admin = await loginAdmin();
  const repo = await createRepo(admin);
  const friend = await createUser(admin);

  expect((await friend.ctx.get(`/api/repos/admin/${repo}`)).status()).toBe(404);
  const listed = (await (await friend.ctx.get("/api/repos")).json()).repos.map((r: { name: string }) => r.name);
  expect(listed).not.toContain(repo);

  await admin.put(`/api/repos/admin/${repo}/collaborators/${friend.username}`, { data: { role: "read" } });
  expect((await friend.ctx.get(`/api/repos/admin/${repo}`)).status()).toBe(200);
  const listedAfter = (await (await friend.ctx.get("/api/repos")).json()).repos.map((r: { name: string }) => r.name);
  expect(listedAfter).toContain(repo);
});

test("logging out invalidates the session", async () => {
  const ctx = await loginAdmin();
  expect((await ctx.get("/api/repos")).status()).toBe(200);
  // Browsers always send Origin on POST; Better Auth refuses cookie-bearing POSTs without it.
  const out = await ctx.post("/api/auth/sign-out", { data: {}, headers: { Origin: baseURL() } });
  expect(out.status()).toBe(200);
  expect((await ctx.get("/api/repos")).status()).toBe(401);
});

test("an operator can reset a forgotten password from the CLI, which signs the user out everywhere", async () => {
  const { spawnSync } = await import("node:child_process");
  const { createUser, loginAdmin, login } = await import("./helpers");
  const cli = (...args: string[]) =>
    spawnSync("bun", ["src/server/cli.ts", ...args], { env: { ...process.env, ETHER_DATA: process.env.ETHER_DATA! }, encoding: "utf8" });

  const admin = await loginAdmin();
  const friend = await createUser(admin);
  expect((await friend.ctx.get("/api/me")).ok()).toBe(true);

  expect(cli("reset-password", friend.username, "--password", "short").status).not.toBe(0);
  expect(cli("reset-password", "nobody-by-this-name", "--password", "a-long-enough-password").status).not.toBe(0);

  const reset = cli("reset-password", friend.username, "--password", "a-brand-new-password");
  expect(reset.status, reset.stderr).toBe(0);

  expect((await friend.ctx.get("/api/me")).status()).toBe(401);
  await expect(login(friend.username, friend.password)).rejects.toThrow();
  const fresh = await login(friend.username, "a-brand-new-password");
  expect((await (await fresh.get("/api/me")).json()).user.username).toBe(friend.username);
});
