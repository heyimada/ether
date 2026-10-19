import { expect, test } from "@playwright/test";
import { baseURL, createRepo, createUser, loginAdmin, uiLogin, unique } from "./helpers";

const headers = () => ({ Origin: baseURL() });

test("issues get labels and assignees, lists filter by them, and only writers can change them", async ({ page }, info) => {
  const admin = await loginAdmin();
  const owner = await createUser(admin);
  const helper = await createUser(admin);
  const reader = await createUser(admin);
  const repo = await createRepo(owner.ctx, unique("triage"));
  const api = `/api/repos/${owner.username}/${repo}`;
  await owner.ctx.put(`${api}/collaborators/${helper.username}`, { data: { role: "write" }, headers: headers() });
  await owner.ctx.put(`${api}/collaborators/${reader.username}`, { data: { role: "read" }, headers: headers() });

  // New repositories start with a useful default set.
  const defaults = (await (await owner.ctx.get(`${api}/labels`)).json()).labels.map((l: { name: string }) => l.name);
  expect(defaults).toEqual(expect.arrayContaining(["bug", "enhancement", "documentation", "question"]));

  // Create a label in the labels page.
  await uiLogin(page, owner.username, owner.password);
  await page.goto(`${baseURL()}/${owner.username}/${repo}/labels`);
  await page.getByLabel("Label name").fill("needs-repro");
  await page.getByLabel("Description").fill("Can't reproduce yet");
  await page.getByRole("button", { name: "Create label" }).click();
  await expect(page.getByRole("list", { name: "Labels" })).toContainText("needs-repro");

  for (const title of ["Crash on start", "Typo in docs"]) await owner.ctx.post(`${api}/issues`, { data: { title, body: "" }, headers: headers() });

  // Label and assign issue #1 from its page.
  await page.goto(`${baseURL()}/${owner.username}/${repo}/issues/1`);
  await page.getByRole("button", { name: "Edit labels" }).click();
  await page.getByRole("menuitemcheckbox", { name: /bug/ }).click();
  await page.getByRole("menuitemcheckbox", { name: /needs-repro/ }).click();
  await page.keyboard.press("Escape");
  const labels = page.getByRole("list", { name: "Issue labels" });
  await expect(labels).toContainText("bug");
  await expect(labels).toContainText("needs-repro");
  await page.getByRole("button", { name: "Edit assignees" }).click();
  await page.getByRole("menuitemcheckbox", { name: new RegExp(helper.username) }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("list", { name: "Assignees" })).toContainText(helper.username);
  await info.attach("issue-sidebar", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

  // Lists show them and filter by them.
  await page.goto(`${baseURL()}/${owner.username}/${repo}/issues`);
  const row = page.getByRole("listitem").filter({ hasText: "Crash on start" });
  await expect(row).toContainText("bug");
  await row.getByRole("link", { name: "bug" }).click();
  await expect(page.getByRole("link", { name: "Crash on start" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Typo in docs" })).toHaveCount(0);
  const byAssignee = await (await owner.ctx.get(`${api}/issues?assignee=${helper.username}`)).json();
  expect(byAssignee.items.map((i: { title: string }) => i.title)).toEqual(["Crash on start"]);

  // Writers can triage; readers can't; assignees must be able to see the repository.
  expect((await helper.ctx.put(`${api}/issues/2/labels`, { data: { labels: ["documentation"] }, headers: headers() })).ok()).toBe(true);
  expect((await reader.ctx.put(`${api}/issues/2/labels`, { data: { labels: ["bug"] }, headers: headers() })).status()).toBe(403);
  const outsider = await createUser(admin);
  expect((await owner.ctx.put(`${api}/issues/2/assignees`, { data: { assignees: [outsider.username] }, headers: headers() })).status()).toBe(400);
  expect((await owner.ctx.put(`${api}/issues/2/labels`, { data: { labels: ["no-such-label"] }, headers: headers() })).status()).toBe(400);

  // Deleting a label removes it from issues.
  expect((await owner.ctx.delete(`${api}/labels/bug`, { headers: headers() })).ok()).toBe(true);
  const one = await (await owner.ctx.get(`${api}/issues/1`)).json();
  expect(one.issue.labels.map((l: { name: string }) => l.name)).toEqual(["needs-repro"]);
});
