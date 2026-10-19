import { expect, request, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADMIN, baseURL, cloneUrl, createUser, git, gitOk, loginAdmin, uiLogin, unique, workdir } from "./helpers";

const headers = () => ({ Origin: baseURL() });

test("an admin can let visitors without an account read public repositories, and only those", async ({ page, browser }, info) => {
  const admin = await loginAdmin();
  const owner = await createUser(admin);
  const open = unique("open");
  const closed = unique("closed");
  await owner.ctx.post("/api/repos", { data: { name: open, visibility: "public" }, headers: headers() });
  await owner.ctx.post("/api/repos", { data: { name: closed, visibility: "private" }, headers: headers() });
  for (const name of [open, closed]) {
    const src = workdir();
    gitOk(src, ["init", "-q"]);
    writeFileSync(join(src, "README.md"), `# ${name}\n`);
    gitOk(src, ["add", "-A"]);
    gitOk(src, ["commit", "-q", "-m", "seed"]);
    gitOk(src, ["push", "-q", cloneUrl(owner.username, name), "main"], { username: owner.username, token: owner.token });
  }
  await owner.ctx.post(`/api/repos/${owner.username}/${open}/issues`, { data: { title: "Public discussion", body: "" }, headers: headers() });

  const visitorCtx = await browser.newContext();
  const visitor = await visitorCtx.newPage();
  const anon = await request.newContext({ baseURL: baseURL() });

  // Off by default: a visitor is sent to sign in and git asks for credentials.
  await visitor.goto(`${baseURL()}/${owner.username}/${open}`);
  await expect(visitor).toHaveURL(/\/login/);
  expect(git(workdir(), ["clone", "-q", cloneUrl(owner.username, open), "c"]).code).not.toBe(0);

  await uiLogin(page, ADMIN.username, ADMIN.password);
  await page.goto(`${baseURL()}/site-admin`);
  await page.getByRole("checkbox", { name: /without an account/ }).check();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();

  try {
    // Public repositories: readable in the browser and clonable without credentials.
    await visitor.goto(`${baseURL()}/${owner.username}/${open}`);
    await expect(visitor.getByRole("article", { name: "README" })).toContainText(open);
    await expect(visitor.getByRole("link", { name: "Sign in" })).toBeVisible();
    await info.attach("anonymous-repo", { body: await visitor.screenshot({ fullPage: true }), contentType: "image/png" });
    const dir = workdir();
    const cloned = git(dir, ["clone", "-q", cloneUrl(owner.username, open), "c"]);
    expect(cloned.code, cloned.stderr).toBe(0);

    // Reading issues works; taking part does not.
    await visitor.getByRole("navigation", { name: "Repository" }).getByRole("link", { name: "Issues" }).click();
    await visitor.getByRole("link", { name: "Public discussion" }).click();
    await expect(visitor.getByRole("heading", { name: /Public discussion/ })).toBeVisible();
    await expect(visitor.getByLabel("Comment")).toHaveCount(0);
    expect((await anon.post(`/api/repos/${owner.username}/${open}/issues`, { data: { title: "spam", body: "" }, headers: headers() })).status()).toBe(401);
    // Pushing still needs an account with a role.
    writeFileSync(join(dir, "c", "x.txt"), "x\n");
    gitOk(join(dir, "c"), ["add", "-A"]);
    gitOk(join(dir, "c"), ["commit", "-q", "-m", "anon"]);
    expect(git(join(dir, "c"), ["push", "-q", "origin", "main"]).code).not.toBe(0);

    // Private repositories stay invisible.
    expect((await anon.get(`/api/repos/${owner.username}/${closed}`)).status()).toBe(401);
    expect(git(workdir(), ["clone", "-q", cloneUrl(owner.username, closed), "c"]).code).not.toBe(0);
    await visitor.goto(`${baseURL()}/${owner.username}/${closed}`);
    await expect(visitor).toHaveURL(/\/login/);
    // Account pages still need an account.
    await visitor.goto(`${baseURL()}/settings`);
    await expect(visitor).toHaveURL(/\/login/);
    // The public list leaks nothing private.
    const listed = JSON.stringify(await (await anon.get("/api/repos")).json());
    expect(listed).toContain(open);
    expect(listed).not.toContain(closed);
  } finally {
    await page.goto(`${baseURL()}/site-admin`);
    await page.getByRole("checkbox", { name: /without an account/ }).uncheck();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    await visitorCtx.close();
  }
});
