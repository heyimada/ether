// Fills dist/cli with the `ether` client binaries this server offers for download (bun run build:cli).
// First choice: the release built by .github/workflows/cli-release.yml for the version in cli/Cargo.toml, every
// platform, each checked against the release's SHA256SUMS. Without network or a release: a local `cargo build` for
// this machine's platform, if Rust is installed. `--local` skips the download; ETHER_CLI_RELEASES points elsewhere.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PLATFORMS, fileFor } from "../src/server/cli-dist";

const root = resolve(import.meta.dirname, "..");
const out = resolve(process.env.ETHER_CLI_DIR ?? join(root, "dist", "cli"));
const version = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(join(root, "cli", "Cargo.toml"), "utf8"))?.[1];
if (!version) throw new Error("No version in cli/Cargo.toml");
const releases = (process.env.ETHER_CLI_RELEASES ?? "https://github.com/heyimada/ether/releases/download").replace(/\/$/, "");
const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

async function get(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: "follow" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// Every platform from the release, or null if it can't be had (offline, no release yet, a bad checksum).
async function download(): Promise<Map<string, Uint8Array> | null> {
  const base = `${releases}/cli-v${version}`;
  try {
    const sums = new TextDecoder().decode(await get(`${base}/SHA256SUMS`));
    // "<sha256>  <name>" per line, as sha256sum writes it.
    const want = new Map(
      sums
        .split("\n")
        .map((l) => /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(l.trim()))
        .filter((m): m is RegExpExecArray => !!m)
        .map((m) => [m[2], m[1]]),
    );
    const files = new Map<string, Uint8Array>();
    for (const p of PLATFORMS) {
      const name = fileFor(p.id);
      if (!want.has(name)) continue;
      const data = await get(`${base}/${name}`);
      if (sha256(data) !== want.get(name)) throw new Error(`${name}: checksum mismatch`);
      files.set(name, data);
    }
    if (!files.size) throw new Error("the release has no binaries");
    return files;
  } catch (e) {
    console.warn(`Couldn't download the ether ${version} release (${(e as Error).message}).`);
    return null;
  }
}

function hostPlatform() {
  const os = ({ darwin: "darwin", linux: "linux", win32: "windows" } as Record<string, string>)[process.platform];
  const arch = ({ x64: "x64", arm64: "arm64" } as Record<string, string>)[process.arch];
  return os && arch && PLATFORMS.some((p) => p.id === `${os}-${arch}`) ? `${os}-${arch}` : null;
}

// This machine's platform from source, or null without Rust.
function build(): Map<string, Uint8Array> | null {
  const platform = hostPlatform();
  if (!platform) return console.warn(`No ether build for ${process.platform}-${process.arch}.`), null;
  if (!Bun.which("cargo")) return console.warn("Rust (cargo) isn't installed, so ether can't be built here."), null;
  console.log(`Building ether ${version} for ${platform}…`);
  const r = Bun.spawnSync(["cargo", "build", "--release", "--locked"], { cwd: join(root, "cli"), stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) return console.warn("cargo build failed."), null;
  // cargo honours CARGO_TARGET_DIR, so the binary is wherever that points.
  const target = resolve(join(root, "cli"), process.env.CARGO_TARGET_DIR ?? "target");
  const bin = join(target, "release", platform.startsWith("windows") ? "ether.exe" : "ether");
  return new Map([[fileFor(platform), new Uint8Array(readFileSync(bin))]]);
}

const downloaded = process.argv.includes("--local") ? null : await download();
const files = downloaded ?? build();
if (!files) {
  console.warn("No ether client binaries; the /cli page will say so. Nothing changed.");
  process.exit(0);
}
// A release replaces everything. A local build only adds this machine's binary: what an earlier run downloaded for
// the same version stays offered, while binaries of another version go.
const sameVersion = existsSync(join(out, "VERSION")) && readFileSync(join(out, "VERSION"), "utf8").trim() === version;
if (downloaded || !sameVersion) rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const [name, data] of files) {
  writeFileSync(join(out, name), data);
  if (!name.endsWith(".exe")) chmodSync(join(out, name), 0o755);
}
writeFileSync(join(out, "VERSION"), `${version}\n`);
const offered = PLATFORMS.map((p) => fileFor(p.id)).filter((name) => existsSync(join(out, name)));
writeFileSync(join(out, "SHA256SUMS"), offered.map((n) => `${sha256(readFileSync(join(out, n)))}  ${n}`).join("\n") + "\n");
console.log(`dist/cli: ether ${version} for ${offered.join(", ")}`);
