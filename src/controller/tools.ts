/**
 * src/controller/tools.ts — Tool definitions for the autonomous controller
 * Each tool maps to an existing API endpoint or service call.
 * Claude decides which tools to call based on system state.
 */
import logger from "../config/logger";
import * as cloud from "../services/cloud";
import * as ops from "../services/operations";
import * as control from "../services/process-control";
import { getConnectsRemaining } from "../browser/upwork";
import { notify } from "../services/telegram";

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface ControllerTool {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  execute: (params: Record<string, unknown>) => Promise<ToolResult>;
}

// ── Tool implementations ──

const checkPipelineHealth: ControllerTool = {
  name: "check_pipeline_health",
  description: "Get full pipeline status: agent state, operations summary, error patterns, queued/submitted counts, connects balance",
  parameters: {},
  execute: async () => {
    const [agentState, opsSummary, errorPatterns, running, connects] = await Promise.all([
      Promise.resolve(control.getFullState()),
      Promise.resolve(ops.getOpsSummary()),
      Promise.resolve(ops.getErrorPatterns()),
      Promise.resolve(ops.getRunningOps()),
      Promise.resolve(getConnectsRemaining()),
    ]);

    let statusCounts: Record<string, number> = {};
    let queuedCount = 0;
    try {
      statusCounts = await cloud.getStatusCounts();
      const queued = await cloud.getProposalsByFilter({ status: ["queued", "auto_sending"], minScore: 5, limit: 100 });
      queuedCount = queued.length;
    } catch (e) {
      logger.warn(`[controller] Failed to fetch proposal counts: ${(e as Error).message}`);
    }

    return {
      ok: true,
      data: {
        agent: agentState,
        operations: opsSummary,
        errorPatterns,
        runningOps: running.map(o => ({ id: o.id.slice(0, 8), type: o.type, startedAt: o.startedAt })),
        proposals: { ...statusCounts, queuedAboveThreshold: queuedCount },
        connects: { remaining: connects, lowWarning: connects !== null && connects < 16 },
      },
    };
  },
};

const getRecentErrors: ControllerTool = {
  name: "get_recent_errors",
  description: "Get recent failed operations with error diagnosis and troubleshooting suggestions",
  parameters: {
    limit: { type: "number", description: "Max errors to return (default 5)" },
  },
  execute: async (params) => {
    const limit = (params.limit as number) || 5;
    const errors = ops.getRecentErrors(limit);
    return {
      ok: true,
      data: errors.map(o => ({
        id: o.id.slice(0, 8),
        type: o.type,
        error: o.error?.message?.slice(0, 200),
        category: o.error?.diagnosis.category,
        retryable: o.error?.diagnosis.retryable,
        troubleshooting: o.error?.diagnosis.troubleshooting,
        context: o.context,
        completedAt: o.completedAt,
      })),
    };
  },
};

