import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADMIN, baseURL, cloneUrl, createRepo, createToken, createUser, gitOk, loginAdmin, uiLogin, workdir } from "./helpers";

const at = (iso: string, who = "E2E") => ({
  GIT_AUTHOR_NAME: who,
  GIT_AUTHOR_EMAIL: `${who}@ether.test`,
  GIT_AUTHOR_DATE: iso,
  GIT_COMMITTER_NAME: who,
  GIT_COMMITTER_EMAIL: `${who}@ether.test`,
  GIT_COMMITTER_DATE: iso,
});

// A repository with a folder, two files changed by different commits, a slashed branch
// and two tags whose name order differs from their creation order.
async function seededRepo() {
  const ctx = await loginAdmin();
  const auth = { username: ADMIN.username, token: await createToken(ctx) };
  const name = await createRepo(ctx);
  const src = workdir();
  gitOk(src, ["init", "-q"]);
  mkdirSync(join(src, "src"));
  writeFileSync(join(src, "README.md"), "# Seed\n");
  writeFileSync(join(src, "src", "main.ts"), "export {};\n");
  writeFileSync(join(src, "notes.txt"), "one\n");
  gitOk(src, ["add", "-A"]);
  gitOk(src, ["commit", "-q", "-m", "Initial import"], undefined, at("2026-01-01T10:00:00Z"));
  gitOk(src, ["tag", "v0.9.0"]);
  writeFileSync(join(src, "src", "main.ts"), "export const x = 1;\n");
  gitOk(src, ["commit", "-qam", "Teach main to export x"], undefined, at("2026-02-01T10:00:00Z"));
  writeFileSync(join(src, "notes.txt"), "two\n");
  gitOk(src, ["commit", "-qam", "Rewrite the notes"], undefined, at("2026-03-01T10:00:00Z"));
  gitOk(src, ["tag", "v0.10.0"], undefined, at("2026-03-01T10:00:00Z"));
  gitOk(src, ["checkout", "-q", "-b", "feature/picker"]);
  writeFileSync(join(src, "only-on-feature.txt"), "x\n");
  gitOk(src, ["add", "-A"]);
  gitOk(src, ["commit", "-q", "-m", "Feature file"]);
  gitOk(src, ["push", "-q", cloneUrl("admin", name), "main", "feature/picker", "v0.9.0", "v0.10.0"], auth);
  const issue = await (await ctx.post(`/api/repos/admin/${name}/issues`, { data: { title: "Findable issue", body: "" } })).json();
  return { ctx, name, issueNumber: issue.issue.number as number };
}

