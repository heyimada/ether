import { expect, test, type Page } from "@playwright/test";
import { baseURL, createUser, loginAdmin, uiLogin } from "./helpers";

// The tab the underline sits under, and every tab styled as the current one.
async function tabState(page: Page, label: string) {
  const bar = page.getByRole("navigation", { name: label });
  await expect(bar.locator(".tab-indicator")).toBeVisible();
  await page.waitForTimeout(400); // the indicator glides into place
  return bar.evaluate((nav) => {
    const ind = nav.querySelector<HTMLElement>(".tab-indicator")!.getBoundingClientRect();
    const links = [...nav.querySelectorAll("a")];
    const under = links.find((a) => {
      const r = a.getBoundingClientRect();
      return Math.abs(r.left - ind.left) < 4 && Math.abs(r.width - ind.width) < 4;
    });
    const styledCurrent = links.filter((a) => getComputedStyle(a).fontWeight === "600").map((a) => a.textContent!.replace(/\d+$/, "").trim());
    return { under: under?.textContent!.replace(/\d+$/, "").trim() ?? null, styledCurrent };
  });
}

test("profile tabs underline and highlight only the open tab, also when the page opens on it", async ({ page }) => {
  const admin = await loginAdmin();
  const me = await createUser(admin);
  await uiLogin(page, me.username, me.password);
  for (const [tab, label] of [["", "Overview"], ["repositories", "Repositories"], ["stars", "Stars"]]) {
    await page.goto(`${baseURL()}/${me.username}${tab ? `?tab=${tab}` : ""}`);
    expect(await tabState(page, "Profile sections")).toEqual({ under: label, styledCurrent: [label] });
  }
  // Clicking between tabs moves both.
  await page.getByRole("navigation", { name: "Profile sections" }).getByRole("link", { name: /Repositories/ }).click();
  expect(await tabState(page, "Profile sections")).toEqual({ under: "Repositories", styledCurrent: ["Repositories"] });
  await page.getByRole("navigation", { name: "Profile sections" }).getByRole("link", { name: "Overview" }).click();
  await expect(page).toHaveURL(`${baseURL()}/${me.username}`);
  expect(await tabState(page, "Profile sections")).toEqual({ under: "Overview", styledCurrent: ["Overview"] });
});
