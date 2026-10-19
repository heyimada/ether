import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADMIN, baseURL, cloneUrl, createRepo, createToken, createUser, gitOk, loginAdmin, uiLogin, workdir } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;

// Commits by three people at fixed ages: one falls outside the 12-week window,
// one lands two weeks back, three land in the current week.
const COMMITS = [
  { who: "kat", ageMs: 200 * DAY, file: "old.txt" },
  { who: "mira", ageMs: 15 * DAY, file: "a.txt" },
  { who: "jonas", ageMs: 3 * DAY, file: "b.txt" },
  { who: "mira", ageMs: 2 * 60 * 60 * 1000, file: "c.txt" },
  { who: "mira", ageMs: 60 * 60 * 1000, file: "d.txt" },
];

test("repo home shows recent activity: open work, weekly commits and contributors", async ({ page }, info) => {
  const ctx = await loginAdmin();
  const auth = { username: ADMIN.username, token: await createToken(ctx) };
  const name = await createRepo(ctx);

  const src = workdir();
  gitOk(src, ["init", "-q"]);
  const now = Date.now();
  for (const c of COMMITS) {
    writeFileSync(join(src, c.file), `${c.who}\n`);
    gitOk(src, ["add", "-A"]);
    const date = new Date(now - c.ageMs).toISOString();
    gitOk(src, ["commit", "-q", "-m", `work by ${c.who}`], undefined, {
      GIT_AUTHOR_NAME: c.who,
      GIT_AUTHOR_EMAIL: `${c.who}@ether.test`,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: c.who,
      GIT_COMMITTER_EMAIL: `${c.who}@ether.test`,
      GIT_COMMITTER_DATE: date,
    });
  }
  gitOk(src, ["checkout", "-q", "-b", "topic"]);
  writeFileSync(join(src, "topic.txt"), "topic\n");
  gitOk(src, ["add", "-A"]);
  gitOk(src, ["commit", "-q", "-m", "topic work"]);
  gitOk(src, ["push", "-q", cloneUrl("admin", name), "main", "topic"], auth);

  await ctx.post(`/api/repos/admin/${name}/issues`, { data: { title: "first issue", body: "" } });
  await ctx.post(`/api/repos/admin/${name}/issues`, { data: { title: "second issue", body: "" } });
  const closed = await (await ctx.post(`/api/repos/admin/${name}/issues`, { data: { title: "done already", body: "" } })).json();
  await ctx.patch(`/api/repos/admin/${name}/issues/${closed.issue.number}`, { data: { state: "closed" } });
  await ctx.post(`/api/repos/admin/${name}/pulls`, { data: { title: "Topic", body: "", base: "main", head: "topic" } });

  await uiLogin(page, ADMIN.username, ADMIN.password);
  await page.goto(`${baseURL()}/admin/${name}`);

  const activity = page.getByRole("region", { name: "Activity" });
  await expect(activity.getByRole("link", { name: /1 open pull request\b/ })).toBeVisible();
  await expect(activity.getByRole("link", { name: /2 open issues/ })).toBeVisible();
  // Only commits on the default branch inside the window count; kat's is 200 days old.
  await expect(activity).toContainText("4 commits in the last 12 weeks");

  const contributors = page.getByRole("list", { name: "Contributors" }).getByRole("listitem");
  await expect(contributors).toHaveText([/mira.*3 commits/, /jonas.*1 commit$/]);

  const weeks = page.getByRole("list", { name: "Commits per week" }).getByRole("listitem");
  await expect(weeks).toHaveCount(12);
  await expect(weeks.nth(11)).toContainText("3 commits");
  await expect(weeks.nth(10)).toContainText("0 commits");
  await expect(weeks.nth(9)).toContainText("1 commit");
  await expect(weeks.nth(0)).toContainText("0 commits");

  // The existing code view still sits below the activity.
  await expect(page.getByRole("link", { name: "a.txt" })).toBeVisible();
  await info.attach("repo-activity", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await info.attach("repo-activity-375", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

  // Activity is repository data: people without access cannot read it.
  const outsider = await createUser(ctx);
  expect((await outsider.ctx.get(`/api/repos/admin/${name}/activity`)).status()).toBe(404);
});
