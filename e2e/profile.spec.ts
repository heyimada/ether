import { expect, test, type Page } from "@playwright/test";
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADMIN, baseURL, cloneUrl, createRepo, createUser, gitOk, loginAdmin, uiLogin, unique, workdir } from "./helpers";

// A tiny valid PNG (solid colour) so the upload path sees real image bytes.
function png(size = 8): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = Buffer.concat(Array.from({ length: size }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0x55)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

const origin = () => ({ Origin: baseURL() });

async function openMenu(page: Page) {
  await page.getByRole("button", { name: "Account menu" }).click();
  return page.getByRole("menu");
}

test("the account menu holds profile, settings, admin and sign out; new repository lives on the dashboard", async ({ page, browser }, info) => {
  await uiLogin(page, ADMIN.username, ADMIN.password);
  await expect(page.getByRole("banner").getByRole("link", { name: "New repository" })).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("link", { name: "New repository" })).toBeVisible();

  const menu = await openMenu(page);
  await expect(menu.getByRole("menuitem")).toHaveText([/Your profile/, /New organization/, /Settings/, /Admin/, /Sign out/]);
  await info.attach("menu", { body: await page.screenshot(), contentType: "image/png" });
  await menu.getByRole("menuitem", { name: /Your profile/ }).click();
  await expect(page).toHaveURL(`${baseURL()}/${ADMIN.username}`);

  // People who are not admins do not get the Admin entry.
  const admin = await loginAdmin();
  const friend = await createUser(admin);
  const ctx = await browser.newContext({ viewport: { width: 375, height: 800 } });
  const phone = await ctx.newPage();
  await uiLogin(phone, friend.username, friend.password);
  const phoneMenu = await openMenu(phone);
  await expect(phoneMenu.getByRole("menuitem")).toHaveText([/Your profile/, /New organization/, /Settings/, /Sign out/]);
  expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await phoneMenu.getByRole("menuitem", { name: /Sign out/ }).click();
  await expect(phone).toHaveURL(/\/login/);
  await ctx.close();
});

