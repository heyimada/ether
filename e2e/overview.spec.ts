import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseURL, cloneUrl, createRepo, createUser, gitOk, loginAdmin, uiLogin, unique, workdir } from "./helpers";

const headers = () => ({ Origin: baseURL() });
const as = (email: string) => ({ GIT_AUTHOR_NAME: "Someone", GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: "Someone", GIT_COMMITTER_EMAIL: email });

function push(owner: string, repo: string, auth: { username: string; token: string }, files: Record<string, string>, email = "e2e@ether.test", branch = "main", dir?: string) {
  const src = dir ?? workdir();
  if (!dir) gitOk(src, ["init", "-q"]);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(src, name), content);
    gitOk(src, ["add", "-A"]);
    gitOk(src, ["commit", "-q", "-m", `add ${name}`], undefined, as(email));
  }
  gitOk(src, ["push", "-q", cloneUrl(owner, repo), `HEAD:${branch}`], auth);
  return src;
}

test("a profile without pins shows popular repositories, a yearly summary and recent activity the viewer may see", async ({ page, browser }, info) => {
  const admin = await loginAdmin();
  const owner = await createUser(admin);
  const viewer = await createUser(admin);
  const fan = await createUser(admin);
  const popular = unique("popular");
  const quiet = unique("quiet");
  await owner.ctx.post("/api/repos", { data: { name: popular, visibility: "public", description: "Everyone likes this" }, headers: headers() });
  await owner.ctx.post("/api/repos", { data: { name: quiet, visibility: "public" }, headers: headers() });
  const secret = await createRepo(owner.ctx, unique("secret"));
  await viewer.ctx.put(`/api/repos/${owner.username}/${popular}/star`, { headers: headers() });
  await fan.ctx.put(`/api/repos/${owner.username}/${popular}/star`, { headers: headers() });
  const auth = { username: owner.username, token: owner.token };
  const email = `${owner.username}@home.test`;
  await owner.ctx.put("/api/me/emails", { data: { emails: [email] }, headers: headers() });

  // In the last year: three commits, one issue, one pull request and one review the viewer can see,
  // plus work in a private repository they can't.
  const src = push(owner.username, popular, auth, { "a.ts": "export const a = 1;\n", "b.ts": "export const b = 2;\n", "c.ts": "export const c = 3;\n" }, email);
  // Commits count once they are on the default branch, so this one doesn't yet.
  push(owner.username, popular, auth, { "d.ts": "export const d = 4;\n" }, email, "topic", src);
  await owner.ctx.post(`/api/repos/${owner.username}/${popular}/issues`, { data: { title: "Public plan", body: "" }, headers: headers() });
  await owner.ctx.post(`/api/repos/${owner.username}/${popular}/pulls`, { data: { title: "Topic work", body: "", base: "main", head: "topic" }, headers: headers() });
  const theirSrc = push(owner.username, quiet, auth, { "q.md": "# quiet\n" });
  await owner.ctx.put(`/api/repos/${owner.username}/${quiet}/collaborators/${fan.username}`, { data: { role: "write" }, headers: headers() });
  push(owner.username, quiet, { username: fan.username, token: fan.token }, { "f.md": "fan\n" }, "fan@ether.test", "fan", theirSrc);
  const fanPull = await (await fan.ctx.post(`/api/repos/${owner.username}/${quiet}/pulls`, { data: { title: "Fan work", body: "", base: "main", head: "fan" }, headers: headers() })).json();
  await owner.ctx.post(`/api/repos/${owner.username}/${quiet}/pulls/${fanPull.pull.number}/reviews`, { data: { state: "approved", body: "" }, headers: headers() });
  push(owner.username, secret, auth, { "s.txt": "s\n" }, email);
  const hidden = unique("Hidden plan");
  await owner.ctx.post(`/api/repos/${owner.username}/${secret}/issues`, { data: { title: hidden, body: "" }, headers: headers() });

  await uiLogin(page, viewer.username, viewer.password);
  await page.goto(`${baseURL()}/${owner.username}`);
  const popularList = page.getByRole("list", { name: "Popular repositories" }).getByRole("listitem");
  await expect(popularList).toHaveCount(2);
  await expect(popularList.first()).toContainText(popular);
  await expect(popularList.first()).toContainText("TypeScript");
  const summary = page.getByRole("list", { name: "Contribution summary" });
  await expect(summary.getByRole("listitem")).toHaveText([/^3 commits/, /^1 pull request/, /^1 issue/, /^1 review/]);
  await expect(page.getByRole("list", { name: "Recent activity" })).toContainText(/pushed .* to main/);
  await expect(page.getByRole("list", { name: "Recent activity" })).toContainText("Public plan");
  for (const leak of [secret, hidden]) await expect(page.getByRole("main")).not.toContainText(leak);
  const api = JSON.stringify(await (await viewer.ctx.get(`/api/users/${owner.username}/profile`)).json());
  for (const leak of [secret, hidden]) expect(api).not.toContain(leak);
  await info.attach("profile-overview", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // The owner sees their private work counted too.
  const ownCtx = await browser.newContext();
  const own = await ownCtx.newPage();
  await uiLogin(own, owner.username, owner.password);
  await own.goto(`${baseURL()}/${owner.username}`);
  await expect(own.getByRole("list", { name: "Contribution summary" }).getByRole("listitem")).toHaveText([/^4 commits/, /^1 pull request/, /^2 issues/, /^1 review/]);
  await ownCtx.close();
});

test("an organization page shows its people, repositories with language and activity, only as far as the viewer can read", async ({ page, browser }, info) => {
  const admin = await loginAdmin();
  const founder = await createUser(admin);
  const member = await createUser(admin);
  const outsider = await createUser(admin);
  const org = unique("guild").slice(0, 30);
  await founder.ctx.post("/api/orgs", { data: { name: org }, headers: headers() });
  await founder.ctx.put(`/api/orgs/${org}/members/${member.username}`, { data: { role: "member" }, headers: headers() });
  await founder.ctx.post(`/api/orgs/${org}/teams`, { data: { name: "core" }, headers: headers() });
  const inner = unique("inner");
  const shown = unique("shown");
  await founder.ctx.post("/api/repos", { data: { name: inner, owner: org }, headers: headers() });
  await founder.ctx.post("/api/repos", { data: { name: shown, owner: org, visibility: "public" }, headers: headers() });
  const auth = { username: founder.username, token: founder.token };
  push(org, inner, auth, { "mill.py": "def mill():\n    return 1\n" });
  push(org, shown, auth, { "index.css": "body { margin: 0; }\n" });
  const secretIssue = unique("Inner issue");
  await founder.ctx.post(`/api/repos/${org}/${inner}/issues`, { data: { title: secretIssue, body: "" }, headers: headers() });

  await uiLogin(page, member.username, member.password);
  await page.goto(`${baseURL()}/${org}`);
  const people = page.getByRole("list", { name: "People" });
  await expect(people.getByRole("link", { name: founder.username })).toBeVisible();
  await expect(people.getByRole("link", { name: member.username })).toBeVisible();
  const repos = page.getByRole("list", { name: "Repositories" }).getByRole("listitem");
  await expect(repos.filter({ hasText: inner })).toContainText("Python");
  await expect(repos.filter({ hasText: shown })).toContainText("CSS");
  await expect(repos.filter({ hasText: inner })).toContainText(/Updated/);
  await expect(page.getByText("1 team")).toBeVisible();
  await expect(page.getByRole("list", { name: "Recent activity" })).toContainText(secretIssue);
  await info.attach("org-overview", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // Outsiders see the people and the public repository, nothing private and no teams.
  const ctx = await browser.newContext();
  const out = await ctx.newPage();
  await uiLogin(out, outsider.username, outsider.password);
  await out.goto(`${baseURL()}/${org}`);
  await expect(out.getByRole("list", { name: "People" }).getByRole("link", { name: founder.username })).toBeVisible();
  await expect(out.getByRole("list", { name: "Repositories" })).toContainText(shown);
  await expect(out.getByText(/\d+ teams?\b/)).toHaveCount(0);
  for (const leak of [inner, secretIssue]) await expect(out.getByRole("main")).not.toContainText(leak);
  const api = JSON.stringify(await (await outsider.ctx.get(`/api/users/${org}/profile`)).json());
  for (const leak of [inner, secretIssue]) expect(api).not.toContain(leak);
  await ctx.close();
});
