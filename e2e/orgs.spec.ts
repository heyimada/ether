import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseURL, cloneUrl, createRepo, createUser, git, gitOk, login, loginAdmin, uiLogin, unique, workdir } from "./helpers";

const headers = () => ({ Origin: baseURL() });

function seed(owner: string, repo: string, auth: { username: string; token: string }) {
  const src = workdir();
  gitOk(src, ["init", "-q"]);
  writeFileSync(join(src, "README.md"), `# ${repo}\n`);
  gitOk(src, ["add", "-A"]);
  gitOk(src, ["commit", "-q", "-m", "seed"]);
  gitOk(src, ["push", "-q", cloneUrl(owner, repo), "main"], auth);
}

// Tries to push one new commit as `who`; returns git's exit code.
function tryPush(owner: string, repo: string, who: { username: string; token: string }) {
  const dir = workdir();
  const clone = git(dir, ["clone", "-q", cloneUrl(owner, repo), "w"], who);
  if (clone.code !== 0) return { code: clone.code, stage: "clone" as const };
  writeFileSync(join(dir, "w", `${unique("f")}.txt`), "x\n");
  gitOk(join(dir, "w"), ["add", "-A"]);
  gitOk(join(dir, "w"), ["commit", "-q", "-m", "change"]);
  return { code: git(join(dir, "w"), ["push", "-q", "origin", "main"], who).code, stage: "push" as const };
}

