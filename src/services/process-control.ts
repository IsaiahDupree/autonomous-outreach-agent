/**
 * src/services/process-control.ts — Agent process control
 * Provides pause/resume/stop for the entire agent or individual subsystems.
 * All cron jobs and scan cycles check this before running.
 */
import logger from "../config/logger";

export type AgentState = "running" | "paused" | "stopping" | "stopped";

interface ProcessState {
  state: AgentState;
  pausedAt: string | null;
  stoppedAt: string | null;
  reason: string | null;
  /** Which subsystems are individually paused (e.g., "scanning", "submitting") */
  pausedSystems: Set<string>;
}

const _state: ProcessState = {
  state: "running",
  pausedAt: null,
  stoppedAt: null,
  reason: null,
  pausedSystems: new Set(),
};

// Callbacks for stop — registered by index.ts to close server/browser
const _stopCallbacks: Array<() => Promise<void>> = [];

export function getState(): AgentState {
  return _state.state;
}

export function getFullState() {
  return {
    state: _state.state,
    pausedAt: _state.pausedAt,
    stoppedAt: _state.stoppedAt,
    reason: _state.reason,
    pausedSystems: Array.from(_state.pausedSystems),
    uptime: process.uptime(),
    pid: process.pid,
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  };
}

/** Returns true if the agent should process work (not paused or stopped) */
export function isActive(): boolean {
  return _state.state === "running";
}

/** Check if a specific subsystem is paused */
export function isSystemPaused(system: string): boolean {
  return _state.state === "paused" || _state.pausedSystems.has(system);
}

/** Pause all processing. Cron jobs will skip, in-progress work finishes. */
export function pause(reason?: string): void {
  if (_state.state === "stopped" || _state.state === "stopping") return;
  _state.state = "paused";
  _state.pausedAt = new Date().toISOString();
  _state.reason = reason || null;
  logger.info(`[control] Agent PAUSED${reason ? `: ${reason}` : ""}`);
}

/** Resume all processing. Also clears any subsystem pauses. */
export function resume(): void {
  const wasPaused = _state.state === "paused";
  if (_state.state !== "paused" && _state.pausedSystems.size === 0) return;
  if (_state.state === "stopped" || _state.state === "stopping") return;
  _state.state = "running";
  _state.pausedAt = null;
  _state.reason = null;
  _state.pausedSystems.clear();
  logger.info(`[control] Agent RESUMED${wasPaused ? ` (was paused since ${_state.pausedAt})` : ""}`);
}

/** Pause a specific subsystem (scanning, submitting, notifications) */
export function pauseSystem(system: string): void {
  _state.pausedSystems.add(system);
  logger.info(`[control] Subsystem paused: ${system}`);
}

/** Resume a specific subsystem */
export function resumeSystem(system: string): void {
  _state.pausedSystems.delete(system);
  logger.info(`[control] Subsystem resumed: ${system}`);
}

/** Register a cleanup callback for graceful stop */
export function onStop(cb: () => Promise<void>): void {
  _stopCallbacks.push(cb);
}

// ── Chrome-restart policy (cloudflare-recover-001) ─────────────────────────
// Cloudflare can wedge a Chrome session for minutes; the in-page solver can't
// always escape. process-control owns the policy for forcing a Chrome restart
// so the same logic applies to every caller (search, fast-poll, submit) and so
// we can rate-limit it — back-to-back restarts trigger Cloudflare even harder.
const RESTART_COOLDOWN_MS = 5 * 60_000;
let _lastChromeRestartAt = 0;
let _chromeRestartCount = 0;
type ChromeRestartFn = () => Promise<unknown>;
let _chromeRestartImpl: ChromeRestartFn | null = null;

/** Wired by browser/engine on first import to break the circular dep. */
export function registerChromeRestartImpl(fn: ChromeRestartFn): void {
  _chromeRestartImpl = fn;
}

export function getChromeRestartStats() {
  return {
    lastRestartAt: _lastChromeRestartAt ? new Date(_lastChromeRestartAt).toISOString() : null,
    restartCount: _chromeRestartCount,
    cooldownMs: RESTART_COOLDOWN_MS,
  };
}

/**
 * Request a Chrome restart, typically after a Cloudflare challenge has persisted
 * past the 60s solve budget. Honours a cooldown so repeated CF blocks don't
 * thrash the browser. Returns true if a restart was actually performed.
 */
export async function requestChromeRestart(reason: string): Promise<boolean> {
  const now = Date.now();
  const sinceLast = now - _lastChromeRestartAt;
  if (_lastChromeRestartAt && sinceLast < RESTART_COOLDOWN_MS) {
    logger.warn(`[control] Chrome restart skipped (cooldown ${Math.round((RESTART_COOLDOWN_MS - sinceLast) / 1000)}s remaining): ${reason}`);
    return false;
  }
  if (!_chromeRestartImpl) {
    logger.warn(`[control] Chrome restart requested but no impl registered: ${reason}`);
    return false;
  }
  _lastChromeRestartAt = now;
  _chromeRestartCount++;
  // Structured log key (cloudflare-recover-001): downstream log-analysis greps
  // for restart_reason="cf_timeout" so the field name is part of the contract.
  const restart_reason = /cloudflare/i.test(reason) ? "cf_timeout" : "other";
  logger.warn(`[control] Restarting Chrome (count=${_chromeRestartCount}): ${reason}`, {
    restart_reason,
    restart_count: _chromeRestartCount,
    reason,
  });
  try {
    await _chromeRestartImpl();
    logger.info("[control] Chrome restart complete", { restart_reason });
    return true;
  } catch (e) {
    logger.error(`[control] Chrome restart failed: ${(e as Error).message}`, { restart_reason });
    return false;
  }
}

/** Test-only: clear the cooldown so subsequent requestChromeRestart calls fire. */
export function _resetChromeRestartStateForTests(): void {
  _lastChromeRestartAt = 0;
  _chromeRestartCount = 0;
  _chromeRestartImpl = null;
}

/** Gracefully stop the agent. Runs all cleanup callbacks then exits. */
export async function stop(reason?: string): Promise<void> {
  _state.state = "stopping";
  _state.stoppedAt = new Date().toISOString();
  _state.reason = reason || null;
  logger.info(`[control] Agent STOPPING${reason ? `: ${reason}` : ""}`);

  for (const cb of _stopCallbacks) {
    try {
      await cb();
    } catch (e) {
      logger.error(`[control] Stop callback error: ${(e as Error).message}`);
    }
  }

  _state.state = "stopped";
  logger.info("[control] Agent STOPPED — exiting in 2s");
  setTimeout(() => process.exit(0), 2000);
}
