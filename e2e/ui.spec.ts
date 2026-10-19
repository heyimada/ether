import { expect, test } from "@playwright/test";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ADMIN, baseURL, cloneUrl, createRepo, createToken, gitOk, loginAdmin, uiLogin, unique, workdir } from "./helpers";

async function adminAuth() {
  const ctx = await loginAdmin();
  return { ctx, auth: { username: ADMIN.username, token: await createToken(ctx) } };
}

test("create a repository in the UI, push, and browse the code", async ({ page }, info) => {
  const { auth } = await adminAuth();
  const name = unique("browse");

  await uiLogin(page, ADMIN.username, ADMIN.password);
  await page.getByRole("link", { name: "New repository" }).click();
  await page.getByLabel("Repository name").fill(name);
  await page.getByLabel("Description").fill("Browsing test");
  await page.getByRole("button", { name: "Create repository" }).click();

  await expect(page).toHaveURL(`${baseURL()}/admin/${name}`);
  await expect(page.getByText("Quick setup")).toBeVisible();
  await expect(page.getByText(cloneUrl("admin", name)).first()).toBeVisible();
  await info.attach("empty-repo", { body: await page.screenshot(), contentType: "image/png" });

  const src = workdir();
  gitOk(src, ["init", "-q"]);
  writeFileSync(join(src, "README.md"), "# Hello Ether\n\nSome **bold** words.\n\n<script>window.pwned = true</script>\n");
  mkdirSync(join(src, "src"));
  writeFileSync(join(src, "src", "main.ts"), "export function greet(name: string): string {\n  return `hi ${name}`;\n}\n");
  gitOk(src, ["add", "-A"]);
  gitOk(src, ["commit", "-q", "-m", "Add readme and greet"]);
  gitOk(src, ["checkout", "-q", "-b", "feature/nested-name"]);
  writeFileSync(join(src, "feature.txt"), "on a slashed branch\n");
  gitOk(src, ["add", "-A"]);
  gitOk(src, ["commit", "-q", "-m", "Feature work"]);
  gitOk(src, ["push", "-q", cloneUrl("admin", name), "main", "feature/nested-name"], auth);

  await page.reload();
  const readme = page.getByRole("article", { name: "README" });
  await expect(readme.getByRole("heading", { name: "Hello Ether" })).toBeVisible();
  await expect(readme.locator("strong")).toHaveText("bold");
  expect(await page.evaluate(() => (window as any).pwned)).toBeUndefined();
  await info.attach("repo-home", { body: await page.screenshot(), contentType: "image/png" });

  await page.getByRole("link", { name: "src", exact: true }).click();
  await page.getByRole("link", { name: "main.ts" }).click();
  await expect(page).toHaveURL(`${baseURL()}/admin/${name}/blob/main/src/main.ts`);
  const code = page.getByRole("region", { name: "File contents" });
  await expect(code).toContainText("export function greet");
  await info.attach("blob", { body: await page.screenshot(), contentType: "image/png" });

  // Branch names containing "/" must resolve against real refs, not split at the first slash.
  await page.goto(`${baseURL()}/admin/${name}/tree/feature/nested-name`);
  await expect(page.getByRole("link", { name: "feature.txt" })).toBeVisible();
  await page.getByRole("link", { name: "feature.txt" }).click();
  await expect(page.getByRole("region", { name: "File contents" })).toContainText("on a slashed branch");

  await page.goto(`${baseURL()}/admin/${name}`);
  await page.getByRole("link", { name: /^\d+ commits?$/ }).click();
  await expect(page.getByRole("heading", { name: "Commits", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Add readme and greet" }).click();
  await expect(page.getByText("src/main.ts")).toBeVisible();
  // The diff gutter marks additions; the line itself carries the new content.
  await expect(page.getByRole("region", { name: "Diff" }).getByText("export function greet(name: string): string {")).toBeVisible();
  await info.attach("commit", { body: await page.screenshot(), contentType: "image/png" });
});

test("issues: open, comment, close", async ({ page }, info) => {
  const ctx = await loginAdmin();
  const name = await createRepo(ctx);

  await uiLogin(page, ADMIN.username, ADMIN.password);
  await page.goto(`${baseURL()}/admin/${name}`);
  await page.getByRole("navigation", { name: "Repository" }).getByRole("link", { name: "Issues" }).click();
  await page.getByRole("link", { name: "New issue" }).click();
  await page.getByLabel("Title").fill("Build is broken");
  await page.getByLabel("Body").fill("Steps:\n\n1. run it\n2. **boom**");
  await page.getByRole("button", { name: "Submit new issue" }).click();

  await expect(page.getByRole("heading", { name: /Build is broken/ })).toBeVisible();
  await expect(page.getByText("#1", { exact: true })).toBeVisible();
  await expect(page.locator("strong", { hasText: "boom" })).toBeVisible();

  await page.getByLabel("Comment").fill("Looking into it");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.getByText("Looking into it")).toBeVisible();

  await page.getByRole("button", { name: "Close issue" }).click();
  await expect(page.getByText("Closed", { exact: true }).first()).toBeVisible();
  await info.attach("issue", { body: await page.screenshot(), contentType: "image/png" });

  await page.getByRole("navigation", { name: "Repository" }).getByRole("link", { name: "Issues" }).click();
  await expect(page.getByRole("link", { name: "Build is broken" })).toHaveCount(0);
  await page.getByRole("link", { name: /Closed/ }).click();
  await expect(page.getByRole("link", { name: "Build is broken" })).toBeVisible();

  const api = await (await ctx.get(`/api/repos/admin/${name}/issues/1`)).json();
  expect(api.issue.state).toBe("closed");
  expect(api.comments.map((c: { body: string }) => c.body)).toEqual(["Looking into it"]);
});

test("pull requests: open from a branch, review the diff, merge", async ({ page }, info) => {
  const { ctx, auth } = await adminAuth();
  const name = await createRepo(ctx);
  await ctx.post(`/api/repos/admin/${name}/issues`, { data: { title: "an issue to take #1", body: "" } });

  const src = workdir();
  gitOk(src, ["init", "-q"]);
  writeFileSync(join(src, "README.md"), "# PR test\n");
  gitOk(src, ["add", "-A"]);
  gitOk(src, ["commit", "-q", "-m", "base"]);
  gitOk(src, ["checkout", "-q", "-b", "topic/add-file"]);
  writeFileSync(join(src, "added.txt"), "brand new file\n");
  gitOk(src, ["add", "-A"]);
  gitOk(src, ["commit", "-q", "-m", "Add a file"]);
  gitOk(src, ["push", "-q", cloneUrl("admin", name), "main", "topic/add-file"], auth);

  await uiLogin(page, ADMIN.username, ADMIN.password);
  await page.goto(`${baseURL()}/admin/${name}`);
  await page.getByRole("navigation", { name: "Repository" }).getByRole("link", { name: "Pull requests" }).click();
  await page.getByRole("link", { name: "New pull request" }).click();
  await page.getByLabel("Base").selectOption("main");
  await page.getByLabel("Compare").selectOption("topic/add-file");
  await expect(page.getByText("added.txt")).toBeVisible();
  await page.getByLabel("Title").fill("Add added.txt");
  await page.getByRole("button", { name: "Create pull request" }).click();

  // Issues and pull requests share one number sequence per repository.
  await expect(page.getByText("#2", { exact: true })).toBeVisible();
  await expect(page.getByText("Open", { exact: true }).first()).toBeVisible();
  await page.getByRole("link", { name: "Files changed" }).click();
  await expect(page.getByRole("region", { name: "Diff" }).getByText("brand new file")).toBeVisible();
  await info.attach("pr-files", { body: await page.screenshot(), contentType: "image/png" });

  await page.getByRole("link", { name: "Conversation" }).click();
  await page.getByRole("button", { name: "Merge pull request" }).click();
  await expect(page.getByText("Merged", { exact: true }).first()).toBeVisible();
  await info.attach("pr-merged", { body: await page.screenshot(), contentType: "image/png" });

  const dst = workdir();
  gitOk(dst, ["clone", "-q", cloneUrl("admin", name), "out"], auth);
  expect(readFileSync(join(dst, "out", "added.txt"), "utf8")).toBe("brand new file\n");
  const parents = gitOk(join(dst, "out"), ["log", "-1", "--format=%P"]).trim().split(" ");
  expect(parents).toHaveLength(2);
});

test("conflicting pull requests cannot be merged", async ({ page }) => {
  const { ctx, auth } = await adminAuth();
  const name = await createRepo(ctx);

  const src = workdir();
  gitOk(src, ["init", "-q"]);
  writeFileSync(join(src, "shared.txt"), "original\n");
  gitOk(src, ["add", "-A"]);
  gitOk(src, ["commit", "-q", "-m", "base"]);
  gitOk(src, ["checkout", "-q", "-b", "theirs"]);
  writeFileSync(join(src, "shared.txt"), "theirs\n");
  gitOk(src, ["commit", "-qam", "theirs"]);
  gitOk(src, ["checkout", "-q", "main"]);
  writeFileSync(join(src, "shared.txt"), "ours\n");
  gitOk(src, ["commit", "-qam", "ours"]);
  gitOk(src, ["push", "-q", cloneUrl("admin", name), "main", "theirs"], auth);
  const mainBefore = gitOk(src, ["rev-parse", "main"]).trim();

  const created = await ctx.post(`/api/repos/admin/${name}/pulls`, { data: { title: "conflict", body: "", base: "main", head: "theirs" } });
  expect(created.ok()).toBe(true);
  const { number } = (await created.json()).pull;

  const detail = await (await ctx.get(`/api/repos/admin/${name}/pulls/${number}`)).json();
  expect(detail.mergeable).toBe(false);
  expect((await ctx.post(`/api/repos/admin/${name}/pulls/${number}/merge`, { data: {} })).status()).toBe(409);

  await uiLogin(page, ADMIN.username, ADMIN.password);
  await page.goto(`${baseURL()}/admin/${name}/pull/${number}`);
  await expect(page.getByText(/conflicts/i).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Merge pull request" })).toBeDisabled();

  const after = workdir();
  gitOk(after, ["clone", "-q", cloneUrl("admin", name), "out"], auth);
  expect(gitOk(join(after, "out"), ["rev-parse", "HEAD"]).trim()).toBe(mainBefore);
});

test("read-only collaborators cannot merge or create pull requests", async () => {
  const { ctx, auth } = await adminAuth();
  const name = await createRepo(ctx);
  const src = workdir();
  gitOk(src, ["init", "-q"]);
  writeFileSync(join(src, "x.txt"), "x\n");
  gitOk(src, ["add", "-A"]);
  gitOk(src, ["commit", "-q", "-m", "x"]);
  gitOk(src, ["branch", "side"]);
  gitOk(src, ["push", "-q", cloneUrl("admin", name), "main", "side"], auth);

  const { createUser } = await import("./helpers");
  const reader = await createUser(ctx);
  await ctx.put(`/api/repos/admin/${name}/collaborators/${reader.username}`, { data: { role: "read" } });

  // Readers can still participate in discussion.
  expect((await reader.ctx.post(`/api/repos/admin/${name}/issues`, { data: { title: "q", body: "" } })).ok()).toBe(true);
  expect((await reader.ctx.post(`/api/repos/admin/${name}/pulls`, { data: { title: "p", body: "", base: "main", head: "side" } })).status()).toBe(403);

  const pr = await (await ctx.post(`/api/repos/admin/${name}/pulls`, { data: { title: "p", body: "", base: "main", head: "side" } })).json();
  expect((await reader.ctx.post(`/api/repos/admin/${name}/pulls/${pr.pull.number}/merge`, { data: {} })).status()).toBe(403);
  expect(existsSync(join(process.env.ETHER_DATA!, "repos", "admin", `${name}.git`))).toBe(true);
});
