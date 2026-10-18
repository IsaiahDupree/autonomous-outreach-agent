# Auto-startup (Phase A)

Two Windows scheduled tasks make the outreach agent a real always-on service.

## Install

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-startup.ps1
```

What it registers:

| Task | Trigger | What it does |
|---|---|---|
| `OutreachAgent-Daemon` | At user logon | Runs `scripts\daemon-launcher.bat`. Spawns Chrome on `:9223` (saved profile), spawns the agent on `:3500`, supervises both. Restarts the agent on crash with a 10s backoff. |
| `OutreachAgent-Watchdog` | Every 5 min | Runs `scripts\watchdog.bat`. Pings `http://localhost:3500/api/health`. If dead, kills the listener so the daemon respawns it. |

Both tasks run as the **current interactive user** so Chrome inherits your Upwork login session and the saved profile resolves correctly under `%APPDATA%`.

## Logs

All logs land at `%APPDATA%\.outreach-agent\logs\`:

- `daemon-YYYYMMDD-HHMMSS.log` — supervisor decisions (spawn / restart / errors)
- `agent-YYYYMMDD-HHMMSS.log`  — full agent stdout+stderr from `npm run dev`
- `watchdog.log`               — one line per health check (OK or FAIL + action taken)
- `daemon-actions.log`         — manual `stop-daemon.bat` invocations

## Manual control

```powershell
# Status
Get-ScheduledTask -TaskName 'OutreachAgent-*' | Format-Table TaskName, State, LastRunTime

# Start now (first time, or after a manual stop)
Start-ScheduledTask -TaskName 'OutreachAgent-Daemon'

# Pause the supervisor (agent stays up; no auto-restarts)
Disable-ScheduledTask -TaskName 'OutreachAgent-Daemon'

# Resume
Enable-ScheduledTask -TaskName 'OutreachAgent-Daemon'

# Stop everything (manual)
.\scripts\stop-daemon.bat
```

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-startup.ps1
```

Removes both tasks. Logs are kept (delete manually if desired).

## Behavior verified

1. **Boot/logon:** logon → Chrome spawns → CDP up on 9223 → agent spawns on 3500 → first fast-poll cycle within ~60s.
2. **Agent crash:** any non-zero exit (Puppeteer hang killed, OOM, etc.) → 10s backoff → respawn → fresh `agent-*.log`.
3. **Agent hung:** watchdog at next 5-min tick sees `/api/health` non-200 → kills :3500 → daemon supervisor loop respawns within 10s.
4. **Chrome closed:** daemon's Chrome-up check at start respawns it; if Chrome dies mid-run, the next supervisor cycle re-detects and restarts.
5. **Reboot:** task registered on user logon — survives indefinitely. No system-wide service install needed (and no admin privileges either, beyond installing the task itself).

## Limits

- **Single user.** Both tasks are user-scoped. If you log in as a different user, the agent doesn't auto-start.
- **No GUI.** This phase is headless background process management. The dashboard at `localhost:5173` is still your view into state. Phase B adds a system-tray icon for at-a-glance status + quick actions.
- **Doesn't watch Chrome separately.** If Chrome dies but the agent stays up, the agent will retry CDP attaches (see `engine.ts`) and recover. The watchdog only restarts the agent.
