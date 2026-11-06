import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseURL, cloneUrl, createUser, gitOk, loginAdmin, uiLogin, unique, workdir } from "./helpers";

const headers = () => ({ Origin: baseURL() });

test("code owners are asked for a review and, when required, have to approve their files", async ({ page, browser }, info) => {
  const admin = await loginAdmin();
  const founder = await createUser(admin);
  const author = await createUser(admin);
  const dev = await createUser(admin);
  const org = unique("own").slice(0, 30);
  await founder.ctx.post("/api/orgs", { data: { name: org }, headers: headers() });
  const repo = unique("app");
  await founder.ctx.post("/api/repos", { data: { name: repo, owner: org }, headers: headers() });
  const api = `/api/repos/${org}/${repo}`;
  // The core team (author and dev) can write; founder owns the org.
  for (const m of [author, dev]) await founder.ctx.put(`/api/orgs/${org}/members/${m.username}`, { data: { role: "member" }, headers: headers() });
  expect((await founder.ctx.post(`/api/orgs/${org}/teams`, { data: { name: "core" }, headers: headers() })).ok()).toBe(true);
  for (const m of [author, dev]) await founder.ctx.put(`/api/orgs/${org}/teams/core/members/${m.username}`, { headers: headers() });
  await founder.ctx.put(`/api/orgs/${org}/teams/core/repos/${repo}`, { data: { role: "write" }, headers: headers() });
  // A team that can only read can't own files: it's listed, but neither asked nor counted.
  await founder.ctx.post(`/api/orgs/${org}/teams`, { data: { name: "viewers" }, headers: headers() });
  await founder.ctx.put(`/api/orgs/${org}/teams/viewers/members/${dev.username}`, { headers: headers() });
  await founder.ctx.put(`/api/orgs/${org}/teams/viewers/repos/${repo}`, { data: { role: "read" }, headers: headers() });

  const src = workdir();
  gitOk(src, ["init", "-q"]);
  mkdirSync(join(src, ".github"));
  mkdirSync(join(src, "docs"));
  mkdirSync(join(src, "src"));
  writeFileSync(join(src, ".github", "CODEOWNERS"), `# Owners\n*.ts @${org}/core\n/docs/ @${founder.username}\n*.md octo@example.com\n/README @${org}/viewers\n`);
  writeFileSync(join(src, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(src, "docs", "x.md"), "# Docs\n");
  writeFileSync(join(src, "README"), "hi\n");
  gitOk(src, ["add", "-A"]);
  gitOk(src, ["commit", "-q", "-m", "base"]);
  gitOk(src, ["checkout", "-q", "-b", "change"]);
  writeFileSync(join(src, "src", "a.ts"), "export const a = 2;\n");
  writeFileSync(join(src, "docs", "x.md"), "# Docs\n\nMore.\n");
  gitOk(src, ["commit", "-qam", "change"]);
  gitOk(src, ["checkout", "-q", "-b", "readme", "main"]);
  writeFileSync(join(src, "README"), "hello\n");
  gitOk(src, ["commit", "-qam", "readme"]);
  gitOk(src, ["push", "-q", cloneUrl(org, repo), "main", "change", "readme"], { username: founder.username, token: founder.token });
  expect((await founder.ctx.patch(api, { data: { requireCodeOwnerReview: true }, headers: headers() })).ok()).toBe(true);

  // Opening the pull request asks the core team (not the author, a member) and founder for docs.
  const { pull } = await (await author.ctx.post(`${api}/pulls`, { data: { title: "Change", body: "", base: "main", head: "change" }, headers: headers() })).json();
  let data = await (await author.ctx.get(`${api}/pulls/${pull.number}`)).json();
  expect(data.teamRequests).toEqual([`${org}/core`]);
  expect(data.reviewRequests).toEqual([founder.username]);
  expect(data.codeOwners.groups.map((g: { pattern: string; approvedBy: string | null }) => [g.pattern, g.approvedBy])).toEqual([
    ["*.ts", null],
    ["/docs/", null],
  ]);
  // A file no rule owns needs nobody.
  const plain = await (await author.ctx.post(`${api}/pulls`, { data: { title: "Readme", body: "", base: "main", head: "readme" }, headers: headers() })).json();
  const plainData = await author.ctx.get(`${api}/pulls/${plain.pull.number}`).then((r) => r.json());
  expect(plainData.codeOwners.groups.map((g: { pattern: string; owners: unknown }) => [g.pattern, g.owners])).toEqual([["/README", [{ name: `@${org}/viewers`, valid: false }]]]);
  expect(plainData.teamRequests).toEqual([]);

  // The team request reaches its members' dashboards, and the merge waits for both groups.
  const devPage = await (await browser.newContext()).newPage();
  await uiLogin(devPage, dev.username, dev.password);
  await expect(devPage.getByRole("region", { name: "Waiting for your review" })).toContainText("Change");
  const refused = await founder.ctx.post(`${api}/pulls/${pull.number}/merge`, { headers: headers() });
  expect(refused.status()).toBe(409);
  expect(await refused.text()).toContain("code owners of *.ts, /docs/");

  await uiLogin(page, author.username, author.password);
  await page.goto(`${baseURL()}/${org}/${repo}/pull/${pull.number}`);
  await expect(page.getByText("Waiting on code owners")).toBeVisible();
  await expect(page.getByRole("list", { name: "Code owners" })).toContainText(`@${org}/core`);
  await expect(page.getByRole("list", { name: "Reviewers" })).toContainText(`${org}/core`);
  await expect(page.getByRole("button", { name: "Merge pull request" })).toBeDisabled();
  await info.attach("waiting", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

  // A team member's approval covers the team's files and answers the team's request.
  expect((await dev.ctx.post(`${api}/pulls/${pull.number}/reviews`, { data: { state: "approved", body: "" }, headers: headers() })).ok()).toBe(true);
  data = await (await author.ctx.get(`${api}/pulls/${pull.number}`)).json();
  expect(data.teamRequests).toEqual([]);
  expect(data.codeOwners.groups.map((g: { approvedBy: string | null; fileCount: number }) => [g.approvedBy, g.fileCount])).toEqual([
    [dev.username, 1],
    [null, 1],
  ]);
  // A push afterwards doesn't ask the team again: a member's review answered it.
  gitOk(src, ["checkout", "-q", "change"]);
  writeFileSync(join(src, "src", "b.ts"), "export const b = 1;\n");
  gitOk(src, ["add", "-A"]);
  gitOk(src, ["commit", "-q", "-m", "b"]);
  gitOk(src, ["push", "-q", cloneUrl(org, repo), "change"], { username: founder.username, token: founder.token });
  await expect.poll(async () => (await (await author.ctx.get(`${api}/pulls/${pull.number}`)).json()).codeOwners.groups[0].fileCount).toBe(2);
  expect((await (await author.ctx.get(`${api}/pulls/${pull.number}`)).json()).teamRequests).toEqual([]);
  expect(await (await founder.ctx.post(`${api}/pulls/${pull.number}/merge`, { headers: headers() })).text()).toContain("code owners of /docs/");
  expect((await founder.ctx.post(`${api}/pulls/${pull.number}/reviews`, { data: { state: "approved", body: "" }, headers: headers() })).ok()).toBe(true);
  expect((await founder.ctx.post(`${api}/pulls/${pull.number}/merge`, { headers: headers() })).ok()).toBe(true);

  // The file view says who owns a file, and the CODEOWNERS file which of its lines are ignored.
  await page.goto(`${baseURL()}/${org}/${repo}/blob/main/src/a.ts`);
  await expect(page.getByLabel("Code owners")).toContainText(`Owned by @${org}/core`);
  await page.goto(`${baseURL()}/${org}/${repo}/blob/main/.github/CODEOWNERS`);
  await expect(page.getByRole("region", { name: "CODEOWNERS problems" })).toContainText("Line 4: octo@example.com: owners by email aren't supported");
});

test("a draft asks its code owners only once it's ready, and teams can be requested by hand", async () => {
  const admin = await loginAdmin();
  const founder = await createUser(admin);
  const author = await createUser(admin);
  const org = unique("dr").slice(0, 30);
  await founder.ctx.post("/api/orgs", { data: { name: org }, headers: headers() });
  const repo = unique("lib");
  await founder.ctx.post("/api/repos", { data: { name: repo, owner: org }, headers: headers() });
  const api = `/api/repos/${org}/${repo}`;
  await founder.ctx.put(`/api/orgs/${org}/members/${author.username}`, { data: { role: "member" }, headers: headers() });
  await founder.ctx.post(`/api/orgs/${org}/teams`, { data: { name: "writers" }, headers: headers() });
  await founder.ctx.put(`/api/orgs/${org}/teams/writers/members/${author.username}`, { headers: headers() });
  await founder.ctx.put(`/api/orgs/${org}/teams/writers/repos/${repo}`, { data: { role: "write" }, headers: headers() });
  const src = workdir();
  gitOk(src, ["init", "-q"]);
  writeFileSync(join(src, "CODEOWNERS"), `* @${founder.username}\n`);
  gitOk(src, ["add", "-A"]);
  gitOk(src, ["commit", "-q", "-m", "base"]);
  gitOk(src, ["checkout", "-q", "-b", "wip"]);
  writeFileSync(join(src, "b.txt"), "b\n");
  gitOk(src, ["add", "-A"]);
  gitOk(src, ["commit", "-q", "-m", "b"]);
  gitOk(src, ["push", "-q", cloneUrl(org, repo), "main", "wip"], { username: founder.username, token: founder.token });

  const { pull } = await (await author.ctx.post(`${api}/pulls`, { data: { title: "WIP", body: "", base: "main", head: "wip", draft: true }, headers: headers() })).json();
  const get = async () => (await author.ctx.get(`${api}/pulls/${pull.number}`)).json();
  expect((await get()).reviewRequests).toEqual([]);
  await author.ctx.patch(`${api}/issues/${pull.number}`, { data: { draft: false }, headers: headers() });
  expect((await get()).reviewRequests).toEqual([founder.username]);

  // Teams of the owning organization can be asked by hand; others can't.
  const set = (teams: string[]) => author.ctx.put(`${api}/pulls/${pull.number}/reviewers`, { data: { reviewers: [founder.username], teams }, headers: headers() });
  expect((await set([`${org}/writers`])).ok()).toBe(true);
  expect((await get()).teamRequests).toEqual([`${org}/writers`]);
  expect((await set(["someone-else/writers"])).status()).toBe(400);
  // The same team written two ways is asked once.
  expect((await set([`${org}/writers`, `@${org.toUpperCase()}/Writers`])).ok()).toBe(true);
  expect((await get()).teamRequests).toEqual([`${org}/writers`]);
  expect((await (await author.ctx.get(`${api}/assignable`)).json()).teams).toEqual([`${org}/writers`]);
  // Someone who can only read (here anyone, on a public repository) doesn't learn the organization's teams.
  const outsider = await createUser(admin);
  await founder.ctx.patch(api, { data: { visibility: "public" }, headers: headers() });
  expect((await (await outsider.ctx.get(`${api}/assignable`)).json()).teams).toEqual([]);
  // Nor which teams were asked to review, only how many.
  const seen = await (await outsider.ctx.get(`${api}/pulls/${pull.number}`)).json();
  expect([seen.teamRequests, seen.teamRequestCount]).toEqual([[], 1]);
});
