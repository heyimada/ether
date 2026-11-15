import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { chmodSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseURL, cloneUrl, createRepo, createToken, createUser, git, gitOk, loginAdmin, sshIdentity, sshUrl, uiLogin, unique, workdir } from "./helpers";

const headers = () => ({ Origin: baseURL() });

function commit(dir: string, file: string, body: string) {
  writeFileSync(join(dir, file), body);
  gitOk(dir, ["add", "-A"]);
  gitOk(dir, ["commit", "-q", "-m", `${file}: ${body.trim()}`]);
}

test("protected branches refuse direct, force and deleting pushes, but pull requests still merge", async ({ page }, info) => {
  const admin = await loginAdmin();
  const owner = await createUser(admin);
  const writer = await createUser(admin);
  const auth = { username: owner.username, token: await createToken(owner.ctx) };
  const repo = await createRepo(owner.ctx, unique("protect"));
  const url = cloneUrl(owner.username, repo);
  await owner.ctx.put(`/api/repos/${owner.username}/${repo}/collaborators/${writer.username}`, { data: { role: "write" }, headers: headers() });

  const src = workdir();
  gitOk(src, ["init", "-q"]);
  commit(src, "a.txt", "a\n");
  gitOk(src, ["branch", "feature"]);
  gitOk(src, ["branch", "release/1.0"]);
  gitOk(src, ["push", "-q", url, "main", "feature", "release/1.0"], auth);

  // The owner protects main in Settings: pull requests only, no force pushes, no deletion.
  await uiLogin(page, owner.username, owner.password);
  await page.goto(`${baseURL()}/${owner.username}/${repo}/settings`);
  await expect(page.getByLabel("Branch name or pattern")).toHaveValue("main");
  await page.getByRole("button", { name: "Protect branch" }).click();
  const list = page.getByRole("list", { name: "Protected branches" });
  await expect(list).toContainText("main");
  await expect(list).toContainText("pull requests only · no force pushes · can't be deleted");
  await info.attach("protected-branches", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

  // Even the owner can't push to main directly. (git itself refuses deleting the default branch.)
  commit(src, "b.txt", "b\n");
  const direct = git(src, ["push", "-q", url, "main"], auth);
  expect(direct.code).not.toBe(0);
  expect(direct.stderr).toContain("main is protected: changes have to go through a pull request");

  // Unprotected branches are untouched, and a pull request into main merges.
  gitOk(src, ["push", "-q", "--force", url, "main:feature"], auth);
  const created = await owner.ctx.post(`/api/repos/${owner.username}/${repo}/pulls`, { data: { title: "b", body: "", base: "main", head: "feature" }, headers: headers() });
  const { number } = (await created.json()).pull;
  const merged = await owner.ctx.post(`/api/repos/${owner.username}/${repo}/pulls/${number}/merge`, { data: {}, headers: headers() });
  expect(merged.ok(), await merged.text()).toBe(true);
  const tree = await (await owner.ctx.get(`/api/repos/${owner.username}/${repo}/tree?ref=main`)).json();
  expect(tree.entries.map((e: { name: string }) => e.name)).toContain("b.txt");

  // A pattern rule that allows direct pushes still blocks force pushes and deletion; creating a branch is fine.
  expect((await owner.ctx.post(`/api/repos/${owner.username}/${repo}/branch-protection`, { data: { pattern: "release/*" }, headers: headers() })).ok()).toBe(true);
  gitOk(src, ["fetch", "-q", url, "main"], auth);
  gitOk(src, ["push", "-q", url, "FETCH_HEAD:refs/heads/release/1.0"], auth);
  gitOk(src, ["checkout", "-q", "-b", "rewrite", "FETCH_HEAD~1"]);
  commit(src, "c.txt", "c\n");
  const forced = git(src, ["push", "-q", "--force", url, "rewrite:release/1.0"], auth);
  expect(forced.code).not.toBe(0);
  expect(forced.stderr).toContain("release/1.0 is protected: force pushes aren't allowed");
  const deleted = git(src, ["push", "-q", url, ":release/1.0"], auth);
  expect(deleted.code).not.toBe(0);
  expect(deleted.stderr).toContain("release/1.0 is protected and can't be deleted");
  gitOk(src, ["push", "-q", url, "rewrite:release/2.0"], auth);
  // * stays within one path segment.
  gitOk(src, ["push", "-q", url, "rewrite:release/next/hotfix"], auth);
  gitOk(src, ["push", "-q", "--force", url, "main:release/next/hotfix"], auth);

  // The same rules hold over SSH.
  const key = sshIdentity();
  await owner.ctx.post("/api/me/ssh-keys", { data: { title: "k", key: key.publicKey }, headers: headers() });
  const viaSsh = key.git(src, ["push", "-q", "--force", sshUrl(owner.username, repo), "rewrite:main"]);
  expect(viaSsh.code).not.toBe(0);
  expect(viaSsh.err).toContain("main is protected");

  // Only owners manage rules, and patterns are checked.
  expect((await writer.ctx.get(`/api/repos/${owner.username}/${repo}/branch-protection`)).status()).toBe(403);
  expect((await writer.ctx.post(`/api/repos/${owner.username}/${repo}/branch-protection`, { data: { pattern: "dev" }, headers: headers() })).status()).toBe(403);
  expect((await owner.ctx.post(`/api/repos/${owner.username}/${repo}/branch-protection`, { data: { pattern: "release/*" }, headers: headers() })).status()).toBe(409);
  expect((await owner.ctx.post(`/api/repos/${owner.username}/${repo}/branch-protection`, { data: { pattern: "refs/heads/x" }, headers: headers() })).status()).toBe(400);
  expect((await owner.ctx.post(`/api/repos/${owner.username}/${repo}/branch-protection`, { data: { pattern: "a b" }, headers: headers() })).status()).toBe(400);

  // Removing the rule lets direct pushes through again.
  await page.reload();
  await page.getByRole("button", { name: "Remove rule main" }).click();
  await page.getByRole("alertdialog", { name: "Confirm removing rule main" }).getByRole("button", { name: "Remove protection" }).click();
  await expect(page.getByRole("listitem", { name: "Rule main" })).toHaveCount(0);
  await expect(page.getByRole("listitem", { name: "Rule release/*" })).toBeVisible();
  gitOk(src, ["fetch", "-q", url, "main"], auth);
  gitOk(src, ["checkout", "-q", "-B", "direct", "FETCH_HEAD"]);
  commit(src, "d.txt", "d\n");
  gitOk(src, ["push", "-q", url, "direct:main"], auth);
});

// The bare repository on the server's disk, for what only the server side can do (gc, inspection).
const bare = (owner: string, repo: string) => join(process.env.ETHER_DATA!, "repos", owner.toLowerCase(), `${repo.toLowerCase()}.git`);
const serverSha = (owner: string, repo: string, ref: string) => spawnSync("git", ["-C", bare(owner, repo), "rev-parse", ref], { encoding: "utf8" }).stdout.trim();

async function protectedRepo(prefix: string) {
  const admin = await loginAdmin();
  const owner = await createUser(admin);
  const auth = { username: owner.username, token: await createToken(owner.ctx) };
  const repo = await createRepo(owner.ctx, unique(prefix));
  const api = `/api/repos/${owner.username}/${repo}/branch-protection`;
  const protect = async (data: Record<string, unknown>) => expect((await owner.ctx.post(api, { data, headers: headers() })).ok()).toBe(true);
  return { owner, auth, repo, url: cloneUrl(owner.username, repo), api, protect };
}

test("protection holds against case tricks and re-created branches, and checks each ref on its own", async ({ page }) => {
  const { owner, auth, repo, url, api, protect } = await protectedRepo("tricks");
  // A rule set before the first push doesn't block that push, even though it requires pull requests and allows deletion.
  await protect({ pattern: "stable", requirePullRequest: true, allowDeletion: true });
  const src = workdir();
  gitOk(src, ["init", "-q"]);
  commit(src, "a.txt", "a\n");
  gitOk(src, ["push", "-q", url, "main", "main:stable", "main:keep"], auth);
  const good = serverSha(owner.username, repo, "refs/heads/stable");

  // With stable packed, as git gc leaves it, STABLE would be written over stable on a case-insensitive disk.
  spawnSync("git", ["-C", bare(owner.username, repo), "pack-refs", "--all"]);
  gitOk(src, ["checkout", "-q", "--orphan", "evil"]);
  commit(src, "evil.txt", "evil\n");
  const cased = git(src, ["push", "-q", url, "evil:refs/heads/STABLE"], auth);
  expect(cased.code).not.toBe(0);
  expect(cased.stderr).toContain("STABLE differs from the existing branch stable only in case");
  expect(serverSha(owner.username, repo, "refs/heads/stable")).toBe(good);

  // Deleting is allowed, but bringing the branch back by a push would skip pull requests.
  gitOk(src, ["push", "-q", url, ":stable"], auth);
  const back = git(src, ["push", "-q", url, "evil:stable"], auth);
  expect(back.code).not.toBe(0);
  expect(back.stderr).toContain("stable is protected: it requires pull requests and may be deleted, so it can't be created by a push");
  // Nor under another spelling, which a case-insensitive disk would store as stable.
  const recased = git(src, ["push", "-q", url, "evil:refs/heads/STABLE"], auth);
  expect(recased.code).not.toBe(0);
  expect(recased.stderr).toContain("STABLE is protected: it requires pull requests and may be deleted, so it can't be created by a push");
  expect(serverSha(owner.username, repo, "refs/heads/stable")).not.toBe(gitOk(src, ["rev-parse", "evil"]).trim());

  // One refused ref doesn't hold back the others in the same push.
  await protect({ pattern: "keep", requirePullRequest: true });
  const mixed = git(src, ["push", "-q", "--force", url, "evil:keep", "evil:feature"], auth);
  expect(mixed.code).not.toBe(0);
  expect(mixed.stderr).toContain("keep is protected: changes have to go through a pull request");
  expect(serverSha(owner.username, repo, "refs/heads/feature")).toBe(gitOk(src, ["rev-parse", "evil"]).trim());
  expect(serverSha(owner.username, repo, "refs/heads/keep")).toBe(good);

  // Editing a rule in Settings changes it in place.
  await uiLogin(page, owner.username, owner.password);
  await page.goto(`${baseURL()}/${owner.username}/${repo}/settings`);
  const row = page.getByRole("listitem", { name: "Rule keep" });
  await expect(row).toContainText("pull requests only · no force pushes · can't be deleted");
  await page.getByRole("button", { name: "Edit rule keep" }).click();
  await row.getByLabel("Require a pull request: no direct pushes").uncheck();
  await row.getByLabel("Allow force pushes").check();
  await row.getByRole("button", { name: "Save rule" }).click();
  await expect(row).toContainText("direct pushes allowed · force pushes allowed · can't be deleted");
  gitOk(src, ["push", "-q", "--force", url, "evil:keep"], auth);

  // Unknown and malformed rule ids, and empty edits, are errors.
  expect((await owner.ctx.delete(`${api}/abc`, { headers: headers() })).status()).toBe(400);
  expect((await owner.ctx.delete(`${api}/999999`, { headers: headers() })).status()).toBe(404);
  expect((await owner.ctx.patch(`${api}/999999`, { data: { allowDeletion: true }, headers: headers() })).status()).toBe(404);
  const { rules } = await (await owner.ctx.get(api)).json();
  expect((await owner.ctx.patch(`${api}/${rules[0].id}`, { data: {}, headers: headers() })).status()).toBe(400);
});

test("a tampered or unusable hook refuses protected pushes instead of skipping the check", async () => {
  const { auth, url, protect } = await protectedRepo("hook");
  const src = workdir();
  gitOk(src, ["init", "-q"]);
  commit(src, "a.txt", "a\n");
  gitOk(src, ["push", "-q", url, "main"], auth);
  await protect({ pattern: "main", requirePullRequest: true });
  commit(src, "b.txt", "b\n");
  expect(git(src, ["push", "-q", url, "main"], auth).code).not.toBe(0);

  // A hook that lost its execute bit, or was replaced, is restored before the next push.
  const hooks = join(process.env.ETHER_DATA!, "hooks");
  const hook = join(hooks, "update");
  chmodSync(hook, 0o644);
  expect(git(src, ["push", "-q", url, "main"], auth).stderr).toContain("main is protected");
  writeFileSync(hook, "#!/bin/sh\nexit 0\n");
  expect(git(src, ["push", "-q", url, "main"], auth).stderr).toContain("main is protected");
  expect(statSync(hook).mode & 0o111).not.toBe(0);

  // When the hook can't be put in place at all, the push is refused rather than let through.
  renameSync(hooks, `${hooks}.away`);
  writeFileSync(hooks, "not a folder");
  try {
    const refused = git(src, ["push", "-q", url, "main"], auth);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("Branch protection can't run on this server right now");
  } finally {
    rmSync(hooks);
    renameSync(`${hooks}.away`, hooks);
  }
  expect(git(src, ["push", "-q", url, "main"], auth).stderr).toContain("main is protected");
});