test("public repositories are readable by everyone with an account, writable only by collaborators", async ({ page }, info) => {
  const admin = await loginAdmin();
  const owner = await createUser(admin);
  const stranger = await createUser(admin);

  // Created public through the UI, which explains what public means.
  await uiLogin(page, owner.username, owner.password);
  await page.getByRole("main").getByRole("link", { name: "New repository" }).click();
  const name = unique("open");
  await page.getByLabel("Repository name").fill(name);
  await page.getByRole("radio", { name: /Public/ }).check();
  await info.attach("new-public-repo", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  await page.getByRole("button", { name: "Create repository" }).click();
  await expect(page).toHaveURL(`${baseURL()}/${owner.username}/${name}`);
  await expect(page.getByText("Public", { exact: true }).first()).toBeVisible();
  seed(owner.username, name, { username: owner.username, token: owner.token });

  // Someone with no relation to it can read, clone and open issues, but not push.
  expect((await stranger.ctx.get(`/api/repos/${owner.username}/${name}`)).ok()).toBe(true);
  expect((await stranger.ctx.post(`/api/repos/${owner.username}/${name}/issues`, { data: { title: "From a reader", body: "" }, headers: headers() })).ok()).toBe(true);
  const push = tryPush(owner.username, name, { username: stranger.username, token: stranger.token });
  expect(push.stage).toBe("push");
  expect(push.code).not.toBe(0);

  // It is listed for them as public, not as shared with them.
  const listed = (await (await stranger.ctx.get("/api/repos")).json()).repos.find((r: { name: string }) => r.name === name);
  expect(listed.relation).toBe("public");
  await uiLogin(page, stranger.username, stranger.password);
  await expect(page.getByRole("region", { name: "Shared with you" })).not.toContainText(name);
  await expect(page.getByRole("region", { name: "Public repositories" })).toContainText(name);

  // Making it private again hides it from them everywhere.
  expect((await owner.ctx.patch(`/api/repos/${owner.username}/${name}`, { data: { visibility: "private" }, headers: headers() })).ok()).toBe(true);
  expect((await stranger.ctx.get(`/api/repos/${owner.username}/${name}`)).status()).toBe(404);
  expect(JSON.stringify(await (await stranger.ctx.get(`/api/users/${owner.username}/profile`)).json())).not.toContain(name);
  expect(tryPush(owner.username, name, { username: stranger.username, token: stranger.token }).stage).toBe("clone");

  // Only the owner may change visibility.
  expect((await stranger.ctx.patch(`/api/repos/${owner.username}/${name}`, { data: { visibility: "public" }, headers: headers() })).status()).toBe(404);
});

test("organizations own repositories; members get the base permission, others get nothing", async ({ page }, info) => {
  const admin = await loginAdmin();
  const founder = await createUser(admin);
  const member = await createUser(admin);
  const outsider = await createUser(admin);
  const org = unique("acme").slice(0, 30);

  await uiLogin(page, founder.username, founder.password);
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "New organization" }).click();
  await page.getByLabel("Organization name").fill(org);
  await page.getByLabel("Display name").fill("Acme Tools");
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page).toHaveURL(`${baseURL()}/${org}`);
  await expect(page.getByRole("heading", { name: "Acme Tools" })).toBeVisible();

  // Names are shared with people: neither a user nor another org can take it.
  expect((await outsider.ctx.post("/api/orgs", { data: { name: org }, headers: headers() })).status()).toBe(409);
  expect((await outsider.ctx.post("/api/orgs", { data: { name: member.username }, headers: headers() })).status()).toBe(409);

  // Add a member through the org settings page.
  await page.goto(`${baseURL()}/organizations/${org}/settings`);
  await page.getByLabel("Username").fill(member.username);
  await page.getByRole("button", { name: "Add member" }).click();
  await expect(page.getByRole("list", { name: "Members" })).toContainText(member.username);
  await info.attach("org-settings", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

  // Org owners create repositories in the org.
  const repo = unique("tool");
  expect((await founder.ctx.post("/api/repos", { data: { name: repo, owner: org }, headers: headers() })).ok()).toBe(true);
  seed(org, repo, { username: founder.username, token: founder.token });
  // Plain members cannot create repositories in it.
  expect((await member.ctx.post("/api/repos", { data: { name: unique("nope"), owner: org }, headers: headers() })).status()).toBe(403);

  // Base permission read: clone yes, push no.
  let push = tryPush(org, repo, { username: member.username, token: member.token });
  expect(push.stage).toBe("push");
  expect(push.code).not.toBe(0);
  // Base permission write: push works.
  expect((await founder.ctx.patch(`/api/orgs/${org}`, { data: { basePermission: "write" }, headers: headers() })).ok()).toBe(true);
  push = tryPush(org, repo, { username: member.username, token: member.token });
  expect(push).toEqual({ code: 0, stage: "push" });

  // A collaborator role higher than the base permission wins.
  expect((await founder.ctx.patch(`/api/orgs/${org}`, { data: { basePermission: "read" }, headers: headers() })).ok()).toBe(true);
  await founder.ctx.put(`/api/repos/${org}/${repo}/collaborators/${member.username}`, { data: { role: "write" }, headers: headers() });
  expect(tryPush(org, repo, { username: member.username, token: member.token }).code).toBe(0);

  // Outsiders see nothing.
  expect((await outsider.ctx.get(`/api/repos/${org}/${repo}`)).status()).toBe(404);
  expect(tryPush(org, repo, { username: outsider.username, token: outsider.token }).stage).toBe("clone");

  // The member sees the repo grouped under the org on their dashboard.
  await page.context().clearCookies();
  await uiLogin(page, member.username, member.password);
  await expect(page.getByRole("region", { name: org })).toContainText(repo);

  // The last owner cannot leave or be demoted; removed members lose access.
  expect((await founder.ctx.delete(`/api/orgs/${org}/members/${founder.username}`, { headers: headers() })).status()).toBe(400);
  expect((await founder.ctx.put(`/api/orgs/${org}/members/${founder.username}`, { data: { role: "member" }, headers: headers() })).status()).toBe(400);
  await founder.ctx.delete(`/api/repos/${org}/${repo}/collaborators/${member.username}`, { headers: headers() });
  expect((await founder.ctx.delete(`/api/orgs/${org}/members/${member.username}`, { headers: headers() })).ok()).toBe(true);
  expect((await member.ctx.get(`/api/repos/${org}/${repo}`)).status()).toBe(404);
});

test("an organization is never an account anyone can sign in as", async () => {
  const admin = await loginAdmin();
  const founder = await createUser(admin);
  const org = unique("guild").slice(0, 30);
  expect((await founder.ctx.post("/api/orgs", { data: { name: org }, headers: headers() })).ok()).toBe(true);

  const cli = spawnSync("bun", ["src/server/cli.ts", "reset-password", org, "--password", "an-org-password-1"], {
    env: { ...process.env, ETHER_DATA: process.env.ETHER_DATA! },
    encoding: "utf8",
  });
  expect(cli.status).not.toBe(0);
  await expect(login(org, "an-org-password-1")).rejects.toThrow();
  // Orgs cannot be collaborators or members either.
  const repo = await createRepo(founder.ctx);
  expect((await founder.ctx.put(`/api/repos/${founder.username}/${repo}/collaborators/${org}`, { data: { role: "read" }, headers: headers() })).status()).toBe(400);
});
