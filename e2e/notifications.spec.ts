import { expect, test, type APIRequestContext } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseURL, cloneUrl, createRepo, createUser, gitOk, loginAdmin, uiLogin, unique, workdir } from "./helpers";

const headers = () => ({ Origin: baseURL() });

type N = { id: number; reason: string; issueNumber: number | null; actor: string | null; excerpt: string; read: boolean; title: string };
const inbox = async (ctx: APIRequestContext, all = false): Promise<{ notifications: N[]; unread: number }> =>
  (await ctx.get(`/api/me/notifications${all ? "?filter=all" : ""}`)).json();
const reasons = async (ctx: APIRequestContext) => (await inbox(ctx)).notifications.map((n) => [n.reason, n.issueNumber]);

test("people hear about mentions, comments, review requests, reviews, merges and assignments on what they follow", async ({ page }, info) => {
  const admin = await loginAdmin();
  const owner = await createUser(admin);
  const dev = await createUser(admin);
  const reader = await createUser(admin);
  const outsider = await createUser(admin);
  const repo = await createRepo(owner.ctx, unique("inbox"));
  const api = `/api/repos/${owner.username}/${repo}`;
  await owner.ctx.put(`${api}/collaborators/${dev.username}`, { data: { role: "write" }, headers: headers() });
  await owner.ctx.put(`${api}/collaborators/${reader.username}`, { data: { role: "read" }, headers: headers() });

  // A mention reaches people who can read the repository, not outsiders, and not inside code.
  const body = `@${dev.username} can you look? cc @${outsider.username}, and not \`@${reader.username}\``;
  const { issue } = await (await owner.ctx.post(`${api}/issues`, { data: { title: "Broken build", body }, headers: headers() })).json();
  expect(await reasons(dev.ctx)).toEqual([["mention", issue.number]]);
  expect(await reasons(outsider.ctx)).toEqual([]);
  expect(await reasons(reader.ctx)).toEqual([]);

  // Comments reach the participants, not the commenter; a second one updates the same unread entry.
  await reader.ctx.post(`${api}/issues/${issue.number}/comments`, { data: { body: "Same here." }, headers: headers() });
  await reader.ctx.post(`${api}/issues/${issue.number}/comments`, { data: { body: "Still broken on main." }, headers: headers() });
  const ownerInbox = await inbox(owner.ctx);
  expect(ownerInbox.notifications.map((n) => [n.reason, n.actor, n.excerpt])).toEqual([["comment", reader.username, "Still broken on main."]]);
  expect(await reasons(reader.ctx)).toEqual([]);

  // Assigning someone tells them.
  await owner.ctx.put(`${api}/issues/${issue.number}/assignees`, { data: { assignees: [reader.username] }, headers: headers() });
  expect(await reasons(reader.ctx)).toEqual([["assigned", issue.number]]);

  // The bell shows the count; opening the issue from the inbox reads it.
  await uiLogin(page, dev.username, dev.password);
  await expect(page.getByRole("link", { name: "Notifications, 1 unread" })).toBeVisible();
  await page.getByRole("link", { name: "Notifications, 1 unread" }).click();
  const list = page.getByRole("list", { name: "Notifications" });
  await expect(list).toContainText(`${owner.username} mentioned you`);
  await info.attach("inbox", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  await list.getByRole("link", { name: "Broken build" }).click();
  await expect(page.getByRole("heading", { name: /Broken build/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Notifications", exact: true })).toBeVisible();
  expect((await inbox(dev.ctx)).unread).toBe(0);

  // Pull requests: a review request, the review back to the author, and the merge to those who took part.
  const src = workdir();
  gitOk(src, ["init", "-q"]);
  writeFileSync(join(src, "a.txt"), "a\n");
  gitOk(src, ["add", "-A"]);
  gitOk(src, ["commit", "-q", "-m", "base"]);
  gitOk(src, ["checkout", "-q", "-b", "fix"]);
  writeFileSync(join(src, "a.txt"), "b\n");
  gitOk(src, ["commit", "-qam", "fix"]);
  gitOk(src, ["push", "-q", cloneUrl(owner.username, repo), "main", "fix"], { username: owner.username, token: owner.token });
  const { pull } = await (await owner.ctx.post(`${api}/pulls`, { data: { title: "Fix build", body: "", base: "main", head: "fix" }, headers: headers() })).json();
  await owner.ctx.put(`${api}/pulls/${pull.number}/reviewers`, { data: { reviewers: [dev.username] }, headers: headers() });
  // Asking again doesn't add another.
  await owner.ctx.put(`${api}/pulls/${pull.number}/reviewers`, { data: { reviewers: [dev.username] }, headers: headers() });
  expect(await reasons(dev.ctx)).toEqual([["review_requested", pull.number]]);
  await dev.ctx.post(`${api}/pulls/${pull.number}/reviews`, { data: { state: "approved", body: "Looks good" }, headers: headers() });
  expect((await reasons(owner.ctx))[0]).toEqual(["review", pull.number]);
  await owner.ctx.post(`${api}/pulls/${pull.number}/merge`, { headers: headers() });
  expect((await reasons(dev.ctx)).filter(([r]) => r === "merged")).toEqual([["merged", pull.number]]);

  // Read, unread again, and mark all read; nobody can touch someone else's.
  const [first] = (await inbox(owner.ctx)).notifications;
  expect((await owner.ctx.patch(`/api/me/notifications/${first.id}`, { data: { read: true }, headers: headers() })).ok()).toBe(true);
  expect((await dev.ctx.patch(`/api/me/notifications/${first.id}`, { data: { read: false }, headers: headers() })).status()).toBe(404);
  expect((await owner.ctx.patch(`/api/me/notifications/${first.id}`, { data: { read: false }, headers: headers() })).ok()).toBe(true);
  expect((await inbox(owner.ctx)).notifications.some((n) => n.id === first.id)).toBe(true);
  await owner.ctx.post("/api/me/notifications/read", { headers: headers() });
  expect((await inbox(owner.ctx)).unread).toBe(0);
  expect((await inbox(owner.ctx, true)).notifications.length).toBeGreaterThan(0);

  // Losing access hides what's there.
  await owner.ctx.delete(`${api}/collaborators/${reader.username}`, { headers: headers() });
  expect(await inbox(reader.ctx, true)).toEqual({ notifications: [], unread: 0, next: null });
});
