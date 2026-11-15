import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseURL, cloneUrl, createRepo, createToken, createUser, gitOk, loginAdmin, uiLogin, unique, workdir } from "./helpers";

const headers = () => ({ Origin: baseURL() });

test("a second branch can be created from the branch picker, and the API checks what push would", async ({ page }, info) => {
  const admin = await loginAdmin();
  const owner = await createUser(admin);
  const reader = await createUser(admin);
  const auth = { username: owner.username, token: await createToken(owner.ctx) };
  const repo = await createRepo(owner.ctx, unique("branches"));
  const api = `/api/repos/${owner.username}/${repo}`;
  await owner.ctx.put(`${api}/collaborators/${reader.username}`, { data: { role: "read" }, headers: headers() });

  const src = workdir();
  gitOk(src, ["init", "-q", "-b", "main"]);
  writeFileSync(join(src, "a.txt"), "a\n");
  gitOk(src, ["add", "-A"]);
  gitOk(src, ["commit", "-q", "-m", "a"]);
  gitOk(src, ["tag", "v1"]);
  gitOk(src, ["push", "-q", cloneUrl(owner.username, repo), "main", "v1"], auth);
  const sha = gitOk(src, ["rev-parse", "HEAD"]).trim();

  // Typing a name that isn't a branch yet offers to create it from the ref being viewed.
  await uiLogin(page, owner.username, owner.password);
  await page.goto(`${baseURL()}/${owner.username}/${repo}`);
  await page.getByRole("button", { name: /Switch branch or tag/ }).click();
  const picker = page.getByRole("dialog", { name: "Switch branch or tag" });
  await picker.getByRole("combobox").fill("feature/login");
  const create = picker.getByRole("option", { name: "Create branch feature/login from main" });
  await expect(create).toBeVisible();
  await info.attach("create-branch", { body: await page.screenshot(), contentType: "image/png" });
  await create.click();
  await expect(page).toHaveURL(`${baseURL()}/${owner.username}/${repo}/tree/feature/login`);
  await expect(page.getByRole("link", { name: "a.txt" })).toBeVisible();

  // The picker now lists both, and a third one goes just the same. (Wait for the new branch's own page:
  // the old one stays up until it has loaded.)
  await page.getByRole("button", { name: "Switch branch or tag, current feature/login" }).click();
  await expect(picker.getByRole("option", { name: /main.*default/ })).toBeVisible();
  await expect(picker.getByRole("option", { name: "feature/login" })).toBeVisible();
  await picker.getByRole("combobox").fill("docs");
  await picker.getByRole("option", { name: "Create branch docs from feature/login" }).click();
  await expect(page).toHaveURL(`${baseURL()}/${owner.username}/${repo}/tree/docs`);
  expect((await (await owner.ctx.get(api)).json()).branches.sort()).toEqual(["docs", "feature/login", "main"]);

  // A name that already exists, or clashes with one, is refused; so is one git wouldn't take.
  await page.getByRole("button", { name: "Switch branch or tag, current docs" }).click();
  await picker.getByRole("combobox").fill("feature/login/x");
  await picker.getByRole("option", { name: /Create branch feature\/login\/x/ }).click();
  await expect(picker.getByRole("alert")).toContainText("feature/login/x clashes with an existing branch");
  // The error belongs to that name: typing another one, or closing the picker, clears it.
  await picker.getByRole("combobox").fill("feature/other");
  await expect(picker.getByRole("alert")).toHaveCount(0);
  const post = (data: object, ctx = owner.ctx) => ctx.post(`${api}/branches`, { data, headers: headers() });
  expect((await post({ name: "docs", from: "main" })).status()).toBe(409);
  for (const name of ["a..b", "-x", "HEAD", "x.lock", "a b"]) expect((await post({ name, from: "main" })).status(), name).toBe(400);
  expect((await post({ name: "y", from: "nope" })).status()).toBe(400);
  // Revision syntax isn't a starting point, even where history would let it resolve.
  writeFileSync(join(src, "b.txt"), "b\n");
  gitOk(src, ["add", "-A"]);
  gitOk(src, ["commit", "-q", "-m", "b"]);
  gitOk(src, ["push", "-q", cloneUrl(owner.username, repo), "main"], auth);
  for (const from of ["main~1", "main^", "main@{1}", "main^{/a}"]) expect((await post({ name: "y", from })).status(), from).toBe(400);
  // Tags and full commit ids work as starting points.
  expect((await post({ name: "from-tag", from: "v1" })).ok()).toBe(true);
  expect((await post({ name: "from-sha", from: sha })).ok()).toBe(true);
  // Readers can't create branches, and don't get the offer.
  expect((await post({ name: "z", from: "main" }, reader.ctx)).status()).toBe(403);
  await uiLogin(page, reader.username, reader.password);
  await page.goto(`${baseURL()}/${owner.username}/${repo}`);
  await page.getByRole("button", { name: /Switch branch or tag/ }).click();
  await picker.getByRole("combobox").fill("reader-branch");
  await expect(picker.getByRole("option")).toHaveCount(0);

  // Branch protection applies as it would to a push that creates the branch.
  expect((await owner.ctx.post(`${api}/branch-protection`, { data: { pattern: "release/*", requirePullRequest: true, allowDeletion: true }, headers: headers() })).ok()).toBe(true);
  const refused = await post({ name: "release/1", from: "main" });
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error).toContain("release/1 is protected");

  // In a repository with only tags, the first branch becomes the default, as after a push.
  const tagsOnly = await createRepo(owner.ctx, unique("tags-only"));
  gitOk(src, ["push", "-q", cloneUrl(owner.username, tagsOnly), "v1"], auth);
  const first = await owner.ctx.post(`/api/repos/${owner.username}/${tagsOnly}/branches`, { data: { name: "dev", from: "v1" }, headers: headers() });
  expect(first.ok(), await first.text()).toBe(true);
  expect((await (await owner.ctx.get(`/api/repos/${owner.username}/${tagsOnly}`)).json()).repo.defaultBranch).toBe("dev");

  // Creating a branch is news in the activity feed, like pushing one.
  const { events } = await (await owner.ctx.get("/api/feed")).json();
  expect(events.some((e: { kind: string; repo: string; payload: { ref?: string; created?: boolean } }) => e.kind === "push" && e.repo === repo && e.payload.ref === "feature/login" && e.payload.created)).toBe(true);
});
