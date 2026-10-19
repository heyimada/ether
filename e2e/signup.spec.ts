import { expect, test } from "@playwright/test";
import { ADMIN, baseURL, unique, uiLogin } from "./helpers";

test("a friend joins through an invite link made in Admin and lands signed in", async ({ page, browser }, info) => {
  await uiLogin(page, ADMIN.username, ADMIN.password);
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Admin" }).click();
  await page.getByRole("button", { name: "Create invite link" }).click();
  const link = (await page.getByLabel("Invite link").textContent())!.trim();
  expect(link).toContain("/register?code=");

  // The friend has never signed in: the front page sends them to sign in, which points at invites.
  const ctx = await browser.newContext();
  const friend = await ctx.newPage();
  await friend.goto(`${baseURL()}/`);
  await expect(friend).toHaveURL(/\/login/);
  await expect(friend.getByText(/invite-only/i)).toBeVisible();
  await info.attach("landing", { body: await friend.screenshot({ fullPage: true }), contentType: "image/png" });

  // The link goes to whatever public URL the server was given; follow its path on this server.
  await friend.goto(`${baseURL()}${new URL(link).pathname}${new URL(link).search}`);
  await expect(friend.getByLabel("Invite code")).not.toHaveValue("");
  await info.attach("register", { body: await friend.screenshot({ fullPage: true }), contentType: "image/png" });
  const username = unique("friend").slice(0, 30);
  await friend.getByLabel("Username").fill(username);
  await friend.getByLabel("Password").fill("friend-password-123");
  await friend.getByRole("button", { name: "Create account" }).click();

  await expect(friend.getByRole("heading", { name: `Welcome, ${username}` })).toBeVisible();
  await expect(friend.getByRole("button", { name: "Account menu" })).toBeVisible();

  // The same link cannot make a second account.
  const other = await (await browser.newContext()).newPage();
  await other.goto(`${baseURL()}${new URL(link).pathname}${new URL(link).search}`);
  await other.getByLabel("Username").fill(unique("second").slice(0, 30));
  await other.getByLabel("Password").fill("friend-password-123");
  await other.getByRole("button", { name: "Create account" }).click();
  await expect(other.getByRole("alert")).toContainText(/invite/i);
  await ctx.close();
});