test("profile details, avatar and links are editable and only safe links are accepted", async ({ page }, info) => {
  const admin = await loginAdmin();
  const me = await createUser(admin);
  await uiLogin(page, me.username, me.password);
  await page.goto(`${baseURL()}/settings`);

  await page.getByLabel("Display name").fill("Mira Kowalski");
  await page.getByLabel("Bio").fill("Builds the git transport. Likes small diffs.");
  await page.getByLabel("Pronouns").fill("she/her");
  await page.getByLabel("Company").fill("Ether");
  await page.getByLabel("Location").fill("Leipzig");
  await page.getByLabel("Website").fill("https://mira.example");
  await page.getByLabel("Social link 1").fill("https://social.example/@mira");
  await page.getByLabel("Status").fill("Reviewing invites");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Profile saved" })).toBeVisible();

  await page.getByLabel("Upload avatar").setInputFiles({ name: "me.png", mimeType: "image/png", buffer: png(64) });
  await expect(page.getByRole("status").filter({ hasText: "Avatar updated" })).toBeVisible();

  await page.goto(`${baseURL()}/${me.username}`);
  const card = page.getByRole("complementary", { name: "Profile" });
  await expect(card.getByRole("heading", { name: "Mira Kowalski" })).toBeVisible();
  for (const text of [me.username, "she/her", "Builds the git transport. Likes small diffs.", "Ether", "Leipzig", "Reviewing invites"]) await expect(card).toContainText(text);
  await expect(card.getByRole("link", { name: "mira.example" })).toHaveAttribute("href", "https://mira.example");
  await expect(card.getByRole("link", { name: "social.example/@mira" })).toHaveAttribute("href", "https://social.example/@mira");
  const avatar = card.getByRole("img", { name: `${me.username}'s avatar` });
  await expect(avatar).toBeVisible();
  expect(await avatar.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  // The same picture shows in the account menu.
  expect(await page.getByRole("button", { name: "Account menu" }).locator("img").evaluate((el: HTMLImageElement) => el.naturalWidth > 0)).toBe(true);
  await info.attach("profile", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await info.attach("profile-375", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

  // Links render as anchors, so only http(s) is stored.
  for (const website of ["javascript:alert(1)", "data:text/html,hi", "ftp://x.example"])
    expect((await me.ctx.patch("/api/me/profile", { data: { website }, headers: origin() })).status(), website).toBe(400);
  // Avatars must be real raster images of bounded size; SVG can carry script.
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  expect((await me.ctx.put("/api/me/avatar", { data: svg, headers: { ...origin(), "Content-Type": "image/svg+xml" } })).status()).toBe(400);
  const huge = Buffer.concat([png(8), Buffer.alloc(3 * 1024 * 1024)]);
  expect((await me.ctx.put("/api/me/avatar", { data: huge, headers: { ...origin(), "Content-Type": "image/png" } })).status()).toBe(413);
  const served = await me.ctx.get(`/api/users/${me.username}/avatar`);
  expect(served.headers()["content-type"]).toBe("image/png");
  expect(served.headers()["x-content-type-options"]).toBe("nosniff");
});

test("GIF avatars are kept as GIFs so animation survives", async ({ page }) => {
  const admin = await loginAdmin();
  const me = await createUser(admin);
  await uiLogin(page, me.username, me.password);
  await page.goto(`${baseURL()}/settings`);
  // Two-frame 1x1 animated GIF.
  const gif = Buffer.from(
    "R0lGODlhAQABAPAAAP8AAP///yH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAACAkQBACH5BAAKAAAALAAAAAABAAEAgAAA/wAAAAICRAEAOw==",
    "base64",
  );
  await page.getByLabel("Upload avatar").setInputFiles({ name: "wave.gif", mimeType: "image/gif", buffer: gif });
  await expect(page.getByRole("status").filter({ hasText: "Avatar updated" })).toBeVisible();
  const served = await me.ctx.get(`/api/users/${me.username}/avatar`);
  expect(served.headers()["content-type"]).toBe("image/gif");
  expect(Buffer.from(await served.body()).equals(gif)).toBe(true);

  // GIFs may be up to 2 MB (stills stay at 1 MB, checked above); bigger ones are refused.
  const big = Buffer.concat([gif, Buffer.alloc(1.5 * 1024 * 1024)]);
  expect((await me.ctx.put("/api/me/avatar", { data: big, headers: { Origin: baseURL(), "Content-Type": "image/gif" } })).ok()).toBe(true);
  const tooBig = Buffer.concat([gif, Buffer.alloc(2.5 * 1024 * 1024)]);
  expect((await me.ctx.put("/api/me/avatar", { data: tooBig, headers: { Origin: baseURL(), "Content-Type": "image/gif" } })).status()).toBe(413);
});

test("following shows on both profiles and can be undone", async ({ page }) => {
  const admin = await loginAdmin();
  const a = await createUser(admin);
  const b = await createUser(admin);
  await uiLogin(page, b.username, b.password);
  await page.goto(`${baseURL()}/${a.username}`);
  await page.getByRole("button", { name: "Follow" }).click();
  await expect(page.getByRole("link", { name: "1 follower" })).toBeVisible();
  await page.getByRole("link", { name: "1 follower" }).click();
  await expect(page.getByRole("main").getByRole("link", { name: b.username, exact: true })).toBeVisible();

  await page.goto(`${baseURL()}/${b.username}`);
  await expect(page.getByRole("link", { name: "1 following" })).toBeVisible();

  await page.goto(`${baseURL()}/${a.username}`);
  await page.getByRole("button", { name: "Unfollow" }).click();
  await expect(page.getByRole("link", { name: "0 followers" })).toBeVisible();
  // You cannot follow yourself.
  expect((await a.ctx.put(`/api/users/${a.username}/follow`, { headers: origin() })).status()).toBe(400);
});

test("pins, profile README, contributions and activity only reveal repositories the viewer can read", async ({ page, browser }, info) => {
  const admin = await loginAdmin();
  const owner = await createUser(admin);
  const viewer = await createUser(admin);
  const shared = await createRepo(owner.ctx, unique("shared"));
  const secret = await createRepo(owner.ctx, unique("secret"));
  const special = await createRepo(owner.ctx, owner.username);
  await owner.ctx.put(`/api/repos/${owner.username}/${shared}/collaborators/${viewer.username}`, { data: { role: "read" }, headers: origin() });

  const email = `${owner.username}@work.test`;
  expect((await owner.ctx.put("/api/me/emails", { data: { emails: [email] }, headers: origin() })).ok()).toBe(true);
  // Nobody else can claim those commits.
  expect((await viewer.ctx.put("/api/me/emails", { data: { emails: [email.toUpperCase()] }, headers: origin() })).status()).toBe(409);

  const auth = { username: owner.username, token: owner.token };
  const as = { GIT_AUTHOR_NAME: "Owner", GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: "Owner", GIT_COMMITTER_EMAIL: email };
  const push = (repo: string, files: string[]) => {
    const src = workdir();
    gitOk(src, ["init", "-q"]);
    for (const f of files) {
      writeFileSync(join(src, f), f);
      gitOk(src, ["add", "-A"]);
      gitOk(src, ["commit", "-q", "-m", `add ${f}`], undefined, as);
    }
    gitOk(src, ["push", "-q", cloneUrl(owner.username, repo), "main"], auth);
  };
  push(shared, ["a", "b", "c"]);
  push(secret, ["x", "y"]);
  push(special, ["README.md"]);
  await owner.ctx.post(`/api/repos/${owner.username}/${shared}/issues`, { data: { title: "Visible issue", body: "" }, headers: origin() });
  await owner.ctx.post(`/api/repos/${owner.username}/${secret}/issues`, { data: { title: "Hidden issue", body: "" }, headers: origin() });
  expect((await owner.ctx.put("/api/me/pins", { data: { repos: [`${owner.username}/${secret}`, `${owner.username}/${shared}`] }, headers: origin() })).ok()).toBe(true);

  // The owner sees everything.
  await uiLogin(page, owner.username, owner.password);
  await page.goto(`${baseURL()}/${owner.username}`);
  const pins = page.getByRole("list", { name: "Pinned repositories" }).getByRole("listitem");
  await expect(pins).toHaveCount(2);
  await expect(page.getByRole("article", { name: "Profile README" })).toContainText("README.md");
  // 3 + 2 + 1 commits and two opened issues.
  await expect(page.getByText("8 contributions in the last year")).toBeVisible();
  await expect(page.getByRole("list", { name: "Recent activity" })).toContainText("Hidden issue");
  await info.attach("own-profile", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

  // A collaborator on one repository sees only that one, everywhere on the page and in the API.
  const ctx = await browser.newContext();
  const other = await ctx.newPage();
  await uiLogin(other, viewer.username, viewer.password);
  await other.goto(`${baseURL()}/${owner.username}`);
  await expect(other.getByRole("list", { name: "Pinned repositories" }).getByRole("listitem")).toHaveCount(1);
  await expect(other.getByText("4 contributions in the last year")).toBeVisible();
  await expect(other.getByRole("list", { name: "Recent activity" })).toContainText("Visible issue");
  await expect(other.getByRole("article", { name: "Profile README" })).toHaveCount(0);
  await other.getByRole("link", { name: /^Repositories/ }).click();
  await expect(other.getByRole("list", { name: "Repositories" }).getByRole("listitem")).toHaveCount(1);
  for (const leak of [secret, "Hidden issue"]) await expect(other.getByRole("main")).not.toContainText(leak);
  const api = JSON.stringify(await (await viewer.ctx.get(`/api/users/${owner.username}/profile`)).json());
  expect(api).not.toContain(secret);
  expect(api).not.toContain("Hidden issue");
  await info.attach("viewer-profile", { body: await other.screenshot({ fullPage: true }), contentType: "image/png" });
  await ctx.close();
});
