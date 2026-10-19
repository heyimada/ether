# One-time setup on the host machine: build, start Ether at logon, and expose it on the tailnet.
# Safe to re-run; it replaces the scheduled task and the serve rule.
param([int]$Port = 3000)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

bun install --frozen-lockfile
bun run build

$action = New-ScheduledTaskAction -Execute "pwsh.exe" -Argument "-NoProfile -WindowStyle Hidden -File `"$root\scripts\start.ps1`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName "Ether" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName "Ether"

# HTTPS on the tailnet only. Never use `tailscale funnel`, which would publish it to the internet.
tailscale serve --bg --https=443 "http://127.0.0.1:$Port"

$dns = (tailscale status --json | ConvertFrom-Json).Self.DNSName.TrimEnd(".")
Write-Host "Ether is starting at https://$dns"
Write-Host "Create your admin account (once):  bun run ether create-admin <username> --password <password>"
