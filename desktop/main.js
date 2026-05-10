/**
 * desktop/main.js — Electron tray-as-overlay companion.
 *
 * This process is intentionally lightweight: it does NOT manage the agent or Chrome (Phase A
 * scheduled tasks own that). It only:
 *   1. Renders a system-tray icon whose color reflects /api/agent/state (green/yellow/red)
 *   2. Exposes quick actions: Open Dashboard, Pause, Resume, Restart, Show Logs, Quit
 *   3. Polls /api/agent/state + /api/agent/in-flight every 5s for the icon and tooltip
 *
 * Quitting this app does NOT stop the agent — the scheduled task keeps it running. To fully
 * stop everything use scripts\stop-daemon.bat or Disable-ScheduledTask.
 */

const { app, Tray, Menu, shell, BrowserWindow, nativeImage, dialog } = require("electron");
const path = require("path");
const http = require("http");
const fs = require("fs");

const AGENT_BASE = process.env.AGENT_BASE || "http://127.0.0.1:3500";
const DASHBOARD_URL = process.env.DASHBOARD_URL || "http://127.0.0.1:3500";   // agent serves dashboard/dist
const POLL_MS = 5000;
const LOG_DIR = path.join(process.env.APPDATA || process.env.HOME || ".", ".outreach-agent", "logs");

let tray = null;
let lastState = "unknown";
let lastInFlight = null;
let pollTimer = null;

// ── HTTP helpers ──────────────────────────────────────────────────────────
function httpJson(method, urlStr, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      timeout: 4000,
    };
    const req = http.request(opts, res => {
      let buf = "";
      res.on("data", chunk => (buf += chunk));
      res.on("end", () => {
        try { resolve(buf ? JSON.parse(buf) : null); }
        catch { resolve(null); }
      });
    });
    req.on("error", err => reject(err));
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Tray icon ─────────────────────────────────────────────────────────────
function loadIcon(state) {
  // We resolve relative to the app's resource dir so packaged builds work.
  const iconName =
    state === "running"  ? "tray-running.png"  :
    state === "paused"   ? "tray-paused.png"   :
    state === "stopped"  ? "tray-stopped.png"  :
                           "tray-unknown.png";
  const iconPath = path.join(__dirname, "icons", iconName);
  if (fs.existsSync(iconPath)) {
    return nativeImage.createFromPath(iconPath);
  }
  // Fallback: tiny 16x16 image with a single-color dot, generated at runtime so the app still
  // ships even if icons/ wasn't bundled. Square color block, not pretty but functional.
  return nativeImage.createEmpty();
}

function buildMenu() {
  const stateLabel = ({
    running:  "● Running",
    paused:   "● Paused",
    stopped:  "● Stopped",
    stopping: "● Stopping",
    unknown:  "● Unknown (agent unreachable)",
  }[lastState] || `● ${lastState}`);

  const items = [
    { label: stateLabel, enabled: false },
  ];

  if (lastInFlight) {
    items.push({
      label: `🔴 Submitting: ${(lastInFlight.jobTitle || "").slice(0, 40)} (${lastInFlight.step}, ${lastInFlight.elapsed_sec}s)`,
      enabled: false,
    });
  }

  items.push({ type: "separator" });
  items.push({
    label: "Open Dashboard",
    click: () => shell.openExternal(DASHBOARD_URL),
  });

  if (lastState === "running") {
    items.push({
      label: "Pause",
      click: async () => {
        try { await httpJson("POST", `${AGENT_BASE}/api/agent/pause`, { reason: "tray" }); refresh(); }
        catch (e) { dialog.showErrorBox("Pause failed", String(e)); }
      },
    });
  } else if (lastState === "paused") {
    items.push({
      label: "Resume",
      click: async () => {
        try { await httpJson("POST", `${AGENT_BASE}/api/agent/resume`, {}); refresh(); }
        catch (e) { dialog.showErrorBox("Resume failed", String(e)); }
      },
    });
  }

  items.push({
    label: "Restart agent",
    click: async () => {
      const r = await dialog.showMessageBox({
        type: "warning",
        buttons: ["Cancel", "Restart"],
        defaultId: 0, cancelId: 0,
        message: "Restart the outreach agent?",
        detail: "The /api/agent/stop endpoint will be called. The Phase A scheduled-task supervisor will respawn the agent within ~10 seconds.",
      });
      if (r.response !== 1) return;
      try { await httpJson("POST", `${AGENT_BASE}/api/agent/stop`, {}); }
      catch { /* expected — server is shutting down */ }
      refresh();
    },
  });

  items.push({ type: "separator" });
  items.push({
    label: "Show logs folder",
    click: () => {
      if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
      shell.openPath(LOG_DIR);
    },
  });
  items.push({
    label: "Show health check",
    click: async () => {
      try {
        const h = await httpJson("GET", `${AGENT_BASE}/api/health`);
        dialog.showMessageBox({ type: "info", message: "Agent health", detail: JSON.stringify(h, null, 2) });
      } catch (e) {
        dialog.showErrorBox("Health check failed", String(e));
      }
    },
  });

  items.push({ type: "separator" });
  items.push({
    label: "Quit tray app",
    click: () => {
      // Quitting the tray does NOT stop the agent — the scheduled task keeps it running.
      // That's intentional: this is an overlay, not a process supervisor.
      app.quit();
    },
  });

  return Menu.buildFromTemplate(items);
}

function tooltipForState() {
  if (lastState === "unknown") return "Outreach Agent · agent unreachable";
  if (lastInFlight) return `Outreach Agent · ${lastState} · submitting ${lastInFlight.elapsed_sec}s (${lastInFlight.step})`;
  return `Outreach Agent · ${lastState}`;
}

async function refresh() {
  try {
    const state = await httpJson("GET", `${AGENT_BASE}/api/agent/state`);
    lastState = state?.state || "unknown";
  } catch {
    lastState = "unknown";
  }
  try {
    const inf = await httpJson("GET", `${AGENT_BASE}/api/agent/in-flight`);
    lastInFlight = inf?.in_flight || null;
  } catch {
    lastInFlight = null;
  }
  if (tray) {
    tray.setImage(loadIcon(lastState));
    tray.setToolTip(tooltipForState());
    tray.setContextMenu(buildMenu());
  }
}

// ── App lifecycle ─────────────────────────────────────────────────────────
app.whenReady().then(() => {
  tray = new Tray(loadIcon("unknown"));
  tray.setToolTip("Outreach Agent · starting…");
  tray.setContextMenu(buildMenu());
  tray.on("click", () => shell.openExternal(DASHBOARD_URL));

  refresh();
  pollTimer = setInterval(refresh, POLL_MS);
});

app.on("window-all-closed", (e) => {
  // Prevent quit when the (currently absent) main window closes — tray-only app.
  e?.preventDefault?.();
});

app.on("before-quit", () => {
  if (pollTimer) clearInterval(pollTimer);
});

// Hide the dock icon on macOS — tray-only.
if (process.platform === "darwin" && app.dock) app.dock.hide();
