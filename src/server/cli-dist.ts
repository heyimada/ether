// The `ether` client binaries this server offers: whatever `bun run build:cli` put in config.cliDist, named
// ether-<os>-<arch>[.exe]. Pure lookups over that directory, so a platform without a binary just isn't offered.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";

export const PLATFORMS = [
  { id: "darwin-arm64", os: "macOS", arch: "Apple silicon" },
  { id: "darwin-x64", os: "macOS", arch: "Intel" },
  { id: "linux-x64", os: "Linux", arch: "x86-64" },
  { id: "linux-arm64", os: "Linux", arch: "ARM64" },
  { id: "windows-x64", os: "Windows", arch: "x86-64" },
] as const;

export type CliBinary = { platform: string; os: string; arch: string; file: string; size: number; sha256: string };

export const fileFor = (platform: string) => `ether-${platform}${platform.startsWith("windows") ? ".exe" : ""}`;

// Checksums are worked out once per file version (path, size and mtime), since the binaries are a few MB each.
const sums = new Map<string, string>();
function sha256(path: string) {
  const st = statSync(path);
  const key = `${path}:${st.size}:${st.mtimeMs}`;
  let sum = sums.get(key);
  if (!sum) sums.set(key, (sum = createHash("sha256").update(readFileSync(path)).digest("hex")));
  return sum;
}

export function cliManifest(dir = config.cliDist): { version: string | null; binaries: CliBinary[] } {
  if (!existsSync(dir)) return { version: null, binaries: [] };
  const present = new Set(readdirSync(dir));
  const version = present.has("VERSION") ? readFileSync(join(dir, "VERSION"), "utf8").trim() || null : null;
  const binaries = PLATFORMS.filter((p) => present.has(fileFor(p.id))).map((p) => {
    const path = join(dir, fileFor(p.id));
    return { platform: p.id, os: p.os, arch: p.arch, file: fileFor(p.id), size: statSync(path).size, sha256: sha256(path) };
  });
  return { version, binaries };
}

// The binary for a download name, only if it's one of the known platform files and exists.
export function cliFile(name: string, dir = config.cliDist): string | null {
  const known = PLATFORMS.some((p) => fileFor(p.id) === name);
  const path = join(dir, name);
  return known && existsSync(path) && statSync(path).isFile() ? path : null;
}

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

// POSIX sh installer for macOS and Linux: picks the platform, checks the SHA-256, installs to ~/.local/bin (or
// ETHER_INSTALL_DIR) and says how to log in to this server. The server's URL is its configured public URL, never
// a request header.
export function installSh(server = config.publicUrl, dir = config.cliDist): string {
  const { binaries } = cliManifest(dir);
  const sums = binaries.map((b) => `  ${b.platform}) want=${b.sha256} ;;`).join("\n");
  return `#!/bin/sh
# Installs the ether command-line client from ${server}.
set -eu
server=${shQuote(server)}
case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "ether: no build for $(uname -s); see $server/cli" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "ether: no build for $(uname -m); see $server/cli" >&2; exit 1 ;;
esac
platform="$os-$arch"
case "$platform" in
${sums || "  __none__) want= ;;"}
  *) echo "ether: this server has no build for $platform; see $server/cli" >&2; exit 1 ;;
esac
dir="\${ETHER_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$dir"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
curl -fsSL "$server/api/cli/download/ether-$platform" -o "$tmp"
if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$tmp" | cut -d' ' -f1)"; else got="$(shasum -a 256 "$tmp" | cut -d' ' -f1)"; fi
if [ "$got" != "$want" ]; then echo "ether: checksum mismatch for ether-$platform; not installed" >&2; exit 1; fi
chmod +x "$tmp"
mv "$tmp" "$dir/ether"
trap - EXIT
echo "Installed ether to $dir/ether"
case ":$PATH:" in *":$dir:"*) ;; *) echo "Add $dir to your PATH to run it as 'ether'." ;; esac
echo "Next: create a token at $server/settings, then run"
echo "  echo \\"\\$TOKEN\\" | ether auth login --host $server --with-token"
`;
}

// The same for Windows PowerShell, installing to %LOCALAPPDATA%\\Programs\\ether.
export function installPs1(server = config.publicUrl, dir = config.cliDist): string {
  const win = cliManifest(dir).binaries.find((b) => b.platform === "windows-x64");
  if (!win) return `Write-Error "This server has no Windows build of ether; see ${server}/cli"\n`;
  return `# Installs the ether command-line client from ${server}.
$ErrorActionPreference = 'Stop'
$server = ${psQuote(server)}
$dir = if ($env:ETHER_INSTALL_DIR) { $env:ETHER_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\\ether' }
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('ether-' + [guid]::NewGuid() + '.exe')
Invoke-WebRequest -UseBasicParsing -Uri "$server/api/cli/download/${win.file}" -OutFile $tmp
if ((Get-FileHash -Algorithm SHA256 $tmp).Hash.ToLower() -ne '${win.sha256}') { Remove-Item $tmp; throw 'ether: checksum mismatch; not installed' }
Move-Item -Force $tmp (Join-Path $dir 'ether.exe')
$path = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not ($path -split ';' -contains $dir)) { [Environment]::SetEnvironmentVariable('Path', "$path;$dir", 'User'); Write-Host "Added $dir to your PATH (open a new terminal)." }
Write-Host "Installed ether to $dir\\ether.exe"
Write-Host "Next: create a token at $server/settings, then run"
Write-Host "  ether auth login --host $server --with-token"
`;
}
