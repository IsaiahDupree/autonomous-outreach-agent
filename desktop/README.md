# Outreach Agent — Tray Companion (Phase B)

A tiny system-tray icon that shows the agent's live status (running / paused / stopped) and gives one-click access to common actions. Talks to the agent over `localhost:3500` — does **not** manage the agent process itself (Phase A scheduled tasks own that).

## Run from source

```bash
cd desktop
npm install
npm start
```

A green/amber/red dot appears in your system tray. Right-click it for the menu.

## Tray menu

- **● Running / Paused / Stopped / Unknown** — current `/api/agent/state`. Greyed out (informational).
- **🔴 Submitting: …** — appears only when a submission is mid-flight. Shows job title, current step, elapsed seconds.
- **Open Dashboard** — opens `http://localhost:3500` (the agent serves the SPA at the root) in your default browser.
- **Pause / Resume** — POSTs to `/api/agent/pause` or `/api/agent/resume`.
- **Restart agent** — POSTs `/api/agent/stop`. The Phase A daemon respawns within ~10s.
- **Show logs folder** — opens `%APPDATA%\.outreach-agent\logs\` in Explorer.
- **Show health check** — quick popup of the `/api/health` JSON for at-a-glance debugging.
- **Quit tray app** — closes this app only. Agent and Chrome keep running under the scheduled task.

Single-clicking the tray icon also opens the dashboard.

## Build a Windows installer

```bash
npm run build:win
```

Outputs an NSIS installer to `desktop/release/`. The installer is per-user, won't request admin, and stops at user-cancellable steps. The installer registers no scheduled tasks of its own — those come from `scripts\install-startup.ps1` (Phase A).

## Design rules — why this is "tray-as-overlay" not "tray-as-supervisor"

1. **Quitting the tray must not kill the agent.** The whole point of the Phase A scheduled task is that the agent runs independently of any user-launched app. The tray is a viewer, not a parent process.
2. **No bundled Node runtime, no spawned children.** All actions go through the agent's HTTP API. If the agent isn't running, the tray turns gray and waits.
3. **Polling, not listeners.** 5-second poll is good enough for status visibility and avoids needing the agent to push events. If we need real-time later, we'll add a server-sent-events stream — not before.
4. **The icon itself is the network probe.** If the agent is unreachable, the icon goes gray within 5 seconds. That's the early-warning signal.

## Customizing

- `AGENT_BASE` env var changes the agent host (default `http://127.0.0.1:3500`).
- `DASHBOARD_URL` env var changes what "Open Dashboard" opens (default same as agent base, since the agent serves the dashboard at the root).
- Edit `icons/generate-icons.js` to change tray colors or sizes; rerun `node generate-icons.js`.
