import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseURL, cloneUrl, createRepo, createUser, gitOk, loginAdmin, uiLogin, unique, workdir } from "./helpers";

const as = (email: string, name = "Someone") => ({ GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email });

function pushCommits(owner: string, repo: string, auth: { username: string; token: string }, authors: string[]) {
  const src = workdir();
  gitOk(src, ["init", "-q"]);
  for (const email of authors) {
    writeFileSync(join(src, `${unique("f")}.txt`), email);
    gitOk(src, ["add", "-A"]);
    gitOk(src, ["commit", "-q", "-m", `work by ${email}`], undefined, as(email));
  }
  gitOk(src, ["push", "-q", cloneUrl(owner, repo), "main"], auth);
}

test("your first push teaches Ether your commit email, so contributions count without setup", async ({ page }, info) => {
  const admin = await loginAdmin();
  const me = await createUser(admin);
  const repo = await createRepo(me.ctx);
  const email = `${me.username}@laptop.test`;
  pushCommits(me.username, repo, { username: me.username, token: me.token }, [email, email, email]);

  await uiLogin(page, me.username, me.password);
  await page.goto(`${baseURL()}/${me.username}`);
  await expect(page.getByText("3 contributions in the last year")).toBeVisible();
  await info.attach("profile-after-push", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

  await page.goto(`${baseURL()}/settings`);
  await expect(page.getByLabel("Commit emails")).toHaveValue(email);
});

test("pushes with other people's commits suggest emails instead of claiming them", async ({ page }) => {
  const admin = await loginAdmin();
  const me = await createUser(admin);
  const friend = await createUser(admin);
  const repo = await createRepo(me.ctx);
  const mine = `${me.username}@laptop.test`;
  const theirs = `${friend.username}@desk.test`;
  // An imported history with two authors: Ether can't tell which one is you.
  pushCommits(me.username, repo, { username: me.username, token: me.token }, [theirs, mine, mine]);

  await uiLogin(page, me.username, me.password);
  await page.goto(`${baseURL()}/${me.username}`);
  await expect(page.getByText("0 contributions in the last year")).toBeVisible();
  // The profile owner is told why and where to fix it.
  await expect(page.getByRole("link", { name: "Add your commit email" })).toBeVisible();

  await page.goto(`${baseURL()}/settings`);
  const seen = page.getByRole("list", { name: "Emails in your pushes" });
  await expect(seen).toContainText(mine);
  await expect(seen).toContainText(theirs);
  await seen.getByRole("listitem").filter({ hasText: mine }).getByRole("button", { name: "Add" }).click();
  await expect(page.getByLabel("Commit emails")).toHaveValue(mine);
  await page.getByRole("button", { name: "Save commit emails" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Commit emails saved" })).toBeVisible();

  await page.goto(`${baseURL()}/${me.username}`);
  await expect(page.getByText("2 contributions in the last year")).toBeVisible();

  // An address someone already owns is never auto-claimed by a later pusher.
  const other = await createUser(admin);
  const otherRepo = await createRepo(other.ctx);
  pushCommits(other.username, otherRepo, { username: other.username, token: other.token }, [mine]);
  expect((await (await other.ctx.get("/api/me/profile")).json()).emails).toEqual([]);
});
