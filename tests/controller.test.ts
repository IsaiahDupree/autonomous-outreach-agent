/**
 * tests/controller.test.ts — Tests for the autonomous controller
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Mock all external dependencies before imports
vi.mock("../src/config/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/services/cloud", () => ({
  getStatusCounts: vi.fn().mockResolvedValue({ queued: 3, submitted: 10, error: 1 }),
  getProposalsByFilter: vi.fn().mockResolvedValue([]),
  updateProposalStatus: vi.fn().mockResolvedValue(undefined),
  checkService: vi.fn().mockResolvedValue(true),
}));

vi.mock("../src/browser/upwork", () => ({
  getConnectsRemaining: vi.fn().mockReturnValue(50),
}));

vi.mock("../src/services/telegram", () => ({
  notify: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/services/process-control", () => ({
  getFullState: vi.fn().mockReturnValue({
    state: "running",
    pausedAt: null,
    stoppedAt: null,
    reason: null,
    pausedSystems: [],
    uptime: 3600,
    pid: 1234,
    memory: 128,
  }),
  getState: vi.fn().mockReturnValue("running"),
  isActive: vi.fn().mockReturnValue(true),
  isSystemPaused: vi.fn().mockReturnValue(false),
  pause: vi.fn(),
  resume: vi.fn(),
  pauseSystem: vi.fn(),
  resumeSystem: vi.fn(),
}));

vi.mock("../src/services/operations", () => ({
  getOpsSummary: vi.fn().mockReturnValue({
    total: 15,
    byStatus: { pending: 0, running: 1, success: 12, failed: 2, cancelled: 0 },
    byType: { scan_keywords: 8, submit_proposal: 5, check_notifications: 2 },
  }),
  getErrorPatterns: vi.fn().mockReturnValue([]),
  getRunningOps: vi.fn().mockReturnValue([]),
  getRecentErrors: vi.fn().mockReturnValue([]),
  listOps: vi.fn().mockReturnValue([]),
  createOp: vi.fn().mockReturnValue("test-op-id"),
  startOp: vi.fn(),
  completeOp: vi.fn(),
  failOp: vi.fn(),
  addStep: vi.fn(),
  completeStep: vi.fn(),
  trackedSafe: vi.fn().mockResolvedValue("new-op-id"),
}));

vi.mock("../src/client/Upwork", () => ({
  submitProposal: vi.fn().mockResolvedValue(true),
  runProposalCycle: vi.fn().mockResolvedValue(undefined),
  checkAndProcessNotifications: vi.fn().mockResolvedValue({}),
}));

// ── Tests ──

import { CONTROLLER_TOOLS, executeTool, toClaudeTools } from "../src/controller/tools";
import {
  getControllerStatus,
  isRunning,
} from "../src/controller";
import * as cloud from "../src/services/cloud";
import * as control from "../src/services/process-control";
import * as ops from "../src/services/operations";

describe("Controller Tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should have all expected tools", () => {
    const names = CONTROLLER_TOOLS.map(t => t.name);
    expect(names).toContain("check_pipeline_health");
    expect(names).toContain("get_recent_errors");
    expect(names).toContain("get_queued_proposals");
    expect(names).toContain("submit_proposal");
    expect(names).toContain("trigger_scan");
    expect(names).toContain("retry_failed_op");
    expect(names).toContain("pause_agent");
    expect(names).toContain("resume_agent");
    expect(names).toContain("send_notification");
    expect(names).toContain("get_daily_plan");
    expect(names).toContain("generate_proof");
    expect(names.length).toBe(11);
  });

  it("should convert tools to Claude API format", () => {
    const claudeTools = toClaudeTools();
    expect(claudeTools.length).toBe(11);
    for (const tool of claudeTools) {
      expect(tool).toHaveProperty("name");
      expect(tool).toHaveProperty("description");
      expect(tool).toHaveProperty("input_schema");
      expect(tool.input_schema.type).toBe("object");
    }
  });

  describe("check_pipeline_health", () => {
    it("should return full pipeline state", async () => {
      const result = await executeTool("check_pipeline_health", {});
      expect(result.ok).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data).toHaveProperty("agent");
      expect(data).toHaveProperty("operations");
      expect(data).toHaveProperty("errorPatterns");
      expect(data).toHaveProperty("proposals");
      expect(data).toHaveProperty("connects");
    });
  });

  describe("get_recent_errors", () => {
    it("should return empty array when no errors", async () => {
      const result = await executeTool("get_recent_errors", { limit: 5 });
      expect(result.ok).toBe(true);
      expect(result.data).toEqual([]);
    });

    it("should return formatted errors", async () => {
      vi.mocked(ops.getRecentErrors).mockReturnValue([
        {
          id: "abc12345-6789",
          type: "submit_proposal",
          status: "failed",
          steps: [],
          createdAt: "2025-01-01T00:00:00Z",
          startedAt: "2025-01-01T00:00:01Z",
          completedAt: "2025-01-01T00:00:05Z",
          durationMs: 4000,
          context: { jobId: "j123" },
          result: null,
          error: {
            message: "Protocol error",
            diagnosis: {
              category: "browser",
              retryable: true,
              troubleshooting: ["Check Chrome CDP"],
              summary: "Browser protocol error",
            },
          },
          parentId: null,
        },
      ]);

      const result = await executeTool("get_recent_errors", {});
      expect(result.ok).toBe(true);
      const errors = result.data as Array<Record<string, unknown>>;
      expect(errors.length).toBe(1);
      expect(errors[0].category).toBe("browser");
      expect(errors[0].retryable).toBe(true);
    });
  });

  describe("get_queued_proposals", () => {
    it("should return empty when no queued proposals", async () => {
      const result = await executeTool("get_queued_proposals", {});
      expect(result.ok).toBe(true);
      expect(result.data).toEqual([]);
    });

    it("should return formatted proposals", async () => {
      vi.mocked(cloud.getProposalsByFilter).mockResolvedValue([
        {
          job_id: "j1",
          job_title: "Build AI Bot",
          score: 8,
          budget: "$500",
          job_url: "https://upwork.com/jobs/j1",
          proposal_text: "I can help...",
          created_at: "2025-01-01T00:00:00Z",
        } as any,
      ]);

      const result = await executeTool("get_queued_proposals", { minScore: 7 });
      expect(result.ok).toBe(true);
      const proposals = result.data as Array<Record<string, unknown>>;
      expect(proposals.length).toBe(1);
      expect(proposals[0].jobId).toBe("j1");
      expect(proposals[0].score).toBe(8);
      expect(proposals[0].hasCoverLetter).toBe(true);
    });
  });

  describe("submit_proposal", () => {
    it("should fail without jobId", async () => {
      const result = await executeTool("submit_proposal", {});
      expect(result.ok).toBe(false);
      expect(result.error).toContain("jobId");
    });

    it("should fail when job not found", async () => {
      vi.mocked(cloud.getProposalsByFilter).mockResolvedValue([]);
      const result = await executeTool("submit_proposal", { jobId: "missing" });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("not found");
    });
  });

  describe("trigger_scan", () => {
    it("should reject if scan already running", async () => {
      vi.mocked(ops.getRunningOps).mockReturnValue([
        { id: "x", type: "scan_keywords", status: "running" } as any,
      ]);
      const result = await executeTool("trigger_scan", {});
      expect(result.ok).toBe(false);
      expect(result.error).toContain("already running");
    });

    it("should start scan when none running", async () => {
      vi.mocked(ops.getRunningOps).mockReturnValue([]);
      const result = await executeTool("trigger_scan", {});
      expect(result.ok).toBe(true);
    });
  });

  describe("pause_agent", () => {
    it("should pause entire agent", async () => {
      const result = await executeTool("pause_agent", { reason: "Too many errors" });
      expect(result.ok).toBe(true);
      expect(control.pause).toHaveBeenCalledWith("Too many errors");
    });

    it("should pause specific subsystem", async () => {
      const result = await executeTool("pause_agent", { system: "submitting", reason: "Low connects" });
      expect(result.ok).toBe(true);
      expect(control.pauseSystem).toHaveBeenCalledWith("submitting");
    });
  });

  describe("resume_agent", () => {
    it("should resume agent", async () => {
      const result = await executeTool("resume_agent", {});
      expect(result.ok).toBe(true);
      expect(control.resume).toHaveBeenCalled();
    });

    it("should resume specific subsystem", async () => {
      const result = await executeTool("resume_agent", { system: "scanning" });
      expect(result.ok).toBe(true);
      expect(control.resumeSystem).toHaveBeenCalledWith("scanning");
    });
  });

  describe("send_notification", () => {
    it("should send notification", async () => {
      const { notify } = await import("../src/services/telegram");
      const result = await executeTool("send_notification", { message: "Test alert" });
      expect(result.ok).toBe(true);
      expect(notify).toHaveBeenCalledWith("🤖 Test alert");
    });

    it("should fail without message", async () => {
      const result = await executeTool("send_notification", {});
      expect(result.ok).toBe(false);
    });
  });

  describe("unknown tool", () => {
    it("should return error for unknown tool", async () => {
      const result = await executeTool("nonexistent_tool", {});
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Unknown tool");
    });
  });
});

describe("Controller Status", () => {
  it("should return status when not running", () => {
    const status = getControllerStatus();
    expect(status.running).toBe(false);
    expect(status.cycleCount).toBe(0);
    expect(status.recentDecisions).toEqual([]);
  });

  it("should report not running", () => {
    expect(isRunning()).toBe(false);
  });
});
