import { spawn, spawnSync } from "node:child_process";
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const ADMIN = { username: "admin", password: "admin-password-1" };

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.once("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => ok(port));
    });
  });
}

// Boots a real Ether server against a throwaway data directory and bootstraps the admin
// account through the same CLI an operator would use.
export default async function globalSetup() {
  const root = resolve(import.meta.dirname, "..");
  const reportDir = resolve(root, process.env.ETHER_E2E_REPORT_DIR!);
  mkdirSync(reportDir, { recursive: true });

  const dataDir = mkdtempSync(join(tmpdir(), "ether-e2e-"));
  const port = await freePort();
  // Serve a snapshot of the build so a rebuild of dist/ during the run can't take the server down.
  const built = join(root, "dist", "client");
  if (!existsSync(join(built, "_shell.html"))) throw new Error("Build the web app first: bunx vite build");
  const webDir = join(dataDir, "web");
  cpSync(built, webDir, { recursive: true });
  const sshPort = await freePort();
  const env = { ...process.env, ETHER_DATA: dataDir, ETHER_PORT: String(port), ETHER_HOST: "127.0.0.1", ETHER_WEB_DIST: webDir, ETHER_SSH_PORT: String(sshPort) };

  const admin = spawnSync("bun", ["src/server/cli.ts", "create-admin", ADMIN.username, "--password", ADMIN.password], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  if (admin.status !== 0) throw new Error(`create-admin failed: ${admin.stderr || admin.stdout}`);

  const log = createWriteStream(join(reportDir, "server.log"));
  const server = spawn("bun", ["src/server/main.ts"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.pipe(log);
  server.stderr.pipe(log);

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error(`server exited early with code ${server.exitCode}`);
    try {
      if ((await fetch(`${url}/api/health`)).ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error("server did not become healthy");
    await new Promise((r) => setTimeout(r, 200));
  }

  process.env.ETHER_URL = url;
  process.env.ETHER_PORT = String(port);
  process.env.ETHER_SSH_PORT = String(sshPort);
  process.env.ETHER_DATA = dataDir;

  return async () => {
    server.kill();
    await new Promise((r) => server.once("exit", r));
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
  };
}
