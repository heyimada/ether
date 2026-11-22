import { join, resolve } from "node:path";

const host = process.env.ETHER_HOST ?? "127.0.0.1";
const port = Number(process.env.ETHER_PORT ?? 3000);
const publicUrl = (process.env.ETHER_PUBLIC_URL ?? `http://${host}:${port}`).replace(/\/$/, "");

export const config = {
  dataDir: resolve(process.env.ETHER_DATA ?? "data"),
  host,
  port,
  // The URL people use to reach Ether, e.g. the tailnet HTTPS name behind `tailscale serve`.
  publicUrl,
  trustedOrigins: [publicUrl, `http://127.0.0.1:${port}`, `http://localhost:${port}`, "http://localhost:5173", "http://127.0.0.1:5173"],
  // Git over SSH listens here (same bind address as HTTP); ETHER_SSH_PORT=off disables it.
  sshPort: process.env.ETHER_SSH_PORT === "off" ? null : Number(process.env.ETHER_SSH_PORT ?? 2222),
  sshHost: process.env.ETHER_SSH_HOST ?? new URL(publicUrl).hostname,
  // Overridable so test runs can serve a private copy of the build.
  webDist: resolve(process.env.ETHER_WEB_DIST ?? resolve(import.meta.dirname, "../../dist/client")),
  // The `ether` client binaries offered for download (`bun run build:cli` fills it).
  cliDist: resolve(process.env.ETHER_CLI_DIR ?? resolve(import.meta.dirname, "../../dist/cli")),
};

// Everything Ether keeps in its data directory. Backup and restore copy all of it; the hooks directory isn't here
// because Ether writes it afresh.
export const DATA = { db: "ether.db", repos: "repos", avatars: "avatars", releases: "releases", authSecret: "auth-secret", hostKey: "ssh_host_ed25519_key" } as const;
export const dataPath = (name: keyof typeof DATA, ...rest: string[]) => join(config.dataDir, DATA[name], ...rest);
// A release's uploaded files.
export const releaseDir = (releaseId: number) => dataPath("releases", String(releaseId));
