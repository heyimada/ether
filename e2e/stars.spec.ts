import { expect, test } from "@playwright/test";
import { baseURL, createRepo, createUser, loginAdmin, uiLogin, unique } from "./helpers";

const headers = () => ({ Origin: baseURL() });

test("people star repositories they can see; profiles list stars the viewer can read", async ({ page, browser }, info) => {
  const admin = await loginAdmin();
  const owner = await createUser(admin);
  const fan = await createUser(admin);
  const name = unique("starry");
  await owner.ctx.post("/api/repos", { data: { name, visibility: "public" }, headers: headers() });
  const hidden = await createRepo(owner.ctx, unique("hidden"));

  await uiLogin(page, fan.username, fan.password);
  await page.goto(`${baseURL()}/${owner.username}/${name}`);
  const star = page.getByRole("button", { name: /^Star/ });
  await expect(star).toContainText("0");
  await star.click();
  await expect(page.getByRole("button", { name: /^Unstar/ })).toContainText("1");
  await info.attach("starred", { body: await page.screenshot(), contentType: "image/png" });

  // Starring a repository you can't read is impossible.
  expect((await fan.ctx.put(`/api/repos/${owner.username}/${hidden}/star`, { headers: headers() })).status()).toBe(404);

  await page.goto(`${baseURL()}/${fan.username}?tab=stars`);
  await expect(page.getByRole("list", { name: "Starred repositories" })).toContainText(`${owner.username}/${name}`);
  await expect(page.getByRole("link", { name: /^Stars/ })).toContainText("1");

  // Someone who can't read it anymore doesn't see it among the fan's stars.
  expect((await owner.ctx.patch(`/api/repos/${owner.username}/${name}`, { data: { visibility: "private" }, headers: headers() })).ok()).toBe(true);
  const third = await createUser(admin);
  const ctx = await browser.newContext();
  const other = await ctx.newPage();
  await uiLogin(other, third.username, third.password);
  await other.goto(`${baseURL()}/${fan.username}?tab=stars`);
  await expect(other.getByRole("main")).not.toContainText(name);
  await ctx.close();

  // The owner still sees the count, and unstarring brings it back down.
  await owner.ctx.patch(`/api/repos/${owner.username}/${name}`, { data: { visibility: "public" }, headers: headers() });
  await page.goto(`${baseURL()}/${owner.username}/${name}`);
  await page.getByRole("button", { name: /^Unstar/ }).click();
  await expect(page.getByRole("button", { name: /^Star/ })).toContainText("0");
});
