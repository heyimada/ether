import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseURL, createRepo, createUser, git, gitOk, loginAdmin, uiLogin, unique, workdir } from "./helpers";

const headers = () => ({ Origin: baseURL() });

test("repositories have a wiki that writers edit in the browser or with git, with history", async ({ page, browser }, info) => {
  const admin = await loginAdmin();
  const owner = await createUser(admin);
  const reader = await createUser(admin);
  const repo = await createRepo(owner.ctx, unique("docs"));
  const api = `/api/repos/${owner.username}/${repo}`;
  await owner.ctx.put(`${api}/collaborators/${reader.username}`, { data: { role: "read" }, headers: headers() });

  await uiLogin(page, owner.username, owner.password);
  await page.goto(`${baseURL()}/${owner.username}/${repo}`);
  await page.getByRole("navigation", { name: "Repository" }).getByRole("link", { name: "Wiki" }).click();
  await page.getByRole("link", { name: "Create the first page" }).click();
  await page.getByLabel("Page title").fill("Home");
  await page.getByLabel("Content").fill("# Welcome\n\nSee [[Setup Guide]].");
  await page.getByRole("button", { name: "Save page" }).click();
  await expect(page.getByRole("article", { name: "Home" }).getByRole("heading", { name: "Welcome" })).toBeVisible();

  // Wiki links to missing pages lead to creating them.
  await page.getByRole("article", { name: "Home" }).getByRole("link", { name: "Setup Guide" }).click();
  await expect(page.getByLabel("Page title")).toHaveValue("Setup Guide");
  await page.getByLabel("Content").fill("Install with `bun install`.");
  await page.getByRole("button", { name: "Save page" }).click();
  await expect(page.getByRole("list", { name: "Wiki pages" })).toContainText("Setup Guide");

  // Edit Home; history keeps both revisions.
  await page.getByRole("list", { name: "Wiki pages" }).getByRole("link", { name: "Home" }).click();
  await expect(page.getByRole("article", { name: "Home" })).toBeVisible();
  await page.getByRole("link", { name: "Edit page" }).click();
  await expect(page.getByLabel("Page title")).toHaveValue("Home");
  await page.getByLabel("Content").fill("# Welcome back\n\nSee [[Setup Guide]].");
  await page.getByLabel("Edit message").fill("Friendlier greeting");
  await page.getByRole("button", { name: "Save page" }).click();
  await page.getByRole("link", { name: /revisions?/ }).click();
  await expect(page.getByRole("list", { name: "Revisions" }).getByRole("listitem")).toHaveCount(2);
  await expect(page.getByRole("list", { name: "Revisions" })).toContainText("Friendlier greeting");
  await info.attach("wiki-history", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

  // Readers read but can't edit.
  const ctx = await browser.newContext();
  const r = await ctx.newPage();
  await uiLogin(r, reader.username, reader.password);
  await r.goto(`${baseURL()}/${owner.username}/${repo}/wiki`);
  await expect(r.getByRole("article", { name: "Home" })).toContainText("Welcome back");
  await expect(r.getByRole("link", { name: "Edit page" })).toHaveCount(0);
  await ctx.close();
  expect((await reader.ctx.put(`${api}/wiki/Home`, { data: { content: "vandalism" }, headers: headers() })).status()).toBe(403);
  expect((await owner.ctx.put(`${api}/wiki/..%2Fescape`, { data: { content: "x" }, headers: headers() })).status()).toBe(400);

  // The wiki is a git repository: clone it, push a page, see it on the site.
  const dir = workdir();
  const wikiUrl = `${baseURL()}/${owner.username}/${repo}.wiki.git`;
  gitOk(dir, ["clone", "-q", wikiUrl, "w"], { username: owner.username, token: owner.token });
  expect(readFileSync(join(dir, "w", "Home.md"), "utf8")).toContain("Welcome back");
  writeFileSync(join(dir, "w", "FAQ.md"), "Questions and answers.\n");
  gitOk(join(dir, "w"), ["add", "-A"]);
  gitOk(join(dir, "w"), ["commit", "-q", "-m", "Add FAQ"]);
  gitOk(join(dir, "w"), ["push", "-q", "origin", "HEAD"], { username: owner.username, token: owner.token });
  await page.goto(`${baseURL()}/${owner.username}/${repo}/wiki/FAQ`);
  await expect(page.getByRole("article", { name: "FAQ" })).toContainText("Questions and answers.");
  // Readers can clone the wiki but not push to it.
  const rdir = workdir();
  gitOk(rdir, ["clone", "-q", wikiUrl, "w"], { username: reader.username, token: reader.token });
  writeFileSync(join(rdir, "w", "x.md"), "x\n");
  gitOk(join(rdir, "w"), ["add", "-A"]);
  gitOk(join(rdir, "w"), ["commit", "-q", "-m", "x"]);
  expect(git(join(rdir, "w"), ["push", "-q", "origin", "HEAD"], { username: reader.username, token: reader.token }).code).not.toBe(0);
});
