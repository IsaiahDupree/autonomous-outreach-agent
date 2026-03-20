/**
 * src/services/operations.ts — Stateful operation tracker
 * Every action (scan, submit, research, etc.) gets an ID, status lifecycle,
 * progress steps, error diagnosis with troubleshooting, and retry capability.
 */
import { randomUUID } from "crypto";
import logger from "../config/logger";
import { diagnoseError, type ErrorDiagnosis } from "./error-catalog";

// ── Types ──

export type OpType =
  | "scan_keywords"
  | "scan_best_matches"
  | "submit_proposal"
  | "auto_submit"
  | "batch_submit"
  | "dry_run"
  | "check_notifications"
  | "research"
  | "analytics"
  | "metrics"
  | "content_brief"
  | "snapshot";

export type OpStatus = "pending" | "running" | "success" | "failed" | "cancelled";

export interface OpStep {
  name: string;
  startedAt: string;
  completedAt: string | null;
  status: "running" | "done" | "failed";
  detail?: string;
}

export interface Operation {
  id: string;
  type: OpType;
  status: OpStatus;
  steps: OpStep[];
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  /** Arbitrary context for retry (e.g., { jobId, keywords, filters }) */
  context: Record<string, unknown>;
  result: unknown | null;
  error: {
    message: string;
    diagnosis: ErrorDiagnosis;
  } | null;
  /** Parent operation ID for child ops (e.g., batch_submit → submit_proposal) */
  parentId: string | null;
}

// ── Store ──

const MAX_OPERATIONS = 200;
const _ops = new Map<string, Operation>();
const _insertOrder: string[] = []; // track insertion order for ring buffer

function evictIfNeeded(): void {
  while (_ops.size >= MAX_OPERATIONS && _insertOrder.length > 0) {
    const oldest = _insertOrder.shift()!;
    const op = _ops.get(oldest);
    // Don't evict running operations
    if (op && (op.status === "running" || op.status === "pending")) {
      _insertOrder.push(oldest); // re-add to end
      continue;
    }
    _ops.delete(oldest);
  }
}

// ── Lifecycle ──

export function createOp(type: OpType, context: Record<string, unknown> = {}, parentId?: string): string {
  evictIfNeeded();
  const id = randomUUID();
  const op: Operation = {
    id,
    type,
    status: "pending",
    steps: [],
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    durationMs: null,
    context,
    result: null,
    error: null,
    parentId: parentId || null,
  };
  _ops.set(id, op);
  _insertOrder.push(id);
  logger.info(`[ops] Created ${type} op ${id.slice(0, 8)}`);
  return id;
}

export function startOp(id: string): void {
  const op = _ops.get(id);
  if (!op) return;
  op.status = "running";
  op.startedAt = new Date().toISOString();
}

export function completeOp(id: string, result?: unknown): void {
  const op = _ops.get(id);
  if (!op) return;
  op.status = "success";
  op.completedAt = new Date().toISOString();
  op.durationMs = op.startedAt ? Date.now() - new Date(op.startedAt).getTime() : null;
  op.result = result ?? null;
  // Mark any running steps as done
  for (const step of op.steps) {
    if (step.status === "running") {
      step.status = "done";
      step.completedAt = new Date().toISOString();
    }
  }
  logger.info(`[ops] Completed ${op.type} op ${id.slice(0, 8)} in ${op.durationMs}ms`);
}

export function failOp(id: string, error: Error | string): void {
  const op = _ops.get(id);
  if (!op) return;
  op.status = "failed";
  op.completedAt = new Date().toISOString();
  op.durationMs = op.startedAt ? Date.now() - new Date(op.startedAt).getTime() : null;
  const message = typeof error === "string" ? error : error.message;
  op.error = {
    message,
    diagnosis: diagnoseError(error),
  };
  // Mark any running steps as failed
  for (const step of op.steps) {
    if (step.status === "running") {
      step.status = "failed";
      step.completedAt = new Date().toISOString();
    }
  }
  logger.warn(`[ops] Failed ${op.type} op ${id.slice(0, 8)}: ${message.slice(0, 100)}`);
}

export function cancelOp(id: string): boolean {
  const op = _ops.get(id);
  if (!op) return false;
  if (op.status !== "pending" && op.status !== "running") return false;
  op.status = "cancelled";
  op.completedAt = new Date().toISOString();
  op.durationMs = op.startedAt ? Date.now() - new Date(op.startedAt).getTime() : null;
  logger.info(`[ops] Cancelled ${op.type} op ${id.slice(0, 8)}`);
  return true;
}

