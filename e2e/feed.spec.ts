import { expect, test, type APIRequestContext } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseURL, cloneUrl, createRepo, createUser, gitOk, loginAdmin, uiLogin, unique, workdir } from "./helpers";

const headers = () => ({ Origin: baseURL() });
const feedJson = async (ctx: APIRequestContext) => JSON.stringify(await (await ctx.get("/api/feed")).json());

// Commits each subject as its own commit and pushes; pass a directory to continue its history.
function pushCommits(owner: string, repo: string, auth: { username: string; token: string }, subjects: string[], branch = "main", existing?: string) {
  const dir = existing ?? workdir();
  if (!existing) gitOk(dir, ["init", "-q"]);
  for (const s of subjects) {
    writeFileSync(join(dir, `${unique("f")}.txt`), s);
    gitOk(dir, ["add", "-A"]);
    gitOk(dir, ["commit", "-q", "-m", s]);
  }
  gitOk(dir, ["push", "-q", cloneUrl(owner, repo), `HEAD:${branch}`], auth);
  return dir;
}

test("the dashboard feed shows what happened in repositories you can read, and nothing from the rest", async ({ page }, info) => {
  const admin = await loginAdmin();
  const ada = await createUser(admin);
  const bob = await createUser(admin);
  const outsider = await createUser(admin);
  const shared = await createRepo(ada.ctx, unique("shared"));
  const secret = await createRepo(ada.ctx, unique("secret"));
  const api = `/api/repos/${ada.username}/${shared}`;
  await ada.ctx.put(`${api}/collaborators/${bob.username}`, { data: { role: "write" }, headers: headers() });
  const auth = { username: ada.username, token: ada.token };

  // A push of four commits: the feed says how many and shows the newest subjects.
  const src = pushCommits(ada.username, shared, auth, ["Teach the mill to carry", "Add the store", "Print results", "Tidy the printer"]);
  // Things in a repository bob can't see, with names that must never reach him.
  const classified = unique("classified-subject");
  const hiddenIssue = unique("hidden-issue");
  pushCommits(ada.username, secret, auth, [classified]);
  await ada.ctx.post(`/api/repos/${ada.username}/${secret}/issues`, { data: { title: hiddenIssue, body: "" }, headers: headers() });

  // Issues, comments, a reviewed and merged pull request, a release, a star and a wiki page.
  const { issue } = await (await bob.ctx.post(`${api}/issues`, { data: { title: "Printer jams on long numbers", body: "" }, headers: headers() })).json();
  await ada.ctx.post(`${api}/issues/${issue.number}/comments`, { data: { body: "Reproduced with 31 digits." }, headers: headers() });
  await ada.ctx.patch(`${api}/issues/${issue.number}`, { data: { state: "closed" }, headers: headers() });
  gitOk(src, ["checkout", "-q", "-b", "faster"]);
  pushCommits(ada.username, shared, auth, ["Cache store lookups"], "faster", src);
  const { pull } = await (await ada.ctx.post(`${api}/pulls`, { data: { title: "Faster store", body: "", base: "main", head: "faster" }, headers: headers() })).json();
  expect((await bob.ctx.post(`${api}/pulls/${pull.number}/reviews`, { data: { state: "approved", body: "Ship it" }, headers: headers() })).ok()).toBe(true);
  expect((await ada.ctx.post(`${api}/pulls/${pull.number}/merge`, { data: {}, headers: headers() })).ok()).toBe(true);
  await ada.ctx.post(`${api}/releases`, { data: { tag: "v1.0.0", target: "main", title: "First light" }, headers: headers() });
  await bob.ctx.put(`${api}/star`, { headers: headers() });
  await ada.ctx.put(`${api}/wiki/Setup-guide`, { data: { title: "Setup guide", content: "# Setup\n" }, headers: headers() });

  await uiLogin(page, bob.username, bob.password);
  const feed = page.getByRole("region", { name: "Feed" });
  const item = (text: string | RegExp) => feed.getByRole("listitem").filter({ hasText: text }).first();
  await expect(item(/pushed 4 commits to main/)).toContainText(`${ada.username}/${shared}`);
  await expect(item(/pushed 4 commits to main/)).toContainText("Tidy the printer");
  await expect(item(/opened issue/).filter({ hasText: "Printer jams on long numbers" })).toContainText(bob.username);
  await expect(item(/commented on/)).toContainText("Reproduced with 31 digits.");
  await expect(item(/closed issue/)).toContainText("Printer jams on long numbers");
  await expect(item(/approved/)).toContainText("Faster store");
  await expect(item(/merged pull request/)).toContainText("Faster store");
  await expect(item(/published release/)).toContainText("First light");
  await expect(item(/starred/)).toContainText(`${ada.username}/${shared}`);
  await expect(item(/wiki page/)).toContainText("Setup guide");
  await expect(item(/created repository/).filter({ hasText: shared })).toBeVisible();
  // Grouped by day, newest first: the wiki page was the last thing that happened.
  await expect(feed.getByRole("heading", { name: "Today" })).toBeVisible();
  await expect(feed.getByRole("listitem").first()).toContainText("Setup guide");
  for (const leak of [secret, classified, hiddenIssue]) await expect(page.getByRole("main")).not.toContainText(leak);
  const bobs = await feedJson(bob.ctx);
  for (const leak of [secret, classified, hiddenIssue]) expect(bobs).not.toContain(leak);
  await info.attach("feed", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await info.attach("feed-375", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

  // Someone with no access to either repository sees none of it.
  const theirs = await feedJson(outsider.ctx);
  for (const leak of [shared, secret, classified, hiddenIssue, "Printer jams on long numbers"]) expect(theirs).not.toContain(leak);

  // Visibility is checked when the feed is read: a repository going private takes its history with it.
  const open = unique("open");
  await ada.ctx.post("/api/repos", { data: { name: open, visibility: "public" }, headers: headers() });
  pushCommits(ada.username, open, auth, ["Public work"]);
  expect(await feedJson(outsider.ctx)).toContain(open);
  await ada.ctx.patch(`/api/repos/${ada.username}/${open}`, { data: { visibility: "private" }, headers: headers() });
  expect(await feedJson(outsider.ctx)).not.toContain(open);
  // Losing access does the same.
  await ada.ctx.delete(`${api}/collaborators/${bob.username}`, { headers: headers() });
  expect(await feedJson(bob.ctx)).not.toContain(shared);
});

test("your work: assigned issues, your pull requests with their review state, stars, and no empty panels", async ({ page }, info) => {
  const admin = await loginAdmin();
  const ada = await createUser(admin);
  const bob = await createUser(admin);
  const repo = await createRepo(ada.ctx, unique("work"));
  const api = `/api/repos/${ada.username}/${repo}`;
  await ada.ctx.put(`${api}/collaborators/${bob.username}`, { data: { role: "write" }, headers: headers() });

  // Someone with nothing going on gets no empty boxes.
  await uiLogin(page, bob.username, bob.password);
  for (const panel of ["Assigned to you", "Your pull requests", "Recently starred", "Waiting for your review"])
    await expect(page.getByRole("region", { name: panel })).toHaveCount(0);

  const title = unique("Carry overflows");
  const { issue } = await (await ada.ctx.post(`${api}/issues`, { data: { title, body: "" }, headers: headers() })).json();
  await ada.ctx.put(`${api}/issues/${issue.number}/assignees`, { data: { assignees: [bob.username] }, headers: headers() });
  const dir = pushCommits(ada.username, repo, { username: ada.username, token: ada.token }, ["base"]);
  gitOk(dir, ["checkout", "-q", "-b", "fix"]);
  pushCommits(ada.username, repo, { username: bob.username, token: bob.token }, ["fix carry"], "fix", dir);
  const prTitle = unique("Fix the carry");
  const { pull } = await (await bob.ctx.post(`${api}/pulls`, { data: { title: prTitle, body: "", base: "main", head: "fix" }, headers: headers() })).json();
  await ada.ctx.post(`${api}/pulls/${pull.number}/reviews`, { data: { state: "changes_requested", body: "Needs a test" }, headers: headers() });
  await bob.ctx.put(`${api}/star`, { headers: headers() });

  await page.reload();
  await expect(page.getByRole("region", { name: "Assigned to you" })).toContainText(title);
  await expect(page.getByRole("region", { name: "Your pull requests" }).getByRole("listitem").filter({ hasText: prTitle })).toContainText("Changes requested");
  await expect(page.getByRole("region", { name: "Recently starred" })).toContainText(`${ada.username}/${repo}`);
  await info.attach("your-work", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

  // Closing the issue takes it off the list; an approval updates the pull request.
  await ada.ctx.patch(`${api}/issues/${issue.number}`, { data: { state: "closed" }, headers: headers() });
  await ada.ctx.post(`${api}/pulls/${pull.number}/reviews`, { data: { state: "approved", body: "" }, headers: headers() });
  await page.reload();
  await expect(page.getByRole("region", { name: "Your pull requests" }).getByRole("listitem").filter({ hasText: prTitle })).toContainText("Approved");
  await expect(page.getByRole("region", { name: "Assigned to you" })).toHaveCount(0);

  // Everything in "your work" goes away with access to the repository.
  const reopened = unique("Reopened");
  const second = await (await ada.ctx.post(`${api}/issues`, { data: { title: reopened, body: "" }, headers: headers() })).json();
  await ada.ctx.put(`${api}/issues/${second.issue.number}/assignees`, { data: { assignees: [bob.username] }, headers: headers() });
  expect(JSON.stringify(await (await bob.ctx.get("/api/me/work")).json())).toContain(reopened);
  await ada.ctx.delete(`${api}/collaborators/${bob.username}`, { headers: headers() });
  const after = JSON.stringify(await (await bob.ctx.get("/api/me/work")).json());
  for (const leak of [repo, reopened, prTitle]) expect(after).not.toContain(leak);
});
