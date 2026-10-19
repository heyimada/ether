# Starts Ether bound to loopback; `tailscale serve` publishes it to the tailnet over HTTPS.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$env:ETHER_HOST = "127.0.0.1"
$env:ETHER_PORT = if ($env:ETHER_PORT) { $env:ETHER_PORT } else { "3000" }
$env:ETHER_DATA = if ($env:ETHER_DATA) { $env:ETHER_DATA } else { Join-Path $root "data" }
if (-not $env:ETHER_PUBLIC_URL) {
  $dns = (tailscale status --json | ConvertFrom-Json).Self.DNSName.TrimEnd(".")
  $env:ETHER_PUBLIC_URL = "https://$dns"
}
$env:NODE_ENV = "production"

New-Item -ItemType Directory -Force (Join-Path $env:ETHER_DATA "logs") | Out-Null

# Serve a snapshot of the web build taken at startup, so rebuilding dist/ (for example while
# developing in this checkout) can't swap the bundle under the running server.
$built = Join-Path $root "dist\client"
if (-not (Test-Path (Join-Path $built "_shell.html"))) { throw "Build the web app first: bun run build" }
$web = Join-Path $env:ETHER_DATA "web"
if (Test-Path $web) { Remove-Item -Recurse -Force $web }
Copy-Item -Recurse $built $web
$env:ETHER_WEB_DIST = $web
bun src/server/main.ts *>> (Join-Path $env:ETHER_DATA "logs\ether.log")
