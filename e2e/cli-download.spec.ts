import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseURL, createUser, loginAdmin, uiLogin } from "./helpers";

// global-setup serves stand-in binaries (shell scripts that print their platform) and VERSION 9.9.9.
test("the server offers the client for download, with a page and installers that check what they fetch", async ({ page, request }, info) => {
  const admin = await loginAdmin();
  const me = await createUser(admin);

  // The page, from the account menu.
  await uiLogin(page, me.username, me.password);
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Command-line client" }).click();
  await expect(page.getByRole("heading", { name: "Command-line client" })).toBeVisible();
  await expect(page.getByText("Version 9.9.9.")).toBeVisible();
  await expect(page.getByLabel("Install on macOS or Linux")).toHaveText(`curl -fsSL ${baseURL()}/install.sh | sh`);
  await expect(page.getByLabel("Install on Windows")).toHaveText(`irm ${baseURL()}/install.ps1 | iex`);
  await expect(page.getByLabel("Login command")).toContainText(`ether auth login --host ${baseURL()} --with-token`);
  await expect(page.getByRole("region", { name: "All downloads" }).getByRole("listitem")).toHaveCount(5);
  await info.attach("cli-page", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

  // The manifest needs an account; the files and installers don't.
  const manifest = await (await me.ctx.get("/api/cli")).json();
  expect([manifest.version, manifest.server, manifest.binaries.length]).toEqual(["9.9.9", baseURL(), 5]);
  expect((await request.get(`${baseURL()}/api/cli`)).status()).toBe(401);
  const file = await request.get(`${baseURL()}/api/cli/download/ether-linux-x64`);
  expect([file.status(), file.headers()["content-disposition"]]).toEqual([200, 'attachment; filename="ether"']);
  expect(await file.text()).toContain("ether linux-x64");
  for (const name of ["VERSION", "..%2FVERSION", "ether-plan9-mips"]) expect((await request.get(`${baseURL()}/api/cli/download/${name}`)).status()).toBe(404);

  // The shell installer picks this machine's platform, checks it and installs it.
  const sh = await (await request.get(`${baseURL()}/install.sh`)).text();
  const dir = mkdtempSync(join(tmpdir(), "ether-install-"));
  writeFileSync(join(dir, "install.sh"), sh);
  const run = spawnSync("sh", [join(dir, "install.sh")], { env: { ...process.env, HOME: dir, ETHER_INSTALL_DIR: join(dir, "bin") }, encoding: "utf8" });
  expect(run.status, run.stderr).toBe(0);
  expect(run.stdout).toContain(`Installed ether to ${join(dir, "bin")}/ether`);
  expect(run.stdout).toContain(`ether auth login --host ${baseURL()} --with-token`);
  const platform = `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
  expect(spawnSync(join(dir, "bin", "ether"), ["--version"], { encoding: "utf8" }).stdout).toContain(`ether ${platform} --version`);

  // A tampered checksum stops it before anything is installed.
  const tampered = join(dir, "tampered.sh");
  writeFileSync(tampered, sh.replace(/want=[0-9a-f]{64}/g, `want=${"0".repeat(64)}`));
  const bad = spawnSync("sh", [tampered], { env: { ...process.env, HOME: dir, ETHER_INSTALL_DIR: join(dir, "bin2") }, encoding: "utf8" });
  expect([bad.status, bad.stderr]).toEqual([1, expect.stringContaining("checksum mismatch")]);

  // The PowerShell one carries the Windows build's checksum.
  const ps = await (await request.get(`${baseURL()}/install.ps1`)).text();
  expect(ps).toContain(manifest.binaries.find((b: { platform: string }) => b.platform === "windows-x64").sha256);
});
