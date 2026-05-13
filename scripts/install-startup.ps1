# scripts/install-startup.ps1
# Installs three Windows scheduled tasks that turn the outreach agent into a real boot-time
# service stack:
#
#   1. "OutreachAgent-Daemon"   — runs scripts\daemon-launcher.bat at user logon. The launcher
#                                  spawns Chrome on 9223 and the agent on 3500, then supervises
#                                  the agent (auto-restart on crash with 10s backoff).
#
#   2. "OutreachAgent-Watchdog" — runs scripts\watchdog.bat every 5 minutes. Pings /api/health;
#                                  if dead, kills :3500 so the daemon loop respawns it.
#
#   3. "OutreachAgent-Tray"     — runs the Electron tray companion at user logon. Status icon
#                                  + quick actions (Pause/Resume/Restart/Open Dashboard).
#                                  Skipped automatically when -SkipTray is passed.
#
# Run from an elevated PowerShell:
#     powershell -ExecutionPolicy Bypass -File .\scripts\install-startup.ps1
#
# Skip the tray icon (e.g. server install with no graphical session):
#     powershell -ExecutionPolicy Bypass -File .\scripts\install-startup.ps1 -SkipTray
#
# Uninstall via .\scripts\uninstall-startup.ps1.
#
# All tasks run as the current interactive user so Chrome lives in the user's session and the
# saved Upwork login profile resolves to %APPDATA% correctly. They survive logoff because the
# daemon is a console process the user spawned, not a system service.

[CmdletBinding()]
param(
    [string] $RepoPath = (Resolve-Path "$PSScriptRoot\..").Path,
    [int]    $WatchdogIntervalMinutes = 5,
    [switch] $SkipTray
)

$ErrorActionPreference = "Stop"

$daemonScript    = Join-Path $RepoPath "scripts\daemon-launcher.bat"
$watchdogScript  = Join-Path $RepoPath "scripts\watchdog.bat"
$trayLauncher    = Join-Path $RepoPath "scripts\tray-launcher.bat"

if (-not (Test-Path $daemonScript))   { throw "Missing: $daemonScript" }
if (-not (Test-Path $watchdogScript)) { throw "Missing: $watchdogScript" }
if (-not $SkipTray -and -not (Test-Path $trayLauncher)) { throw "Missing: $trayLauncher (run from a fresh checkout, or pass -SkipTray)" }

Write-Host ""
Write-Host "Installing OutreachAgent scheduled tasks" -ForegroundColor Cyan
Write-Host "  Repo:     $RepoPath"
Write-Host "  User:     $env:USERNAME"
Write-Host "  Daemon:   $daemonScript"
Write-Host "  Watchdog: $watchdogScript (every $WatchdogIntervalMinutes min)"
Write-Host ""

# ── Task 1: Daemon launcher on user logon ──────────────────────────────────
$daemonAction   = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$daemonScript`"" -WorkingDirectory $RepoPath
$daemonTrigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$daemonSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)   # no timeout — supervisor runs forever
$daemonPrincipal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

Register-ScheduledTask -TaskName "OutreachAgent-Daemon" -Force `
    -Action $daemonAction -Trigger $daemonTrigger -Settings $daemonSettings -Principal $daemonPrincipal `
    -Description "Outreach agent supervisor — spawns Chrome (9223) + agent (3500) on logon, restarts agent on crash." | Out-Null

Write-Host "[OK] Registered OutreachAgent-Daemon (runs at logon)" -ForegroundColor Green

# ── Task 2: Watchdog every N minutes ──────────────────────────────────────
$watchdogAction   = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$watchdogScript`"" -WorkingDirectory $RepoPath
$watchdogTrigger  = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
    -RepetitionInterval (New-TimeSpan -Minutes $WatchdogIntervalMinutes) `
    -RepetitionDuration ([TimeSpan]::FromDays(365 * 100))
$watchdogSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
$watchdogPrincipal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

Register-ScheduledTask -TaskName "OutreachAgent-Watchdog" -Force `
    -Action $watchdogAction -Trigger $watchdogTrigger -Settings $watchdogSettings -Principal $watchdogPrincipal `
    -Description "Outreach agent health watchdog — pings /api/health every $WatchdogIntervalMinutes min, kills :3500 if dead so daemon respawns." | Out-Null

Write-Host "[OK] Registered OutreachAgent-Watchdog (every $WatchdogIntervalMinutes min)" -ForegroundColor Green

# ── Task 3: Tray companion at user logon (optional) ───────────────────────
if (-not $SkipTray) {
    $trayAction   = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$trayLauncher`"" -WorkingDirectory $RepoPath
    # Trigger 30s after logon so the daemon has time to bring the agent up before the tray
    # tries to poll /api/agent/state — avoids a "Unknown" flash on every login.
    $trayTrigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $trayTrigger.Delay = "PT30S"
    $traySettings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -ExecutionTimeLimit ([TimeSpan]::Zero)
    $trayPrincipal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

    Register-ScheduledTask -TaskName "OutreachAgent-Tray" -Force `
        -Action $trayAction -Trigger $trayTrigger -Settings $traySettings -Principal $trayPrincipal `
        -Description "Outreach agent tray companion — system-tray status icon + quick actions. Lazy launch, 30s after logon to let the daemon bring the agent up first." | Out-Null

    Write-Host "[OK] Registered OutreachAgent-Tray (30s after logon)" -ForegroundColor Green
} else {
    Write-Host "[skip] OutreachAgent-Tray (-SkipTray passed)" -ForegroundColor DarkGray
}

# ── Summary ───────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Installed. Logs land at: $env:APPDATA\.outreach-agent\logs\" -ForegroundColor Cyan
Write-Host "Manage from Task Scheduler under \\OutreachAgent-* or via:"
Write-Host "  Get-ScheduledTask -TaskName 'OutreachAgent-*'"
Write-Host "  Start-ScheduledTask -TaskName 'OutreachAgent-Daemon'   # start now"
Write-Host "  Stop-ScheduledTask  -TaskName 'OutreachAgent-Daemon'   # stop"
Write-Host ""
Write-Host "To uninstall: .\scripts\uninstall-startup.ps1"
Write-Host ""
