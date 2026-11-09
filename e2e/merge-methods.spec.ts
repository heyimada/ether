import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseURL, cloneUrl, createRepo, createUser, git, gitOk, loginAdmin, uiLogin, unique, workdir } from "./helpers";

const headers = () => ({ Origin: baseURL() });

test("pull requests squash or rebase onto their base, and the ones stacked on them follow", async ({ page }, info) => {
  const admin = await loginAdmin();
  const author = await createUser(admin);
  const repo = await createRepo(author.ctx, unique("methods"));
  const api = `/api/repos/${author.username}/${repo}`;
  const auth = { username: author.username, token: author.token };
  const remote = cloneUrl(author.username, repo);

  // main ← feat (two commits) ← upper (one); side (two commits) from main.
  const src = workdir();
  gitOk(src, ["init", "-q", "-b", "main"]);
  writeFileSync(join(src, "base.txt"), "base\n");
  gitOk(src, ["add", "-A"]);
  gitOk(src, ["commit", "-q", "-m", "base"]);
  const commit = (file: string, subject: string) => {
    writeFileSync(join(src, file), `${subject}\n`);
    gitOk(src, ["add", "-A"]);
    gitOk(src, ["commit", "-q", "-m", subject]);
  };
  gitOk(src, ["checkout", "-q", "-b", "feat"]);
  commit("f1.txt", "feat one");
  commit("f2.txt", "feat two");
  gitOk(src, ["checkout", "-q", "-b", "upper"]);
  commit("u.txt", "upper");
  gitOk(src, ["checkout", "-q", "-b", "side", "main"]);
  commit("s1.txt", "side one");
  commit("s2.txt", "side two");
  gitOk(src, ["push", "-q", remote, "main", "feat", "upper", "side"], auth);
  const open = async (title: string, base: string, head: string) =>
    (await (await author.ctx.post(`${api}/pulls`, { data: { title, body: "", base, head }, headers: headers() })).json()).pull.number as number;
  const feat = await open("Feature", "main", "feat");
  const upper = await open("Upper", "feat", "upper");
  const side = await open("Side", "main", "side");

  // The repository can turn merge commits off, but not every way to merge.
  expect((await author.ctx.patch(api, { data: { allowMergeCommit: false }, headers: headers() })).ok()).toBe(true);
  expect((await author.ctx.patch(api, { data: { allowSquashMerge: false, allowRebaseMerge: false }, headers: headers() })).status()).toBe(400);
  expect((await author.ctx.post(`${api}/pulls/${side}/merge`, { data: { method: "merge" }, headers: headers() })).status()).toBe(409);

  // Squash from the page, with an edited title; the branch is deleted, so the pull request on it moves to main.
  await uiLogin(page, author.username, author.password);
  await page.goto(`${baseURL()}/${author.username}/${repo}/pull/${feat}`);
  await page.getByLabel("Merge method").selectOption("squash");
  await page.getByLabel("Commit title").fill("Add the feature (#1)");
  await expect(page.getByRole("checkbox", { name: /Delete feat after merging/ })).toBeChecked();
  await info.attach("squash", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  await page.getByRole("button", { name: "Squash and merge" }).click();
  await expect(page.getByText("squashed and merged this pull request")).toBeVisible();

  const log = (rev: string) => {
    const dir = workdir();
    gitOk(dir, ["clone", "-q", remote, "w"], auth);
    return git(join(dir, "w"), ["log", "--format=%s|%P", `origin/${rev}`]).stdout.trim().split("\n").map((l) => [l.split("|")[0], l.split("|")[1].split(" ").length]);
  };
  expect(log("main")).toEqual([["Add the feature (#1)", 1], ["base", 1]]);
  // The merged pull request still shows the commits and changes it brought in.
  const merged = await (await author.ctx.get(`${api}/pulls/${feat}`)).json();
  expect([merged.pull.mergeMethod, merged.commits.length]).toEqual(["squash", 2]);

  // upper was moved onto main and made again on the squash commit: only its own change is left to merge.
  const moved = await (await author.ctx.get(`${api}/pulls/${upper}`)).json();
  expect(moved.pull.base).toBe("main");
  expect(moved.commits.map((c: { subject: string }) => c.subject)).toEqual(["upper"]);
  expect(moved.mergeable).toBe(true);
  expect(log("upper").map(([s]) => s)).toEqual(["upper", "Add the feature (#1)", "base"]);

  // Rebase keeps each commit, without a merge commit.
  const rebased = await (await author.ctx.post(`${api}/pulls/${side}/merge`, { data: { method: "rebase" }, headers: headers() })).json();
  expect(rebased.method).toBe("rebase");
  expect(log("main")).toEqual([["side two", 1], ["side one", 1], ["Add the feature (#1)", 1], ["base", 1]]);
});
