import { resolve } from "node:path";

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
  // Overridable so test runs can serve a private copy of the build.
  webDist: resolve(process.env.ETHER_WEB_DIST ?? resolve(import.meta.dirname, "../../dist/client")),
};

export const reposDir = () => resolve(config.dataDir, "repos");
