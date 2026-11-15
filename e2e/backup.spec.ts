import { expect, request, test } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADMIN, cloneUrl, createRepo, createToken, git, gitOk, loginAdmin, workdir } from "./helpers";

const root = join(import.meta.dirname, "..");
const cli = (env: Record<string, string>, ...args: string[]) => spawnSync("bun", ["src/server/cli.ts", ...args], { cwd: root, env: { ...process.env, ...env }, encoding: "utf8" });

const freePort = () =>
  new Promise<number>((ok) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });

test("a backup taken while the server runs restores into a working instance", async () => {
  const admin = await loginAdmin();
  const token = await createToken(admin);
  const name = await createRepo(admin);
  const src = workdir();
  gitOk(src, ["init", "-q"]);
  writeFileSync(join(src, "kept.txt"), "survives the restore\n");
  gitOk(src, ["add", "-A"]);
  gitOk(src, ["commit", "-q", "-m", "before backup"]);
  gitOk(src, ["push", "-q", cloneUrl("admin", name), "main"], { username: ADMIN.username, token });
  await admin.post(`/api/repos/admin/${name}/issues`, { data: { title: "Issue that must survive", body: "" } });

  const dest = mkdtempSync(join(tmpdir(), "ether-backup-"));
  const backup = cli({ ETHER_DATA: process.env.ETHER_DATA! }, "backup", dest);
  expect(backup.status, backup.stderr).toBe(0);
  const [snapshot] = readdirSync(dest);
  expect(existsSync(join(dest, snapshot, "ether.db"))).toBe(true);

  // Every ref in the copy points at objects the copy has.
  const copied = join(dest, snapshot, "repos", "admin", `${name}.git`);
  expect(spawnSync("git", ["--git-dir", copied, "fsck", "--connectivity-only"], { encoding: "utf8" }).status).toBe(0);

  // Restore refuses to overwrite a data directory that is in use or not empty.
  expect(cli({ ETHER_DATA: process.env.ETHER_DATA! }, "restore", join(dest, snapshot)).status).not.toBe(0);

  const fresh = mkdtempSync(join(tmpdir(), "ether-restored-"));
  const restore = cli({ ETHER_DATA: fresh }, "restore", join(dest, snapshot));
  expect(restore.status, restore.stderr).toBe(0);

  const port = await freePort();
  const server = spawn("bun", ["src/server/main.ts"], { cwd: root, env: { ...process.env, ETHER_DATA: fresh, ETHER_PORT: String(port), ETHER_HOST: "127.0.0.1", ETHER_SSH_PORT: "off" }, stdio: "ignore" });
  try {
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${url}/api/health`)).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    const ctx = await request.newContext({ baseURL: url });
    expect((await ctx.post("/api/auth/sign-in/username", { data: ADMIN })).ok()).toBe(true);
    const issues = await (await ctx.get(`/api/repos/admin/${name}/issues`)).json();
    expect(issues.items.map((i: { title: string }) => i.title)).toContain("Issue that must survive");
    // The same personal access token still works against the restored server.
    const out = workdir();
    const res = git(out, ["clone", "-q", `${url}/admin/${name}.git`, "c"], { username: ADMIN.username, token });
    expect(res.code, res.stderr).toBe(0);
    expect(readFileSync(join(out, "c", "kept.txt"), "utf8")).toBe("survives the restore\n");
  } finally {
    server.kill();
  }
});
