import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
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

  // Even the owner can't push to main directly or delete it.
  commit(src, "b.txt", "b\n");
  const direct = git(src, ["push", "-q", url, "main"], auth);
  expect(direct.code).not.toBe(0);
  expect(direct.stderr).toContain("main is protected: changes have to go through a pull request");
  const deleted = git(src, ["push", "-q", url, ":main"], auth);
  expect(deleted.code).not.toBe(0);
  expect(deleted.stderr).toContain("main is protected and can't be deleted");

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
  expect(git(src, ["push", "-q", url, ":release/1.0"], auth).code).not.toBe(0);
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
  await page.getByRole("list", { name: "Protected branches" }).getByRole("button", { name: "Remove rule main" }).click();
  await expect(page.getByRole("list", { name: "Protected branches" })).not.toContainText(/^main/);
  gitOk(src, ["fetch", "-q", url, "main"], auth);
  gitOk(src, ["checkout", "-q", "-B", "direct", "FETCH_HEAD"]);
  commit(src, "d.txt", "d\n");
  gitOk(src, ["push", "-q", url, "direct:main"], auth);
});