test("repo home: file rows carry their last commit, sidebar shows about and releases, clone URL is whole", async ({ page }, info) => {
  const { name } = await seededRepo();
  await uiLogin(page, ADMIN.username, ADMIN.password);
  await page.goto(`${baseURL()}/admin/${name}`);

  const files = page.getByRole("table", { name: "Files" });
  await expect(files.getByRole("row", { name: /notes\.txt/ })).toContainText("Rewrite the notes");
  await expect(files.getByRole("row", { name: /^src\b/ })).toContainText("Teach main to export x");
  await expect(files.getByRole("row", { name: /README\.md/ })).toContainText("Initial import");

  const about = page.getByRole("region", { name: "About" });
  await expect(about).toContainText("e2e repo");
  const releases = page.getByRole("region", { name: "Releases" });
  await expect(releases).toContainText("2 tags");
  // Newest by creation, not by name: v0.10.0 sorts before v0.9.0 as text.
  await expect(releases.getByRole("link", { name: /^v0\.\d+\.0$/ })).toHaveText("v0.10.0");

  await expect(page.getByRole("textbox", { name: "Clone URL" })).toHaveValue(cloneUrl("admin", name));
  await info.attach("repo-home", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

  await page.setViewportSize({ width: 375, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await info.attach("repo-home-375", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
});

test("branch picker filters refs and switches the tree", async ({ page }, info) => {
  const { name } = await seededRepo();
  await uiLogin(page, ADMIN.username, ADMIN.password);
  await page.goto(`${baseURL()}/admin/${name}`);

  await page.getByRole("button", { name: /Switch branch or tag/ }).click();
  const picker = page.getByRole("dialog", { name: "Switch branch or tag" });
  await expect(picker.getByRole("option", { name: /main.*default/ })).toBeVisible();
  await picker.getByRole("combobox").fill("pick");
  await expect(picker.getByRole("option")).toHaveCount(1);
  await info.attach("picker", { body: await page.screenshot(), contentType: "image/png" });
  await picker.getByRole("option", { name: /feature\/picker/ }).click();

  await expect(page).toHaveURL(`${baseURL()}/admin/${name}/tree/feature/picker`);
  await expect(page.getByRole("link", { name: "only-on-feature.txt" })).toBeVisible();

  await page.getByRole("button", { name: /Switch branch or tag/ }).click();
  await page.getByRole("tab", { name: "Tags" }).click();
  await page.getByRole("option", { name: "v0.9.0" }).click();
  await expect(page).toHaveURL(`${baseURL()}/admin/${name}/tree/v0.9.0`);
});

test("header search jumps to a repository or an issue number", async ({ page }) => {
  const { name, issueNumber } = await seededRepo();
  await uiLogin(page, ADMIN.username, ADMIN.password);

  const search = page.getByRole("combobox", { name: "Search or jump to" });
  await search.click();
  // The whole name: other specs create repos with the same prefix at the same time, and the box shows only 8 matches.
  await search.fill(name);
  await page.getByRole("option", { name: new RegExp(`admin/${name}`) }).click();
  await expect(page).toHaveURL(`${baseURL()}/admin/${name}`);
  // "#n" jumps within the repository you are looking at, so wait until it has rendered.
  await expect(page.getByRole("region", { name: "Activity" })).toBeVisible();

  await search.click();
  await search.fill(`#${issueNumber}`);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${baseURL()}/admin/${name}/issues/${issueNumber}`);
  await expect(page.getByRole("heading", { name: /Findable issue/ })).toBeVisible();
});

test("issue list marks each row's state with a labelled icon", async ({ page }) => {
  const { name } = await seededRepo();
  await uiLogin(page, ADMIN.username, ADMIN.password);
  await page.goto(`${baseURL()}/admin/${name}/issues`);
  await expect(page.getByRole("listitem").filter({ hasText: "Findable issue" }).getByRole("img", { name: "Open" })).toBeVisible();
});

test("theme choice persists and paints before the session check returns", async ({ page, browser }, info) => {
  const admin = await loginAdmin();
  const me = await createUser(admin);
  await uiLogin(page, me.username, me.password);
  await page.goto(`${baseURL()}/settings`);
  await page.getByRole("radio", { name: "Dark" }).check();
  await page.getByLabel("Accent colour").fill("#bf3989");
  await page.getByRole("button", { name: "Save accent" }).click();
  await expect(page.getByRole("status")).toHaveText("Accent saved");

  // A fresh session on a light-mode OS gets dark, from the account itself.
  const ctx = await browser.newContext({ colorScheme: "light" });
  const fresh = await ctx.newPage();
  await uiLogin(fresh, me.username, me.password);
  const bg = await fresh.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe("rgb(1, 4, 9)");
  await info.attach("dark-by-choice", { body: await fresh.screenshot(), contentType: "image/png" });

  // On a later visit the saved theme and accent are on screen while /api/me is still pending.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  // Hold exactly one /api/me request; the route then removes itself.
  await fresh.route(
    "**/api/me",
    async (route) => {
      await held;
      await route.continue();
    },
    { times: 1 },
  );
  await fresh.goto(`${baseURL()}/settings`, { waitUntil: "domcontentloaded" });
  expect(await fresh.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(1, 4, 9)");
  const accent = await fresh.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
  expect(accent).not.toBe("#4fc3d9");
  expect(accent).not.toBe("");
  const answered = fresh.waitForResponse("**/api/me");
  release();
  await answered;

  // Signing out clears it for whoever uses the browser next.
  await fresh.getByRole("button", { name: "Account menu" }).click();
  await fresh.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(fresh).toHaveURL(/\/login/);
  expect(await fresh.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe("rgb(1, 4, 9)");
  await ctx.close();

  // Choosing System again follows the OS.
  await page.goto(`${baseURL()}/settings`);
  await page.getByRole("radio", { name: "System" }).check();
  await expect(page.getByRole("status")).toHaveText("Theme saved");
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.hasAttribute("data-theme"))).toBe(false);
});
