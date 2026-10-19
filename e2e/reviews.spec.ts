import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseURL, cloneUrl, createRepo, createUser, gitOk, loginAdmin, uiLogin, unique, workdir } from "./helpers";

const headers = () => ({ Origin: baseURL() });

test("reviewers are requested, review with line comments, and can be required before merging", async ({ page, browser }, info) => {
  const admin = await loginAdmin();
  const author = await createUser(admin);
  const reviewer = await createUser(admin);
  const repo = await createRepo(author.ctx, unique("review"));
  const api = `/api/repos/${author.username}/${repo}`;
  await author.ctx.put(`${api}/collaborators/${reviewer.username}`, { data: { role: "write" }, headers: headers() });
  expect((await author.ctx.patch(api, { data: { requireApproval: true }, headers: headers() })).ok()).toBe(true);

  const src = workdir();
  gitOk(src, ["init", "-q"]);
  writeFileSync(join(src, "app.ts"), "export const a = 1;\n");
  gitOk(src, ["add", "-A"]);
  gitOk(src, ["commit", "-q", "-m", "base"]);
  gitOk(src, ["checkout", "-q", "-b", "change"]);
  writeFileSync(join(src, "app.ts"), "export const a = 1;\nexport const b = eval('2');\n");
  gitOk(src, ["commit", "-qam", "add b"]);
  gitOk(src, ["push", "-q", cloneUrl(author.username, repo), "main", "change"], { username: author.username, token: author.token });
  const { pull } = await (await author.ctx.post(`${api}/pulls`, { data: { title: "Add b", body: "", base: "main", head: "change" }, headers: headers() })).json();

  // The author requests a review from the sidebar.
  await uiLogin(page, author.username, author.password);
  await page.goto(`${baseURL()}/${author.username}/${repo}/pull/${pull.number}`);
  await page.getByRole("button", { name: "Edit reviewers" }).click();
  await page.getByRole("menuitemcheckbox", { name: new RegExp(reviewer.username) }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("list", { name: "Reviewers" })).toContainText(reviewer.username);
  // Merging is blocked until someone approves.
  await expect(page.getByText("Merging requires an approving review")).toBeVisible();
  await expect(page.getByRole("button", { name: "Merge pull request" })).toBeDisabled();

  // The reviewer sees the request on their dashboard, then requests changes with a line comment.
  const ctx = await browser.newContext();
  const r = await ctx.newPage();
  await uiLogin(r, reviewer.username, reviewer.password);
  await expect(r.getByRole("region", { name: "Waiting for your review" })).toContainText("Add b");
  await r.goto(`${baseURL()}/${author.username}/${repo}/pull/${pull.number}?tab=files`);
  const panel = r.getByRole("region", { name: "Review" });
  await panel.getByLabel("File").selectOption("app.ts");
  await panel.getByLabel("Line", { exact: true }).fill("2");
  await panel.getByLabel("Line comment").fill("Please don't use eval here.");
  await panel.getByRole("button", { name: "Add line comment" }).click();
  await expect(panel.getByRole("list", { name: "Pending comments" })).toContainText("app.ts:2");
  await panel.getByLabel("Review summary").fill("One thing to fix.");
  await panel.getByRole("radio", { name: /Request changes/ }).check();
  await panel.getByRole("button", { name: "Submit review" }).click();
  await expect(r.getByText(`${reviewer.username} requested changes`)).toBeVisible();
  await expect(r.getByRole("article", { name: /Review by/ })).toContainText("Please don't use eval here.");
  await expect(r.getByRole("article", { name: /Review by/ })).toContainText("app.ts:2");
  await info.attach("changes-requested", { body: await r.screenshot({ fullPage: true }), contentType: "image/png" });

  // Authors can't approve their own pull request.
  expect((await author.ctx.post(`${api}/pulls/${pull.number}/reviews`, { data: { state: "approved", body: "" }, headers: headers() })).status()).toBe(400);
  // Line comments must point at a line of the diff's new side.
  expect(
    (await reviewer.ctx.post(`${api}/pulls/${pull.number}/reviews`, { data: { state: "commented", body: "", comments: [{ path: "nope.ts", line: 1, body: "x" }] }, headers: headers() })).status(),
  ).toBe(400);
  expect((await author.ctx.post(`${api}/pulls/${pull.number}/merge`, { data: {}, headers: headers() })).status()).toBe(409);

  // Approving unblocks the merge.
  await r.goto(`${baseURL()}/${author.username}/${repo}/pull/${pull.number}?tab=files`);
  await r.getByRole("region", { name: "Review" }).getByRole("radio", { name: /Approve/ }).check();
  await r.getByRole("region", { name: "Review" }).getByRole("button", { name: "Submit review" }).click();
  await expect(r.getByText(`${reviewer.username} approved these changes`)).toBeVisible();
  await ctx.close();

  await page.reload();
  await expect(page.getByRole("list", { name: "Reviewers" })).toContainText("Approved");
  await page.getByRole("button", { name: "Merge pull request" }).click();
  await expect(page.getByText("Merged", { exact: true }).first()).toBeVisible();
});