// ── Steps (intra-operation progress) ──

export function addStep(opId: string, name: string, detail?: string): void {
  const op = _ops.get(opId);
  if (!op) return;
  op.steps.push({
    name,
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: "running",
    detail,
  });
}

export function completeStep(opId: string, name: string, detail?: string): void {
  const op = _ops.get(opId);
  if (!op) return;
  const step = op.steps.find(s => s.name === name && s.status === "running");
  if (step) {
    step.status = "done";
    step.completedAt = new Date().toISOString();
    if (detail) step.detail = detail;
  }
}

// ── Queries ──

export function getOp(id: string): Operation | undefined {
  return _ops.get(id);
}

export function listOps(filter?: {
  type?: OpType;
  status?: OpStatus;
  limit?: number;
}): Operation[] {
  let ops = Array.from(_ops.values());

  if (filter?.type) ops = ops.filter(o => o.type === filter.type);
  if (filter?.status) ops = ops.filter(o => o.status === filter.status);

  // Newest first (use insertion order as tiebreaker for same-millisecond creates)
  const orderMap = new Map(_insertOrder.map((id, i) => [id, i]));
  ops.sort((a, b) => {
    const timeDiff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    if (timeDiff !== 0) return timeDiff;
    return (orderMap.get(b.id) ?? 0) - (orderMap.get(a.id) ?? 0);
  });

  if (filter?.limit) ops = ops.slice(0, filter.limit);
  return ops;
}

export function getRunningOps(): Operation[] {
  return listOps({ status: "running" });
}

export function getChildOps(parentId: string): Operation[] {
  return Array.from(_ops.values()).filter(o => o.parentId === parentId);
}

export function getOpsSummary(): {
  total: number;
  byStatus: Record<OpStatus, number>;
  byType: Record<string, number>;
} {
  const byStatus: Record<string, number> = { pending: 0, running: 0, success: 0, failed: 0, cancelled: 0 };
  const byType: Record<string, number> = {};

  for (const op of _ops.values()) {
    byStatus[op.status] = (byStatus[op.status] || 0) + 1;
    byType[op.type] = (byType[op.type] || 0) + 1;
  }

  return {
    total: _ops.size,
    byStatus: byStatus as Record<OpStatus, number>,
    byType,
  };
}

export function getRecentErrors(limit = 10): Operation[] {
  return listOps({ status: "failed", limit });
}

export function getErrorPatterns(): Array<{
  category: string;
  count: number;
  retryable: boolean;
  recentExample: string;
  troubleshooting: string[];
}> {
  const patterns = new Map<string, {
    count: number;
    retryable: boolean;
    recentExample: string;
    troubleshooting: string[];
  }>();

  for (const op of _ops.values()) {
    if (op.status !== "failed" || !op.error) continue;
    const cat = op.error.diagnosis.category;
    const existing = patterns.get(cat);
    if (existing) {
      existing.count++;
      existing.recentExample = op.error.message;
    } else {
      patterns.set(cat, {
        count: 1,
        retryable: op.error.diagnosis.retryable,
        recentExample: op.error.message,
        troubleshooting: op.error.diagnosis.troubleshooting,
      });
    }
  }

  return Array.from(patterns.entries())
    .map(([category, data]) => ({ category, ...data }))
    .sort((a, b) => b.count - a.count);
}

// ── Convenience wrapper: track an async function as an operation ──

export async function tracked<T>(
  type: OpType,
  context: Record<string, unknown>,
  fn: (opId: string) => Promise<T>,
  parentId?: string,
): Promise<{ opId: string; result: T }> {
  const opId = createOp(type, context, parentId);
  startOp(opId);
  try {
    const result = await fn(opId);
    completeOp(opId, result);
    return { opId, result };
  } catch (e) {
    failOp(opId, e as Error);
    throw e;
  }
}

/** For fire-and-forget tracked ops — catches errors instead of re-throwing */
export async function trackedSafe<T>(
  type: OpType,
  context: Record<string, unknown>,
  fn: (opId: string) => Promise<T>,
  parentId?: string,
): Promise<string> {
  const opId = createOp(type, context, parentId);
  startOp(opId);
  try {
    const result = await fn(opId);
    completeOp(opId, result);
  } catch (e) {
    failOp(opId, e as Error);
  }
  return opId;
}

// ── Reset (for testing) ──

export function _reset(): void {
  _ops.clear();
  _insertOrder.length = 0;
}
