import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseURL, cloneUrl, createRepo, createUser, gitOk, loginAdmin, uiLogin, unique, workdir } from "./helpers";

const headers = () => ({ Origin: baseURL() });

test("stacked pull requests show their stack, move down when the one below merges, and can change base", async ({ page }, info) => {
  const admin = await loginAdmin();
  const author = await createUser(admin);
  const reader = await createUser(admin);
  const repo = await createRepo(author.ctx, unique("stack"));
  const api = `/api/repos/${author.username}/${repo}`;
  await author.ctx.put(`${api}/collaborators/${reader.username}`, { data: { role: "read" }, headers: headers() });

  // main ← a ← b ← c, one file each.
  const src = workdir();
  gitOk(src, ["init", "-q"]);
  writeFileSync(join(src, "base.txt"), "base\n");
  gitOk(src, ["add", "-A"]);
  gitOk(src, ["commit", "-q", "-m", "base"]);
  for (const [branch, from] of [["a", "main"], ["b", "a"], ["c", "b"]]) {
    gitOk(src, ["checkout", "-q", "-b", branch, from]);
    writeFileSync(join(src, `${branch}.txt`), `${branch}\n`);
    gitOk(src, ["add", "-A"]);
    gitOk(src, ["commit", "-q", "-m", `add ${branch}`]);
  }
  gitOk(src, ["push", "-q", cloneUrl(author.username, repo), "main", "a", "b", "c"], { username: author.username, token: author.token });
  const open = async (title: string, base: string, head: string) =>
    (await (await author.ctx.post(`${api}/pulls`, { data: { title, body: "", base, head }, headers: headers() })).json()).pull.number as number;
  const one = await open("Add a", "main", "a");
  const two = await open("Add b", "a", "b");
  const three = await open("Add c", "b", "c");
  const get = async (n: number) => (await author.ctx.get(`${api}/pulls/${n}`)).json();

  // Every pull request in the stack sees all of it, bottom first, and only its own changes.
  for (const n of [one, two, three]) expect((await get(n)).stack.map((p: { number: number }) => p.number)).toEqual([one, two, three]);
  expect((await get(two)).commits.map((c: { subject: string }) => c.subject)).toEqual(["add b"]);

  await uiLogin(page, author.username, author.password);
  await page.goto(`${baseURL()}/${author.username}/${repo}/pull/${two}`);
  const stack = page.getByRole("list", { name: "Stack" });
  await expect(stack.getByRole("listitem")).toHaveText([`#${one}Add a`, `#${two}Add b`, `#${three}Add c`]);
  await expect(stack.locator("[aria-current=page]")).toContainText("Add b");
  await expect(page.getByText(`Stacked on #${one}`)).toBeVisible();
  await info.attach("stack", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

  // Merging the bottom one moves the next one onto main; its diff is still just its own change.
  const merged = await (await author.ctx.post(`${api}/pulls/${one}/merge`, { headers: headers() })).json();
  expect(merged.retargeted).toEqual([two]);
  const after = await get(two);
  expect(after.pull.base).toBe("main");
  expect(after.commits.map((c: { subject: string }) => c.subject)).toEqual(["add b"]);
  expect(after.stack.map((p: { number: number }) => p.number)).toEqual([two, three]);
  expect((await get(three)).pull.base).toBe("b");

  // Change base from the header: c straight onto main brings b's commit along.
  await page.goto(`${baseURL()}/${author.username}/${repo}/pull/${three}`);
  await page.getByRole("button", { name: "Change base" }).click();
  await page.getByLabel("Base branch").selectOption("main");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("wants to merge c into main")).toBeVisible();
  expect((await get(three)).commits).toHaveLength(2);
  expect((await get(three)).stack).toEqual([]);

  // What a base can't be, and who can't change it.
  const setBase = (ctx: typeof author.ctx, n: number, base: string) => ctx.patch(`${api}/issues/${n}`, { data: { base }, headers: headers() });
  expect((await setBase(author.ctx, three, "c")).status()).toBe(400);
  expect((await setBase(author.ctx, three, "nope")).status()).toBe(400);
  expect((await setBase(reader.ctx, three, "b")).status()).toBe(403);
  expect((await setBase(author.ctx, one, "b")).status()).toBe(409);
  expect((await setBase(author.ctx, three, "b")).ok()).toBe(true);
  expect((await get(three)).stack.map((p: { number: number }) => p.number)).toEqual([two, three]);
});
