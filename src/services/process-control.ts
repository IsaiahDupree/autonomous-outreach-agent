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
