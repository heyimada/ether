import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseURL, cloneUrl, createRepo, createUser, gitOk, loginAdmin, uiLogin, unique, workdir } from "./helpers";

const headers = () => ({ Origin: baseURL() });

test("writers publish releases with notes, a new tag and attached files", async ({ page }, info) => {
  const admin = await loginAdmin();
  const owner = await createUser(admin);
  const reader = await createUser(admin);
  const repo = await createRepo(owner.ctx, unique("ship"));
  const api = `/api/repos/${owner.username}/${repo}`;
  await owner.ctx.put(`${api}/collaborators/${reader.username}`, { data: { role: "read" }, headers: headers() });
  const src = workdir();
  gitOk(src, ["init", "-q"]);
  writeFileSync(join(src, "app.txt"), "version one\n");
  gitOk(src, ["add", "-A"]);
  gitOk(src, ["commit", "-q", "-m", "v1"]);
  gitOk(src, ["push", "-q", cloneUrl(owner.username, repo), "main"], { username: owner.username, token: owner.token });

  await uiLogin(page, owner.username, owner.password);
  await page.goto(`${baseURL()}/${owner.username}/${repo}`);
  await page.getByRole("region", { name: "Releases" }).getByRole("link", { name: /Create a release/ }).click();
  await page.getByLabel("Tag", { exact: true }).fill("v1.0.0");
  await page.getByLabel("Target branch").selectOption("main");
  await page.getByLabel("Release title").fill("First stable release");
  await page.getByLabel("Release notes").fill("## Highlights\n\n- It **works**");
  const binary = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));
  await page.getByLabel("Attach files").setInputFiles({ name: "app-linux.bin", mimeType: "application/octet-stream", buffer: binary });
  await page.getByRole("button", { name: "Publish release" }).click();

  await expect(page).toHaveURL(`${baseURL()}/${owner.username}/${repo}/releases/tag/v1.0.0`);
  await expect(page.getByRole("heading", { name: "First stable release" })).toBeVisible();
  await expect(page.getByRole("article", { name: "Release notes" }).locator("strong")).toHaveText("works");
  await info.attach("release", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

  // The attached file and a source archive download intact.
  const asset = await owner.ctx.get(`${api}/releases/v1.0.0/assets/app-linux.bin`);
  expect(asset.ok()).toBe(true);
  expect(Buffer.from(await asset.body()).equals(binary)).toBe(true);
  expect(asset.headers()["content-disposition"]).toContain("attachment");
  const zip = await owner.ctx.get(`${api}/releases/v1.0.0/source.zip`);
  expect(Buffer.from(await zip.body()).subarray(0, 2).toString()).toBe("PK");

  // The new tag is a real git tag pointing at main.
  const clone = workdir();
  gitOk(clone, ["clone", "-q", cloneUrl(owner.username, repo), "c"], { username: owner.username, token: owner.token });
  expect(gitOk(join(clone, "c"), ["tag", "--list"]).trim()).toBe("v1.0.0");
  expect(gitOk(join(clone, "c"), ["rev-parse", "v1.0.0^{commit}"]).trim()).toBe(gitOk(join(clone, "c"), ["rev-parse", "main"]).trim());

  // The repository page points at the latest release; readers see it but can't publish.
  await page.goto(`${baseURL()}/${owner.username}/${repo}`);
  await expect(page.getByRole("region", { name: "Releases" })).toContainText("First stable release");
  const list = await (await reader.ctx.get(`${api}/releases`)).json();
  expect(list.releases.map((r: { tag: string }) => r.tag)).toEqual(["v1.0.0"]);
  expect((await reader.ctx.post(`${api}/releases`, { data: { tag: "v2", target: "main", title: "x" }, headers: headers() })).status()).toBe(403);
  // A tag can only have one release, and unsafe asset names are refused.
  expect((await owner.ctx.post(`${api}/releases`, { data: { tag: "v1.0.0", title: "again" }, headers: headers() })).status()).toBe(409);
  expect((await owner.ctx.put(`${api}/releases/v1.0.0/assets/..%2Fescape.txt`, { data: Buffer.from("x"), headers: headers() })).status()).toBe(400);

  // Deleting the release keeps the tag.
  expect((await owner.ctx.delete(`${api}/releases/v1.0.0`, { headers: headers() })).ok()).toBe(true);
  expect((await (await owner.ctx.get(api)).json()).tags).toContain("v1.0.0");
});
