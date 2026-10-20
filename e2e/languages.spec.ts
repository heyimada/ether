import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseURL, cloneUrl, createRepo, createUser, gitOk, loginAdmin, uiLogin, unique, workdir } from "./helpers";

const headers = () => ({ Origin: baseURL() });

function write(root: string, path: string, bytes: number) {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), "x".repeat(bytes - 1) + "\n");
}

test("repo home shows languages by bytes on the default branch, and the latest commits with their authors", async ({ page }, info) => {
  const admin = await loginAdmin();
  const owner = await createUser(admin);
  const author = await createUser(admin);
  const repo = await createRepo(owner.ctx, unique("langs"));
  const auth = { username: owner.username, token: owner.token };
  // The author's commits are tied to their account through their commit email.
  await author.ctx.put("/api/me/emails", { data: { emails: [`${author.username}@desk.test`] }, headers: headers() });

  const src = workdir();
  gitOk(src, ["init", "-q"]);
  write(src, "src/app.ts", 6000);
  write(src, "web/site.css", 3000);
  write(src, "README.md", 1000);
  // Data files and vendored code don't count towards languages.
  write(src, "package.json", 5000);
  write(src, "node_modules/dep/index.js", 9000);
  gitOk(src, ["add", "-A"]);
  gitOk(src, ["commit", "-q", "-m", "First files"]);
  gitOk(src, ["push", "-q", cloneUrl(owner.username, repo), "main"], auth);

  await uiLogin(page, owner.username, owner.password);
  await page.goto(`${baseURL()}/${owner.username}/${repo}`);
  const languages = page.getByRole("list", { name: "Languages" }).getByRole("listitem");
  await expect(languages).toHaveText([/TypeScript\s*60\.0%/, /CSS\s*30\.0%/, /Markdown\s*10\.0%/]);

  // A new head means new numbers: more CSS moves it to the top.
  write(src, "web/more.css", 6000);
  gitOk(src, ["add", "-A"]);
  gitOk(src, ["commit", "-q", "-m", "More styles"], undefined, {
    GIT_AUTHOR_NAME: "Desk Person",
    GIT_AUTHOR_EMAIL: `${author.username}@desk.test`,
  });
  gitOk(src, ["push", "-q", cloneUrl(owner.username, repo), "main"], auth);
  await page.reload();
  await expect(languages).toHaveText([/CSS\s*56\.3%/, /TypeScript\s*37\.5%/, /Markdown\s*6\.3%/]);

  // Latest commits, newest first; a commit email that belongs to someone links to their profile.
  const commits = page.getByRole("list", { name: "Recent commits" }).getByRole("listitem");
  await expect(commits).toHaveCount(2);
  await expect(commits.nth(0)).toContainText("More styles");
  await expect(commits.nth(0).getByRole("link", { name: author.username })).toHaveAttribute("href", `/${author.username}`);
  await expect(commits.nth(1)).toContainText("First files");
  await info.attach("repo-languages", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await info.attach("repo-languages-375", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

  // A repository with nothing but data files has no languages section at all.
  const config = await createRepo(owner.ctx, unique("config"));
  const cfg = workdir();
  gitOk(cfg, ["init", "-q"]);
  write(cfg, "settings.json", 400);
  gitOk(cfg, ["add", "-A"]);
  gitOk(cfg, ["commit", "-q", "-m", "settings"]);
  gitOk(cfg, ["push", "-q", cloneUrl(owner.username, config), "main"], auth);
  await page.goto(`${baseURL()}/${owner.username}/${config}`);
  await expect(page.getByRole("link", { name: "settings.json" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Languages" })).toHaveCount(0);
});
