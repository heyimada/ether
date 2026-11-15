import { expect, test, type Page } from "@playwright/test";
import { baseURL, createRepo, createUser, loginAdmin, uiLogin } from "./helpers";

type RGB = [number, number, number];

const parse = (css: string): RGB => {
  const m = css.match(/\d+(\.\d+)?/g);
  if (!m) throw new Error(`not a colour: ${css}`);
  return [Number(m[0]), Number(m[1]), Number(m[2])];
};
const lum = ([r, g, b]: RGB) => {
  const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a: RGB, b: RGB) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const hue = ([r, g, b]: RGB) => {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
  if (d === 0) return 0;
  const h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return (h * 60 + 360) % 360;
};
const hueDistance = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

// Reads what the viewer actually sees: a repository link on the home page and the surface behind it,
// plus the primary button on the settings page and its label.
async function seen(page: Page) {
  await page.goto(`${baseURL()}/`);
  const link = page.getByRole("main").getByRole("link").first();
  await link.waitFor();
  const linkColor = parse(await link.evaluate((el) => getComputedStyle(el).color));
  // The nearest ancestor that paints a background is what the link is read against.
  const pageBg = parse(
    await link.evaluate((el) => {
      for (let n: Element | null = el; n; n = n.parentElement) {
        const bg = getComputedStyle(n).backgroundColor;
        if (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
      }
      return getComputedStyle(document.documentElement).backgroundColor;
    }),
  );
  await page.goto(`${baseURL()}/settings`);
  const button = page.getByRole("button", { name: "Save accent" });
  const fill = parse(await button.evaluate((el) => getComputedStyle(el).backgroundColor));
  const label = parse(await button.evaluate((el) => getComputedStyle(el).color));
  return { linkColor, pageBg, fill, label };
}

const DEFAULT_FILL: RGB = [11, 114, 133]; // #0b7285

for (const chosen of [
  { hex: "#ffd43b", name: "a very light yellow" },
  { hex: "#1b1f5e", name: "a very dark navy" },
]) {
  test(`a user picks ${chosen.name} as accent; it persists, stays readable and is theirs alone`, async ({ page, browser }, info) => {
    const admin = await loginAdmin();
    const me = await createUser(admin);
    const other = await createUser(admin);
    await createRepo(me.ctx);
    await createRepo(other.ctx);
    const want = hue(parse(`rgb(${parseInt(chosen.hex.slice(1, 3), 16)},${parseInt(chosen.hex.slice(3, 5), 16)},${parseInt(chosen.hex.slice(5, 7), 16)})`));

    await uiLogin(page, me.username, me.password);
    await page.goto(`${baseURL()}/settings`);
    await page.getByLabel("Accent colour").fill(chosen.hex);
    await page.getByRole("button", { name: "Save accent" }).click();
    await expect(page.getByRole("status")).toHaveText("Accent saved");
    await info.attach("settings-accent", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

    // A fresh browser session for the same user gets the saved accent, in both themes.
    for (const colorScheme of ["light", "dark"] as const) {
      const ctx = await browser.newContext({ colorScheme });
      const fresh = await ctx.newPage();
      await uiLogin(fresh, me.username, me.password);
      const s = await seen(fresh);
      expect(hueDistance(hue(s.fill), want), `button fill keeps the chosen hue (${colorScheme})`).toBeLessThan(15);
      expect(contrast(s.label, s.fill), `button label readable (${colorScheme})`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(s.linkColor, s.pageBg), `links readable (${colorScheme})`).toBeGreaterThanOrEqual(4.5);
      await info.attach(`home-${colorScheme}`, { body: await fresh.screenshot({ fullPage: true }), contentType: "image/png" });
      await ctx.close();
    }

    // Someone else still sees the default accent.
    const otherCtx = await browser.newContext({ colorScheme: "light" });
    const otherPage = await otherCtx.newPage();
    await uiLogin(otherPage, other.username, other.password);
    expect((await seen(otherPage)).fill).toEqual(DEFAULT_FILL);
    await otherCtx.close();

    // Resetting returns to the default.
    await page.goto(`${baseURL()}/settings`);
    await page.getByRole("button", { name: "Use default" }).click();
    await page.getByRole("button", { name: "Save accent" }).click();
    await expect(page.getByRole("status")).toHaveText("Accent saved");
    await page.reload();
    expect((await seen(page)).fill).toEqual(DEFAULT_FILL);
  });
}

test("the accent only accepts a hex colour", async () => {
  const admin = await loginAdmin();
  const me = await createUser(admin);
  for (const accent of ["red", "#12345", "#0b7285; } body { display: none", "url(x)", 7]) {
    expect((await me.ctx.put("/api/me/appearance", { data: { accent }, headers: { Origin: baseURL() } })).status(), String(accent)).toBe(400);
  }
  expect((await me.ctx.put("/api/me/appearance", { data: { accent: "#AbCdEf" }, headers: { Origin: baseURL() } })).ok()).toBe(true);
  expect((await (await me.ctx.get("/api/me")).json()).user.accent).toBe("#abcdef");
});
