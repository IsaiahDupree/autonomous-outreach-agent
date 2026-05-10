# scripts/uninstall-startup.ps1
# Symmetric inverse of install-startup.ps1. Removes both scheduled tasks; safe to run when
# the tasks don't exist (idempotent).
#
# Run from an elevated PowerShell:
#     powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-startup.ps1

$ErrorActionPreference = "Stop"

foreach ($name in @("OutreachAgent-Daemon", "OutreachAgent-Watchdog", "OutreachAgent-Tray")) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($task) {
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
        Write-Host "[OK] Removed $name" -ForegroundColor Green
    } else {
        Write-Host "[skip] $name — not installed" -ForegroundColor DarkGray
    }
}

Write-Host ""
Write-Host "Logs at $env:APPDATA\.outreach-agent\logs\ are NOT deleted." -ForegroundColor Cyan
Write-Host "Remove manually if desired:  Remove-Item -Recurse `"$env:APPDATA\.outreach-agent\logs`""