const getQueuedProposals: ControllerTool = {
  name: "get_queued_proposals",
  description: "List queued proposals sorted by score, ready for submission",
  parameters: {
    minScore: { type: "number", description: "Minimum score threshold (default 5)" },
    limit: { type: "number", description: "Max proposals to return (default 10)" },
  },
  execute: async (params) => {
    const minScore = (params.minScore as number) || 5;
    const limit = (params.limit as number) || 10;
    try {
      const rows = await cloud.getProposalsByFilter({ status: ["queued"], minScore, limit });
      return {
        ok: true,
        data: rows.map(r => ({
          jobId: r.job_id,
          title: r.job_title,
          score: r.score,
          budget: r.budget,
          url: r.job_url,
          hasCoverLetter: !!r.proposal_text,
          createdAt: r.created_at,
        })),
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
};

const submitProposal: ControllerTool = {
  name: "submit_proposal",
  description: "Submit a single proposal by job ID. Only call when connects are sufficient (>16) and the job has a cover letter.",
  parameters: {
    jobId: { type: "string", description: "The job ID to submit", required: true },
  },
  execute: async (params) => {
    const jobId = params.jobId as string;
    if (!jobId) return { ok: false, error: "jobId is required" };

    try {
      const rows = await cloud.getProposalsByFilter({ jobId });
      if (rows.length === 0) return { ok: false, error: `Job ${jobId} not found` };
      const row = rows[0];
      if (row.status === "submitted") return { ok: true, data: { message: "Already submitted" } };
      if (!row.proposal_text) return { ok: false, error: "No cover letter — cannot submit" };

      const job = {
        id: row.job_id as string,
        title: (row.job_title as string) || "Untitled",
        description: (row.job_description as string) || "",
        url: row.job_url as string,
        budget: row.budget as string | undefined,
        score: row.score as number | undefined,
        bid: row.submitted_bid_amount as number | undefined,
        coverLetter: row.proposal_text as string | undefined,
      };

      const opId = ops.createOp("submit_proposal", { jobId, title: job.title, source: "controller" });
      ops.startOp(opId);

      await cloud.updateProposalStatus(jobId, "auto_sending");
      const { submitProposal: doSubmit } = await import("../client/Upwork");
      const ok = await doSubmit(job);
      await cloud.updateProposalStatus(jobId, ok ? "submitted" : "error");

      if (ok) {
        ops.completeOp(opId, { submitted: true });
        await notify(`🤖 *Controller submitted*\n${job.title.slice(0, 60)}\n💰 ${job.budget || "N/A"}\n🔗 ${job.url}`);
      } else {
        ops.failOp(opId, "Submission returned false");
      }
      return { ok, data: { opId: opId.slice(0, 8), title: job.title } };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
};

const triggerScan: ControllerTool = {
  name: "trigger_scan",
  description: "Trigger a manual keyword scan cycle. Only call if no scan is currently running and the queue is empty or low.",
  parameters: {},
  execute: async () => {
    const running = ops.getRunningOps();
    const scanRunning = running.some(o => o.type === "scan_keywords" || o.type === "scan_best_matches");
    if (scanRunning) return { ok: false, error: "A scan is already running" };

    const opId = ops.createOp("scan_keywords", { source: "controller" });
    ops.startOp(opId);

    // Run async — don't block
    (async () => {
      try {
        const { runProposalCycle } = await import("../client/Upwork");
        await runProposalCycle([], {}, 5);
        ops.completeOp(opId, { source: "controller" });
      } catch (e) {
        ops.failOp(opId, e as Error);
      }
    })();

    return { ok: true, data: { opId: opId.slice(0, 8), message: "Scan started" } };
  },
};

const retryFailedOp: ControllerTool = {
  name: "retry_failed_op",
  description: "Retry a failed operation by its ID. Only works for retryable errors.",
  parameters: {
    opId: { type: "string", description: "Operation ID (first 8 chars is fine)", required: true },
  },
  execute: async (params) => {
    const prefix = params.opId as string;
    if (!prefix) return { ok: false, error: "opId is required" };

    // Find the operation by prefix match
    const allOps = ops.listOps({ status: "failed", limit: 50 });
    const op = allOps.find(o => o.id.startsWith(prefix));
    if (!op) return { ok: false, error: `No failed operation matching ${prefix}` };
    if (!op.error?.diagnosis.retryable) {
      return { ok: false, error: `Error not retryable: ${op.error?.diagnosis.summary}` };
    }

    // Dispatch retry based on type
    try {
      switch (op.type) {
        case "submit_proposal": {
          const jobId = op.context.jobId as string;
          if (!jobId) return { ok: false, error: "No jobId in context" };
          const result = await submitProposal.execute({ jobId });
          return result;
        }
        case "scan_keywords":
        case "scan_best_matches": {
          return await triggerScan.execute({});
        }
        case "check_notifications": {
          const { checkAndProcessNotifications } = await import("../client/Upwork");
          const newOpId = await ops.trackedSafe("check_notifications", { source: "controller_retry" }, async () => {
            await checkAndProcessNotifications();
          });
          return { ok: true, data: { newOpId: newOpId.slice(0, 8) } };
        }
        default:
          return { ok: false, error: `Retry not implemented for ${op.type}` };
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
};

const pauseAgent: ControllerTool = {
  name: "pause_agent",
  description: "Pause the agent or a specific subsystem. Use when errors are cascading or connects are critically low.",
  parameters: {
    system: { type: "string", description: "Optional: 'scanning', 'submitting', or 'notifications'. Omit to pause everything." },
    reason: { type: "string", description: "Why are you pausing?" },
  },
  execute: async (params) => {
    const system = params.system as string | undefined;
    const reason = params.reason as string || "Controller decision";

    if (system) {
      control.pauseSystem(system);
      await notify(`🤖⏸️ *Controller paused ${system}*\nReason: ${reason}`);
    } else {
      control.pause(reason);
      await notify(`🤖⏸️ *Controller paused agent*\nReason: ${reason}`);
    }
    return { ok: true, data: control.getFullState() };
  },
};

const resumeAgent: ControllerTool = {
  name: "resume_agent",
  description: "Resume the agent or a specific subsystem after issues are resolved.",
  parameters: {
    system: { type: "string", description: "Optional: 'scanning', 'submitting', or 'notifications'. Omit to resume everything." },
  },
  execute: async (params) => {
    const system = params.system as string | undefined;
    if (system) {
      control.resumeSystem(system);
      await notify(`🤖▶️ *Controller resumed ${system}*`);
    } else {
      control.resume();
      await notify(`🤖▶️ *Controller resumed agent*`);
    }
    return { ok: true, data: control.getFullState() };
  },
};

const sendNotification: ControllerTool = {
  name: "send_notification",
  description: "Send a Telegram notification. Use for important status updates or decisions.",
  parameters: {
    message: { type: "string", description: "The message to send (supports Telegram markdown)", required: true },
  },
  execute: async (params) => {
    const message = params.message as string;
    if (!message) return { ok: false, error: "message is required" };
    try {
      await notify(`🤖 ${message}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
};

// ── Export all tools ──

export const CONTROLLER_TOOLS: ControllerTool[] = [
  checkPipelineHealth,
  getRecentErrors,
  getQueuedProposals,
  submitProposal,
  triggerScan,
  retryFailedOp,
  pauseAgent,
  resumeAgent,
  sendNotification,
];

/**
 * Convert tools to Claude API tool format
 */
export function toClaudeTools(): Anthropic.Messages.Tool[] {
  // Import type only for the return type
  return CONTROLLER_TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: {
      type: "object" as const,
      properties: Object.fromEntries(
        Object.entries(t.parameters).map(([key, val]) => [
          key,
          { type: val.type, description: val.description },
        ]),
      ),
      required: Object.entries(t.parameters)
        .filter(([, v]) => v.required)
        .map(([k]) => k),
    },
  }));
}

/**
 * Execute a tool by name
 */
export async function executeTool(name: string, params: Record<string, unknown>): Promise<ToolResult> {
  const tool = CONTROLLER_TOOLS.find(t => t.name === name);
  if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
  try {
    return await tool.execute(params);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// Need this for the return type
import type Anthropic from "@anthropic-ai/sdk";
