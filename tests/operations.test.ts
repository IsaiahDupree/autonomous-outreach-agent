/**
 * tests/operations.test.ts — Tests for error-catalog + operations tracker
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock logger before importing modules
vi.mock("../src/config/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { diagnoseError } from "../src/services/error-catalog";
import {
  createOp, startOp, completeOp, failOp, cancelOp,
  addStep, completeStep,
  getOp, listOps, getRunningOps, getChildOps,
  getOpsSummary, getRecentErrors, getErrorPatterns,
  tracked, trackedSafe, _reset,
} from "../src/services/operations";

// ── Error Catalog ──

describe("diagnoseError", () => {
  it("detects browser errors", () => {
    const d = diagnoseError(new Error("Protocol error: Target closed"));
    expect(d.category).toBe("browser");
    expect(d.retryable).toBe(true);
    expect(d.troubleshooting.length).toBeGreaterThan(0);
  });

  it("detects timeout errors", () => {
    const d = diagnoseError("Navigation timeout of 30000ms exceeded");
    expect(d.category).toBe("browser");
    expect(d.retryable).toBe(true);
  });

  it("detects network errors", () => {
    const d = diagnoseError(new Error("net::ERR_CONNECTION_REFUSED"));
    expect(d.category).toBe("network");
    expect(d.retryable).toBe(true);
  });

  it("detects cloudflare challenges", () => {
    const d = diagnoseError("Cloudflare challenge detected on page");
    expect(d.category).toBe("cloudflare");
    expect(d.retryable).toBe(true);
  });

  it("detects auth errors", () => {
    const d = diagnoseError("401 Unauthorized — login required");
    expect(d.category).toBe("auth");
    expect(d.retryable).toBe(true);
  });

  it("detects 403 as non-retryable", () => {
    const d = diagnoseError("403 Forbidden");
    expect(d.category).toBe("auth");
    expect(d.retryable).toBe(false);
  });

  it("detects rate limiting", () => {
    const d = diagnoseError("429 Too Many Requests");
    expect(d.category).toBe("rate_limit");
    expect(d.retryable).toBe(true);
  });

  it("detects form errors", () => {
    const d = diagnoseError("Cover letter is empty after generation");
    expect(d.category).toBe("form");
    expect(d.retryable).toBe(true);
  });

  it("detects connects issues", () => {
    const d = diagnoseError("Not enough connects to submit proposal");
    expect(d.category).toBe("form");
    expect(d.retryable).toBe(false);
  });

  it("detects config errors", () => {
    const d = diagnoseError("Missing SUPABASE key in environment");
    expect(d.category).toBe("config");
    expect(d.retryable).toBe(false);
  });

  it("detects Claude API errors", () => {
    const d = diagnoseError("Anthropic API overloaded error (529)");
    expect(d.category).toBe("rate_limit");
    expect(d.retryable).toBe(true);
  });

  it("returns unknown for unrecognized errors", () => {
    const d = diagnoseError("Something completely unexpected happened");
    expect(d.category).toBe("unknown");
    expect(d.retryable).toBe(false);
    expect(d.summary).toContain("Something completely unexpected");
  });

  it("handles string errors", () => {
    const d = diagnoseError("Session closed unexpectedly");
    expect(d.category).toBe("browser");
  });
});

// ── Operations Tracker ──

describe("operations", () => {
  beforeEach(() => {
    _reset();
  });

  describe("lifecycle", () => {
    it("creates an operation", () => {
      const id = createOp("scan_keywords", { keywords: ["AI"] });
      const op = getOp(id);
      expect(op).toBeDefined();
      expect(op!.type).toBe("scan_keywords");
      expect(op!.status).toBe("pending");
      expect(op!.context.keywords).toEqual(["AI"]);
    });

    it("starts an operation", () => {
      const id = createOp("submit_proposal");
      startOp(id);
      const op = getOp(id);
      expect(op!.status).toBe("running");
      expect(op!.startedAt).toBeTruthy();
    });

    it("completes an operation", () => {
      const id = createOp("scan_keywords");
      startOp(id);
      completeOp(id, { jobsFound: 5 });
      const op = getOp(id);
      expect(op!.status).toBe("success");
      expect(op!.completedAt).toBeTruthy();
      expect(op!.durationMs).toBeGreaterThanOrEqual(0);
      expect(op!.result).toEqual({ jobsFound: 5 });
    });

    it("fails an operation with diagnosis", () => {
      const id = createOp("submit_proposal");
      startOp(id);
      failOp(id, new Error("Protocol error: Target closed"));
      const op = getOp(id);
      expect(op!.status).toBe("failed");
      expect(op!.error).toBeDefined();
      expect(op!.error!.diagnosis.category).toBe("browser");
      expect(op!.error!.diagnosis.retryable).toBe(true);
      expect(op!.error!.diagnosis.troubleshooting.length).toBeGreaterThan(0);
    });

    it("cancels a pending operation", () => {
      const id = createOp("scan_keywords");
      const ok = cancelOp(id);
      expect(ok).toBe(true);
      expect(getOp(id)!.status).toBe("cancelled");
    });

    it("cancels a running operation", () => {
      const id = createOp("scan_keywords");
      startOp(id);
      const ok = cancelOp(id);
      expect(ok).toBe(true);
      expect(getOp(id)!.status).toBe("cancelled");
    });

    it("cannot cancel a completed operation", () => {
      const id = createOp("scan_keywords");
      startOp(id);
      completeOp(id);
      const ok = cancelOp(id);
      expect(ok).toBe(false);
      expect(getOp(id)!.status).toBe("success");
    });

    it("cannot cancel a failed operation", () => {
      const id = createOp("scan_keywords");
      startOp(id);
      failOp(id, "boom");
      const ok = cancelOp(id);
      expect(ok).toBe(false);
    });
  });

  describe("steps", () => {
    it("tracks progress steps", () => {
      const id = createOp("scan_keywords");
      startOp(id);
      addStep(id, "search", "Searching 10 keywords");
      addStep(id, "score", "Scoring 5 jobs");
      completeStep(id, "search", "Found 5 jobs");
      completeStep(id, "score", "3 passed");
      completeOp(id);

      const op = getOp(id);
      expect(op!.steps).toHaveLength(2);
      expect(op!.steps[0].status).toBe("done");
      expect(op!.steps[0].detail).toBe("Found 5 jobs");
      expect(op!.steps[1].status).toBe("done");
    });

    it("marks running steps as done on complete", () => {
      const id = createOp("scan_keywords");
      startOp(id);
      addStep(id, "search");
      completeOp(id);
      expect(getOp(id)!.steps[0].status).toBe("done");
    });

    it("marks running steps as failed on fail", () => {
      const id = createOp("scan_keywords");
      startOp(id);
      addStep(id, "search");
      failOp(id, "boom");
      expect(getOp(id)!.steps[0].status).toBe("failed");
    });
  });

  describe("queries", () => {
    it("lists ops filtered by type", () => {
      createOp("scan_keywords");
      createOp("submit_proposal");
      createOp("scan_keywords");
      const scans = listOps({ type: "scan_keywords" });
      expect(scans).toHaveLength(2);
    });

    it("lists ops filtered by status", () => {
      const id1 = createOp("scan_keywords");
      const id2 = createOp("submit_proposal");
      startOp(id1);
      startOp(id2);
      completeOp(id1);
      expect(listOps({ status: "success" })).toHaveLength(1);
      expect(listOps({ status: "running" })).toHaveLength(1);
    });

    it("returns newest first", () => {
      const id1 = createOp("scan_keywords");
      const id2 = createOp("submit_proposal");
      const ops = listOps();
      expect(ops[0].id).toBe(id2);
      expect(ops[1].id).toBe(id1);
    });

    it("limits results", () => {
      for (let i = 0; i < 10; i++) createOp("scan_keywords");
      expect(listOps({ limit: 3 })).toHaveLength(3);
    });

    it("gets running ops", () => {
      const id1 = createOp("scan_keywords");
      const id2 = createOp("submit_proposal");
      startOp(id1);
      expect(getRunningOps()).toHaveLength(1);
      expect(getRunningOps()[0].id).toBe(id1);
    });

    it("gets child ops", () => {
      const parentId = createOp("batch_submit");
      createOp("submit_proposal", { jobId: "1" }, parentId);
      createOp("submit_proposal", { jobId: "2" }, parentId);
      createOp("scan_keywords"); // not a child
      expect(getChildOps(parentId)).toHaveLength(2);
    });

    it("gets summary", () => {
      const id1 = createOp("scan_keywords");
      const id2 = createOp("submit_proposal");
      startOp(id1);
      completeOp(id1);
      startOp(id2);
      failOp(id2, "error");

      const summary = getOpsSummary();
      expect(summary.total).toBe(2);
      expect(summary.byStatus.success).toBe(1);
      expect(summary.byStatus.failed).toBe(1);
      expect(summary.byType.scan_keywords).toBe(1);
      expect(summary.byType.submit_proposal).toBe(1);
    });

    it("gets recent errors", () => {
      const id1 = createOp("scan_keywords");
      const id2 = createOp("submit_proposal");
      startOp(id1); failOp(id1, "Protocol error: Target closed");
      startOp(id2); failOp(id2, "429 Too Many Requests");

      const errors = getRecentErrors();
      expect(errors).toHaveLength(2);
    });

    it("gets error patterns", () => {
      for (let i = 0; i < 3; i++) {
        const id = createOp("scan_keywords");
        startOp(id);
        failOp(id, "Protocol error: Target closed");
      }
      const id = createOp("submit_proposal");
      startOp(id);
      failOp(id, "429 rate limit exceeded");

      const patterns = getErrorPatterns();
      expect(patterns).toHaveLength(2);
      expect(patterns[0].category).toBe("browser"); // 3 hits
      expect(patterns[0].count).toBe(3);
      expect(patterns[1].category).toBe("rate_limit"); // 1 hit
    });
  });

  describe("ring buffer", () => {
    it("evicts old completed ops when at capacity", () => {
      // Fill to capacity
      for (let i = 0; i < 200; i++) {
        const id = createOp("scan_keywords");
        startOp(id);
        completeOp(id);
      }
      // Should still be at 200
      expect(listOps().length).toBeLessThanOrEqual(200);

      // Adding one more should evict the oldest
      createOp("submit_proposal");
      expect(listOps().length).toBeLessThanOrEqual(200);
    });

    it("does not evict running ops", () => {
      // Create one running op
      const runningId = createOp("scan_keywords");
      startOp(runningId);

      // Fill rest with completed ops
      for (let i = 0; i < 200; i++) {
        const id = createOp("submit_proposal");
        startOp(id);
        completeOp(id);
      }

      // Running op should still exist
      expect(getOp(runningId)).toBeDefined();
      expect(getOp(runningId)!.status).toBe("running");
    });
  });

  describe("tracked wrapper", () => {
    it("tracks a successful async function", async () => {
      const { opId, result } = await tracked(
        "scan_keywords",
        { keywords: ["AI"] },
        async () => ({ found: 5 }),
      );

      const op = getOp(opId);
      expect(op!.status).toBe("success");
      expect(result).toEqual({ found: 5 });
    });

    it("tracks a failing async function", async () => {
      await expect(
        tracked("submit_proposal", { jobId: "123" }, async () => {
          throw new Error("Protocol error: Target closed");
        })
      ).rejects.toThrow("Protocol error");

      const ops = listOps({ type: "submit_proposal" });
      expect(ops[0].status).toBe("failed");
      expect(ops[0].error!.diagnosis.category).toBe("browser");
    });

    it("trackedSafe does not throw", async () => {
      const opId = await trackedSafe(
        "submit_proposal",
        { jobId: "123" },
        async () => { throw new Error("boom"); }
      );

      const op = getOp(opId);
      expect(op!.status).toBe("failed");
    });

    it("trackedSafe tracks success", async () => {
      const opId = await trackedSafe(
        "scan_keywords",
        {},
        async () => "done",
      );
      expect(getOp(opId)!.status).toBe("success");
    });

    it("tracked supports parent ID", async () => {
      const parentId = createOp("batch_submit");
      const { opId } = await tracked(
        "submit_proposal",
        { jobId: "1" },
        async () => true,
        parentId,
      );
      expect(getOp(opId)!.parentId).toBe(parentId);
    });
  });
});
