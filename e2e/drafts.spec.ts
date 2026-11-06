import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseURL, cloneUrl, createRepo, createUser, gitOk, loginAdmin, uiLogin, unique, workdir } from "./helpers";

const headers = () => ({ Origin: baseURL() });

test("a draft pull request can't be merged until it's marked ready for review", async ({ page }, info) => {
  const admin = await loginAdmin();
  const author = await createUser(admin);
  const reader = await createUser(admin);
  const repo = await createRepo(author.ctx, unique("draft"));
  const api = `/api/repos/${author.username}/${repo}`;
  await author.ctx.put(`${api}/collaborators/${reader.username}`, { data: { role: "read" }, headers: headers() });

  const src = workdir();
  gitOk(src, ["init", "-q"]);
  writeFileSync(join(src, "a.txt"), "one\n");
  gitOk(src, ["add", "-A"]);
  gitOk(src, ["commit", "-q", "-m", "base"]);
  gitOk(src, ["checkout", "-q", "-b", "wip"]);
  writeFileSync(join(src, "a.txt"), "one\ntwo\n");
  gitOk(src, ["commit", "-qam", "two"]);
  gitOk(src, ["push", "-q", cloneUrl(author.username, repo), "main", "wip"], { username: author.username, token: author.token });

  // The author opens it as a draft from the form.
  await uiLogin(page, author.username, author.password);
  await page.goto(`${baseURL()}/${author.username}/${repo}/pulls/new`);
  await page.getByLabel("Compare").selectOption("wip");
  await page.getByLabel("Title").fill("Work in progress");
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page.getByText("This pull request is still a draft.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Merge pull request" })).toHaveCount(0);
  const number = page.url().split("/").pop()!;
  await info.attach("draft", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

  // The API refuses the merge, and the list can show drafts on their own.
  expect((await author.ctx.post(`${api}/pulls/${number}/merge`, { headers: headers() })).status()).toBe(409);
  const drafts = await (await author.ctx.get(`${api}/pulls?draft=true`)).json();
  expect(drafts.items.map((p: { number: number; draft: boolean }) => [p.number, p.draft])).toEqual([[Number(number), true]]);
  expect((await (await author.ctx.get(`${api}/pulls?draft=false`)).json()).items).toEqual([]);
  await page.goto(`${baseURL()}/${author.username}/${repo}/pulls`);
  await expect(page.getByRole("img", { name: "Draft" })).toBeVisible();

  // Someone with read access who didn't write it can't change that.
  expect((await reader.ctx.patch(`${api}/issues/${number}`, { data: { draft: false }, headers: headers() })).status()).toBe(403);

  // Ready for review: now it merges like any other, and can go back to being a draft.
  await page.goto(`${baseURL()}/${author.username}/${repo}/pull/${number}`);
  await page.getByRole("button", { name: "Ready for review" }).click();
  await expect(page.getByRole("button", { name: "Merge pull request" })).toBeEnabled();
  await page.getByRole("button", { name: "Convert to draft" }).click();
  await expect(page.getByText("This pull request is still a draft.")).toBeVisible();
  await page.getByRole("button", { name: "Ready for review" }).click();
  await page.getByRole("button", { name: "Merge pull request" }).click();
  await expect(page.getByText("merged this pull request")).toBeVisible();

  // A merged pull request can't become a draft again.
  expect((await author.ctx.patch(`${api}/issues/${number}`, { data: { draft: true }, headers: headers() })).status()).toBe(409);
});
