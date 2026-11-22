import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cliFile, cliManifest, installPs1, installSh } from "./cli-dist";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function dist(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "ether-cli-dist-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

test("the manifest lists only known platform files that exist, with their checksums", () => {
  const dir = dist({ "ether-linux-x64": "L", "ether-windows-x64.exe": "W", "ether-plan9-mips": "?", VERSION: "1.2.3\n" });
  const m = cliManifest(dir);
  expect(m.version).toBe("1.2.3");
  expect(m.binaries.map((b) => [b.platform, b.size, b.sha256])).toEqual([
    ["linux-x64", 1, sha("L")],
    ["windows-x64", 1, sha("W")],
  ]);
  expect(cliManifest(join(dir, "missing"))).toEqual({ version: null, binaries: [] });
});

test("downloads are only the known platform files", () => {
  const dir = dist({ "ether-linux-x64": "L", VERSION: "1\n" });
  expect(cliFile("ether-linux-x64", dir)).toBe(join(dir, "ether-linux-x64"));
  for (const name of ["VERSION", "ether-darwin-arm64", "../ether-linux-x64", "ether-linux-x64/..", ""]) expect(cliFile(name, dir)).toBeNull();
});

test("the installers carry this server's URL and each binary's checksum", () => {
  const dir = dist({ "ether-darwin-arm64": "D", "ether-windows-x64.exe": "W" });
  const sh = installSh("https://ether.example.com", dir);
  expect(sh).toContain("server='https://ether.example.com'");
  expect(sh).toContain(`darwin-arm64) want=${sha("D")} ;;`);
  expect(sh).not.toContain("linux-x64) want");
  expect(installSh("https://x'; rm -rf /; '", dir)).toContain(`server='https://x'\\''; rm -rf /; '\\'''`);
  const ps = installPs1("https://ether.example.com", dir);
  expect(ps).toContain(sha("W"));
  expect(installPs1("https://ether.example.com", dist({ "ether-linux-x64": "L" }))).toContain("no Windows build");
});

const script = resolve(import.meta.dirname, "../../scripts/cli-dist.ts");
const version = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(resolve(import.meta.dirname, "../../cli/Cargo.toml"), "utf8"))![1];

// A stand-in for the GitHub release the script downloads from.
function releaseServer(files: Record<string, string>) {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const name = new URL(req.url).pathname.replace(`/cli-v${version}/`, "");
      return name in files ? new Response(files[name]) : new Response("not found", { status: 404 });
    },
  });
}

// Async, so this process's stand-in release server keeps answering while the script runs.
async function run(env: Record<string, string>) {
  const proc = Bun.spawn(["bun", script], { env, stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { code, stderr };
}

test("build:cli takes the release's binaries after checking them", async () => {
  const server = releaseServer({
    "ether-linux-x64": "L",
    "ether-darwin-arm64": "D",
    SHA256SUMS: `${sha("L")}  ether-linux-x64\n${sha("D")}  ether-darwin-arm64\n`,
  });
  try {
    const out = join(mkdtempSync(join(tmpdir(), "ether-cli-out-")), "cli");
    expect((await run({ ...process.env, ETHER_CLI_RELEASES: `http://127.0.0.1:${server.port}`, ETHER_CLI_DIR: out } as Record<string, string>)).code).toBe(0);
    expect(readFileSync(join(out, "ether-linux-x64"), "utf8")).toBe("L");
    expect(readFileSync(join(out, "VERSION"), "utf8").trim()).toBe(version);
    expect(cliManifest(out).binaries.map((b) => b.platform)).toEqual(["darwin-arm64", "linux-x64"]);
  } finally {
    server.stop(true);
  }
});

test("build:cli refuses a release whose checksum doesn't match", async () => {
  const server = releaseServer({ "ether-linux-x64": "tampered", SHA256SUMS: `${sha("L")}  ether-linux-x64\n` });
  try {
    const out = join(mkdtempSync(join(tmpdir(), "ether-cli-out-")), "cli");
    // Without cargo on the PATH there's no local build to fall back to either, so nothing is written.
    const r = await run({ ETHER_CLI_RELEASES: `http://127.0.0.1:${server.port}`, ETHER_CLI_DIR: out, PATH: resolve(process.execPath, "..") });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("checksum mismatch");
    expect(existsSync(out)).toBe(false);
  } finally {
    server.stop(true);
  }
});

test("a local build after a failed download keeps the other platforms of the same version", async () => {
  const out = join(mkdtempSync(join(tmpdir(), "ether-cli-out-")), "cli");
  const server = releaseServer({ "ether-plan9-x": "", "ether-windows-x64.exe": "W", SHA256SUMS: `${sha("W")}  ether-windows-x64.exe\n` });
  try {
    expect((await run({ ...process.env, ETHER_CLI_RELEASES: `http://127.0.0.1:${server.port}`, ETHER_CLI_DIR: out } as Record<string, string>)).code).toBe(0);
  } finally {
    server.stop(true);
  }
  // Offline now, and no cargo: nothing changes. With a stand-in cargo that "builds" this platform, it's added.
  const bin = mkdtempSync(join(tmpdir(), "ether-fake-cargo-"));
  const target = mkdtempSync(join(tmpdir(), "ether-fake-target-"));
  writeFileSync(join(bin, "cargo"), '#!/bin/sh\nmkdir -p "$CARGO_TARGET_DIR/release" && printf HOST > "$CARGO_TARGET_DIR/release/ether"\n', { mode: 0o755 });
  const r = await run({ ETHER_CLI_RELEASES: "http://127.0.0.1:9", ETHER_CLI_DIR: out, CARGO_TARGET_DIR: target, PATH: `${bin}:${resolve(process.execPath, "..")}:/bin:/usr/bin` });
  expect(r.code).toBe(0);
  const offered = cliManifest(out).binaries.map((b) => b.platform);
  expect(offered).toContain("windows-x64");
  expect(offered.length).toBe(2);
  expect(readFileSync(join(out, "SHA256SUMS"), "utf8")).toContain(`${sha("W")}  ether-windows-x64.exe`);
});
