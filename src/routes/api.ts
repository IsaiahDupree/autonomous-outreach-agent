/**
 * src/routes/api.ts — REST endpoints
 */
import { Router, Request, Response } from "express";
import * as cloud from "../services/cloud";
import { checkCDP } from "../client/Chrome";
import { SAFARI_UPWORK_PORT, SAFARI_LINKEDIN_PORT } from "../secret";
import logger from "../config/logger";
import { submitProposal, buildProposal } from "../client/Upwork";
import type { UpworkJob } from "../client/Upwork";
import { getConnectsRemaining } from "../browser/upwork";
import * as tg from "../services/telegram";
import * as control from "../services/process-control";
import * as ops from "../services/operations";

const router = Router();

// ── Agent Process Control ──

// GET /api/agent/state — Current agent state + uptime + memory
router.get("/agent/state", (_req: Request, res: Response) => {
  res.json(control.getFullState());
});

// POST /api/agent/pause — Pause all processing (cron jobs skip, in-progress work finishes)
router.post("/agent/pause", async (req: Request, res: Response) => {
  const { reason, system } = req.body as { reason?: string; system?: string };
  if (system) {
    control.pauseSystem(system);
    res.json({ ok: true, message: `Subsystem "${system}" paused`, state: control.getFullState() });
  } else {
    control.pause(reason);
    await tg.notify(`⏸️ *Agent paused*${reason ? `\nReason: ${reason}` : ""}\nSend /resume to restart`);
    res.json({ ok: true, message: "Agent paused", state: control.getFullState() });
  }
});

// POST /api/agent/resume — Resume processing
router.post("/agent/resume", async (req: Request, res: Response) => {
  const { system } = req.body as { system?: string };
  if (system) {
    control.resumeSystem(system);
    res.json({ ok: true, message: `Subsystem "${system}" resumed`, state: control.getFullState() });
  } else {
    control.resume();
    await tg.notify("▶️ *Agent resumed* — all systems active");
    res.json({ ok: true, message: "Agent resumed", state: control.getFullState() });
  }
});

// POST /api/agent/stop — Graceful shutdown (closes browser, server, exits)
router.post("/agent/stop", async (req: Request, res: Response) => {
  const { reason } = req.body as { reason?: string };
  await tg.notify(`🛑 *Agent stopping*${reason ? `\nReason: ${reason}` : ""}`);
  res.json({ ok: true, message: "Agent stopping..." });
  // Give response time to flush, then stop
  setTimeout(() => control.stop(reason), 500);
});

// ── Operations Tracking ──

// GET /api/ops — List operations (filter: ?type=, ?status=, ?limit=)
router.get("/ops", (_req: Request, res: Response) => {
  const type = _req.query.type as ops.OpType | undefined;
  const status = _req.query.status as ops.OpStatus | undefined;
  const limit = parseInt(_req.query.limit as string) || 50;
  const list = ops.listOps({ type, status, limit });
  res.json({ count: list.length, operations: list });
});

// GET /api/ops/summary — Counts by status/type
router.get("/ops/summary", (_req: Request, res: Response) => {
  res.json(ops.getOpsSummary());
});

// GET /api/ops/running — Active operations
router.get("/ops/running", (_req: Request, res: Response) => {
  const running = ops.getRunningOps();
  res.json({ count: running.length, operations: running });
});

// GET /api/ops/errors — Recent failures + error patterns + troubleshooting
router.get("/ops/errors", (_req: Request, res: Response) => {
  const limit = parseInt(_req.query.limit as string) || 10;
  const recentErrors = ops.getRecentErrors(limit);
  const patterns = ops.getErrorPatterns();
  res.json({
    recentErrors: recentErrors.map(o => ({
      id: o.id,
      type: o.type,
      error: o.error,
      completedAt: o.completedAt,
      context: o.context,
    })),
    patterns,
  });
});

// GET /api/ops/:id — Single op detail with children
router.get("/ops/:id", (req: Request, res: Response) => {
  const op = ops.getOp(req.params.id);
  if (!op) {
    res.status(404).json({ error: "Operation not found" });
    return;
  }
  const children = ops.getChildOps(op.id);
  res.json({ ...op, children: children.length > 0 ? children : undefined });
});

// POST /api/ops/:id/cancel — Cancel pending/running op
router.post("/ops/:id/cancel", (req: Request, res: Response) => {
  const ok = ops.cancelOp(req.params.id);
  if (!ok) {
    res.status(400).json({ error: "Cannot cancel — op not pending or running" });
    return;
  }
  res.json({ ok: true, operation: ops.getOp(req.params.id) });
});

// POST /api/ops/:id/retry — Retry failed op (dispatches by type+context)
router.post("/ops/:id/retry", async (req: Request, res: Response) => {
  const op = ops.getOp(req.params.id);
  if (!op) {
    res.status(404).json({ error: "Operation not found" });
    return;
  }
  if (op.status !== "failed") {
    res.status(400).json({ error: "Only failed operations can be retried" });
    return;
  }
  if (!op.error?.diagnosis.retryable) {
    res.status(400).json({
      error: "This error is not retryable",
      diagnosis: op.error?.diagnosis,
    });
    return;
  }

  // Dispatch retry based on operation type
  try {
    let newOpId: string;
    switch (op.type) {
      case "scan_keywords": {
        const { runProposalCycle } = await import("../client/Upwork");
        newOpId = await ops.trackedSafe("scan_keywords", op.context, async (opId) => {
          ops.addStep(opId, "scan", "Retrying keyword scan");
          await runProposalCycle(
            op.context.keywords as string[],
            op.context.filters as any,
            op.context.scoreThreshold as number,
          );
        });
        break;
      }
      case "scan_best_matches": {
        const { runBestMatchesCycle } = await import("../client/Upwork");
        newOpId = await ops.trackedSafe("scan_best_matches", op.context, async () => {
          await runBestMatchesCycle(op.context.scoreThreshold as number);
        });
        break;
      }
      case "submit_proposal": {
        const jobId = op.context.jobId as string;
        if (!jobId) {
          res.status(400).json({ error: "No jobId in context — cannot retry" });
          return;
        }
        // Re-trigger via the submit endpoint logic
        const rows = await cloud.getProposalsByFilter({ jobId });
        if (rows.length === 0) {
          res.status(404).json({ error: `Job ${jobId} not found` });
          return;
        }
        const row = rows[0];
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
        newOpId = ops.createOp("submit_proposal", { jobId });
        ops.startOp(newOpId);
        // Run async
        (async () => {
          try {
            await cloud.updateProposalStatus(jobId, "auto_sending");
            const ok = await submitProposal(job);
            await cloud.updateProposalStatus(jobId, ok ? "submitted" : "error");
            if (ok) ops.completeOp(newOpId, { submitted: true });
            else ops.failOp(newOpId, "Submission returned false");
          } catch (e) {
            ops.failOp(newOpId, e as Error);
            await cloud.updateProposalStatus(jobId, "error").catch(() => {});
          }
        })();
        break;
      }
      case "check_notifications": {
        const { checkAndProcessNotifications } = await import("../client/Upwork");
        newOpId = await ops.trackedSafe("check_notifications", {}, async () => {
          await checkAndProcessNotifications();
        });
        break;
      }
      default:
        res.status(400).json({ error: `Retry not implemented for type: ${op.type}` });
        return;
    }
    res.json({ ok: true, originalOpId: op.id, newOpId, message: "Retry dispatched" });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Health
router.get("/health", async (_req: Request, res: Response) => {
  const [upworkUp, linkedinUp, cdpUp] = await Promise.all([
    cloud.checkService(SAFARI_UPWORK_PORT),
    cloud.checkService(SAFARI_LINKEDIN_PORT),
    checkCDP(),
  ]);
  res.json({
    status: "ok",
    services: {
      upwork_safari: upworkUp ? "UP" : "DOWN",
      linkedin_safari: linkedinUp ? "UP" : "DOWN",
      chrome_cdp: cdpUp ? "UP" : "DOWN",
    },
    timestamp: new Date().toISOString(),
  });
});

// Upwork proposals queue
router.get("/upwork/proposals", async (_req: Request, res: Response) => {
  try {
    const proposals = await cloud.getPendingProposals();
    res.json({ count: proposals.length, proposals });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Trigger a cycle manually
router.post("/upwork/scan", async (_req: Request, res: Response) => {
  logger.info("[api] Manual upwork scan triggered");
  const opId = ops.createOp("scan_keywords", { source: "api" });
  ops.startOp(opId);
  res.json({ ok: true, message: "Upwork scan started", opId });

  // Run async with tracking
  (async () => {
    try {
      const { runProposalCycle } = await import("../client/Upwork");
      // Import keywords/filters from index — they're module-level constants
      // Use defaults since these aren't exported
      ops.addStep(opId, "scan", "Running keyword search cycle");
      await runProposalCycle([], {}, 5); // Will use internal defaults
      ops.completeOp(opId, { source: "api" });
    } catch (e) {
      ops.failOp(opId, e as Error);
    }
  })();
});

router.post("/chrome/discover", async (_req: Request, res: Response) => {
  logger.info("[api] Manual chrome discovery triggered");
  res.json({ ok: true, message: "Chrome discovery queued" });
});

// Connects balance
router.get("/connects", (_req: Request, res: Response) => {
  const connects = getConnectsRemaining();
  res.json({ connects, warning: connects !== null && connects < 16 ? "LOW — pausing auto-submissions" : null });
});

// Close rate metrics
router.get("/metrics", async (_req: Request, res: Response) => {
  try {
    const { getCloseRateMetrics } = await import("../client/Upwork");
    const metrics = await getCloseRateMetrics();
    res.json(metrics);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Record proposal outcome (won/rejected/no_response/interviewed)
router.post("/upwork/outcome", async (req: Request, res: Response) => {
  const { jobId, outcome } = req.body as { jobId?: string; outcome?: string };
  if (!jobId || !outcome || !["won", "rejected", "no_response", "interviewed"].includes(outcome)) {
    res.status(400).json({ error: "Required: jobId, outcome (won|rejected|no_response|interviewed)" });
    return;
  }
  try {
    await cloud.recordOutcome(jobId, outcome as "won" | "rejected" | "no_response" | "interviewed");
    logger.info(`[api] Recorded outcome: ${jobId} → ${outcome}`);
    res.json({ ok: true, jobId, outcome });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ── Dry-run: test a single proposal without submitting ──
// POST /api/upwork/dry-run { jobId: "..." }
router.post("/upwork/dry-run", async (req: Request, res: Response) => {
  const { jobId } = req.body as { jobId?: string };
  if (!jobId) {
    res.status(400).json({ error: "Required: jobId" });
    return;
  }
  try {
    const rows = await cloud.getProposalsByFilter({ jobId });
    if (rows.length === 0) {
      res.status(404).json({ error: `Job ${jobId} not found` });
      return;
    }
    const row = rows[0];
    const job: UpworkJob = {
      id: row.job_id as string,
      title: (row.job_title as string) || "Untitled",
      description: (row.job_description as string) || (row.job_title as string) || "",
      url: row.job_url as string,
      budget: row.budget as string | undefined,
      score: row.score as number | undefined,
      bid: row.submitted_bid_amount as number | undefined,
      coverLetter: row.proposal_text as string | undefined,
    };

    logger.info(`[api] Dry-run triggered for: ${job.title.slice(0, 50)}`);
    const ok = await submitProposal(job, { dryRun: true });
    res.json({
      ok,
      jobId,
      title: job.title,
      score: job.score,
      hasCoverLetter: !!job.coverLetter && job.coverLetter.trim().length > 0,
      coverLetterLength: job.coverLetter?.length || 0,
      message: ok ? "Dry-run PASSED — form fills correctly, submit button ready" : "Dry-run FAILED — check server logs for details",
    });
  } catch (e) {
    logger.error(`[api] Dry-run error: ${(e as Error).message}`);
    res.status(500).json({ error: (e as Error).message });
  }
});

// ── Dry-run batch: test all queued jobs without submitting ──
// POST /api/upwork/dry-run-batch { minScore?: 7, limit?: 5 }
router.post("/upwork/dry-run-batch", async (req: Request, res: Response) => {
  const { minScore = 7, limit = 5, statuses = ["queued", "error"] } = req.body as {
    minScore?: number; limit?: number; statuses?: string[];
  };
  try {
    const rows = await cloud.getProposalsByFilter({ status: statuses, minScore, limit });
    if (rows.length === 0) {
      res.json({ ok: true, message: "No jobs to test", results: [] });
      return;
    }

    logger.info(`[api] Dry-run batch: testing ${rows.length} jobs (minScore=${minScore})`);
    const results: Array<{ jobId: string; title: string; score: number; pass: boolean; error?: string }> = [];

    for (const row of rows) {
      const job: UpworkJob = {
        id: row.job_id as string,
        title: (row.job_title as string) || "Untitled",
        description: (row.job_description as string) || (row.job_title as string) || "",
        url: row.job_url as string,
        budget: row.budget as string | undefined,
        score: row.score as number | undefined,
        bid: row.submitted_bid_amount as number | undefined,
        coverLetter: row.proposal_text as string | undefined,
      };

      try {
        const ok = await submitProposal(job, { dryRun: true });
        results.push({ jobId: job.id, title: job.title, score: job.score || 0, pass: ok });
        logger.info(`[api] Dry-run: ${ok ? "PASS" : "FAIL"} [${job.score}/10] ${job.title.slice(0, 50)}`);
      } catch (e) {
        results.push({ jobId: job.id, title: job.title, score: job.score || 0, pass: false, error: (e as Error).message });
        logger.error(`[api] Dry-run error for ${job.id}: ${(e as Error).message}`);
      }
      await new Promise(r => setTimeout(r, 2000));
    }

    const passed = results.filter(r => r.pass).length;
    res.json({
      ok: passed === results.length,
      tested: results.length,
      passed,
      failed: results.length - passed,
      results,
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ── Dashboard: full status overview ──
router.get("/upwork/status", async (_req: Request, res: Response) => {
  try {
    const [counts, submitted, queued, errors] = await Promise.all([
      cloud.getStatusCounts(),
      cloud.getProposalsByFilter({ status: "submitted", limit: 50 }),
      cloud.getProposalsByFilter({ status: ["queued", "auto_sending"], minScore: 5, limit: 50 }),
      cloud.getProposalsByFilter({ status: "error", minScore: 5, limit: 20 }),
    ]);
    const fmt = (r: Record<string, unknown>) => ({
      jobId: r.job_id, title: r.job_title, score: r.score, status: r.status,
      url: r.job_url, budget: r.budget, hasCoverLetter: !!r.proposal_text,
      createdAt: r.created_at,
    });
    res.json({
      counts,
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      submitted: submitted.map(fmt),
      queued: queued.map(fmt),
      errors: errors.map(fmt),
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ── Submit a single proposal by job ID ──
// POST /api/upwork/submit { jobId: "..." }
router.post("/upwork/submit", async (req: Request, res: Response) => {
  const { jobId } = req.body as { jobId?: string };
  if (!jobId) {
    res.status(400).json({ error: "Required: jobId" });
    return;
  }
  try {
    const rows = await cloud.getProposalsByFilter({ jobId });
    if (rows.length === 0) {
      res.status(404).json({ error: `Job ${jobId} not found in proposals` });
      return;
    }
    const row = rows[0];
    if (row.status === "submitted") {
      res.json({ ok: true, message: "Already submitted", jobId });
      return;
    }

    const job: UpworkJob = {
      id: row.job_id as string,
      title: (row.job_title as string) || "Untitled",
      description: (row.job_description as string) || (row.job_title as string) || "",
      url: row.job_url as string,
      budget: row.budget as string | undefined,
      score: row.score as number | undefined,
      bid: row.submitted_bid_amount as number | undefined,
      coverLetter: row.proposal_text as string | undefined,
    };

    logger.info(`[api] Submit triggered for: ${job.title.slice(0, 50)}`);
    const opId = ops.createOp("submit_proposal", { jobId, title: job.title });
    ops.startOp(opId);
    res.json({ ok: true, message: "Submission started", jobId, title: job.title, opId });

    // Run async — don't block the response
    (async () => {
      ops.addStep(opId, "update_status", "Marking as auto_sending");
      await cloud.updateProposalStatus(jobId, "auto_sending");
      ops.completeStep(opId, "update_status");
      ops.addStep(opId, "submit", "Filling and submitting proposal form");
      const ok = await submitProposal(job);
      await cloud.updateProposalStatus(jobId, ok ? "submitted" : "error");
      if (ok) {
        ops.completeStep(opId, "submit", "Submitted successfully");
        ops.completeOp(opId, { submitted: true });
      } else {
        ops.failOp(opId, "Submission returned false — check browser logs");
      }
      logger.info(`[api] Submit result for ${jobId}: ${ok ? "SUCCESS" : "FAILED"}`);
      const emoji = ok ? "🚀" : "❌";
      const budget = job.budget ? ` | 💰 ${job.budget}` : "";
      await tg.notify(`${emoji} *Proposal ${ok ? "submitted" : "FAILED"}*\n${job.title.slice(0, 60)}${budget}\n🔗 ${job.url}`);
    })().catch(e => {
      ops.failOp(opId, e as Error);
      logger.error(`[api] Submit error for ${jobId}: ${(e as Error).message}`);
      cloud.updateProposalStatus(jobId, "error").catch((e) => logger.error(`[api] Failed to mark ${jobId} as error: ${(e as Error).message}`));
      tg.notify(`❌ *Proposal submit crashed*\n${job.title.slice(0, 60)}\n${(e as Error).message.slice(0, 100)}`).catch(() => {});
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ── Notifications: check Upwork notifications and process them ──
// GET /api/upwork/notifications
router.get("/upwork/notifications", async (_req: Request, res: Response) => {
  const opId = ops.createOp("check_notifications", { source: "api" });
  try {
    const { checkAndProcessNotifications } = await import("../client/Upwork");
    logger.info("[api] Notification check triggered");
    ops.startOp(opId);
    const result = await checkAndProcessNotifications();
    ops.completeOp(opId, result);
    res.json({ ...result, opId });
  } catch (e) {
    ops.failOp(opId, e as Error);
    logger.error(`[api] Notification check error: ${(e as Error).message}`);
    res.status(500).json({ error: (e as Error).message, opId });
  }
});

// ── Auto-submit: submit top queued jobs to meet daily minimum ──
// POST /api/upwork/auto-submit { target?: 2 }
router.post("/upwork/auto-submit", async (req: Request, res: Response) => {
  const { target = 2 } = req.body as { target?: number };
  try {
    const { submitTopQueued } = await import("../client/Upwork");
    logger.info(`[api] Auto-submit triggered (target: ${target}/day)`);
    const opId = ops.createOp("auto_submit", { target });
    ops.startOp(opId);
    res.json({ ok: true, message: `Auto-submit started (target: ${target}/day)`, opId });
    submitTopQueued(target)
      .then(() => ops.completeOp(opId, { target }))
      .catch((e) => {
        ops.failOp(opId, e as Error);
        logger.error(`[api] Auto-submit error: ${(e as Error).message}`);
      });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ── Batch submit: retry all queued/error jobs above a score threshold ──
// POST /api/upwork/submit-batch { minScore?: 7, statuses?: ["queued","error"] }
router.post("/upwork/submit-batch", async (req: Request, res: Response) => {
  const rawMinScore = req.body?.minScore;
  const minScore = Math.max(0, Math.min(10, typeof rawMinScore === "number" ? rawMinScore : 7));
  const { statuses = ["queued"] } = req.body as { statuses?: string[] };
  try {
    const rows = await cloud.getProposalsByFilter({ status: statuses, minScore });
    if (rows.length === 0) {
      res.json({ ok: true, message: "No jobs to submit", count: 0 });
      return;
    }

    const jobs = rows.map(row => ({
      id: row.job_id as string,
      title: (row.job_title as string) || "Untitled",
      description: (row.job_description as string) || (row.job_title as string) || "",
      url: row.job_url as string,
      budget: row.budget as string | undefined,
      score: row.score as number | undefined,
      bid: row.submitted_bid_amount as number | undefined,
      coverLetter: row.proposal_text as string | undefined,
    }));

    logger.info(`[api] Batch submit triggered: ${jobs.length} jobs (minScore=${minScore})`);
    res.json({
      ok: true,
      message: `Batch submission started for ${jobs.length} jobs`,
      count: jobs.length,
      jobs: jobs.map(j => ({ jobId: j.id, title: j.title, score: j.score })),
    });

    // Run sequentially in background
    (async () => {
      let submitted = 0, failed = 0;
      for (const job of jobs) {
        try {
          await cloud.updateProposalStatus(job.id, "auto_sending");
          // Timeout individual submissions at 3 minutes to prevent batch hangs
          const ok = await Promise.race([
            submitProposal(job),
            new Promise<boolean>((_, reject) => setTimeout(() => reject(new Error("Submission timeout (3m)")), 180000)),
          ]).catch((e) => { logger.error(`[api] Submit timeout/error: ${(e as Error).message}`); return false; });
          await cloud.updateProposalStatus(job.id, ok ? "submitted" : "error");
          if (ok) submitted++; else failed++;
          logger.info(`[api] Batch: ${ok ? "✓" : "✗"} ${job.title.slice(0, 50)}`);
          const emoji = ok ? "🚀" : "❌";
          await tg.notify(`${emoji} *Batch ${ok ? "submitted" : "FAILED"}*\n${job.title.slice(0, 60)}\n💰 ${job.budget || "N/A"}`);
          // Pause between submissions
          await new Promise(r => setTimeout(r, 3000 + Math.random() * 5000));
        } catch (e) {
          logger.error(`[api] Batch error for ${job.id}: ${(e as Error).message}`);
          await cloud.updateProposalStatus(job.id, "error").catch((e) => logger.error(`[api] Failed to mark ${job.id} as error: ${(e as Error).message}`));
          failed++;
        }
      }
      logger.info(`[api] Batch done: ${submitted} submitted, ${failed} failed`);
    })().catch(e => logger.error(`[api] Batch fatal: ${(e as Error).message}`));
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ── YouTube Content Ideas: analyze Upwork trends → generate tutorial ideas ──
router.get("/youtube/ideas", async (_req: Request, res: Response) => {
  try {
    const { analyzeNiches } = await import("../services/youtube-ideas");
    const niches = await analyzeNiches();
    res.json({
      niches: niches.length,
      data: niches.map(n => ({
        category: n.label,
        jobCount: n.jobCount,
        avgBudget: n.avgBudget,
        maxBudget: n.maxBudget,
        budgetRange: n.budgetRange,
        avgScore: n.avgScore,
        topJobs: n.exampleJobs.slice(0, 3),
      })),
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// GET /api/youtube/report — Generate "What People Want from AI" style market analysis
router.get("/youtube/report", async (_req: Request, res: Response) => {
  try {
    const { analyzeNiches, generateMarketReport } = await import("../services/youtube-ideas");
    logger.info("[api] YouTube market report triggered");
    const niches = await analyzeNiches();
    if (niches.length === 0) {
      res.status(404).json({ error: "No niche data found — run a scan first" });
      return;
    }
    const report = await generateMarketReport(niches);
    res.json({
      niches: niches.length,
      totalJobs: niches.reduce((s, n) => s + n.jobCount, 0),
      report,
    });
  } catch (e) {
    logger.error(`[api] YouTube report error: ${(e as Error).message}`);
    res.status(500).json({ error: (e as Error).message });
  }
});

// POST /api/youtube/generate — Run full pipeline: analyze → Claude generates ideas → save to Supabase
router.post("/youtube/generate", async (_req: Request, res: Response) => {
  try {
    const { runContentIdeaPipeline } = await import("../services/youtube-ideas");
    logger.info("[api] YouTube content idea pipeline triggered");
    const result = await runContentIdeaPipeline();
    res.json(result);
  } catch (e) {
    logger.error(`[api] YouTube pipeline error: ${(e as Error).message}`);
    res.status(500).json({ error: (e as Error).message });
  }
});

// ── Analytics: comprehensive Upwork data analysis ──

// GET /api/analytics/plus — Freelancer Plus competitive insights (must be before /analytics)
router.get("/analytics/plus", async (_req: Request, res: Response) => {
  try {
    const { runFullAnalytics } = await import("../services/analytics");
    logger.info("[api] Plus insights analytics triggered");
    const analytics = await runFullAnalytics();
    res.json(analytics.plusInsights);
  } catch (e) {
    logger.error(`[api] Plus insights error: ${(e as Error).message}`);
    res.status(500).json({ error: (e as Error).message });
  }
});

// GET /api/analytics — Full analytics dashboard (pricing, close rates, timing, text mining, pipeline health)
router.get("/analytics", async (_req: Request, res: Response) => {
  try {
    const { runFullAnalytics } = await import("../services/analytics");
    logger.info("[api] Full analytics triggered");
    const analytics = await runFullAnalytics();
    res.json(analytics);
  } catch (e) {
    logger.error(`[api] Analytics error: ${(e as Error).message}`);
    res.status(500).json({ error: (e as Error).message });
  }
});

// GET /api/analytics/report — Generate a narrated video script from analytics data
router.get("/analytics/report", async (_req: Request, res: Response) => {
  try {
    const { runFullAnalytics, generateAnalyticsReport } = await import("../services/analytics");
    logger.info("[api] Analytics report triggered");
    const analytics = await runFullAnalytics();
    const report = await generateAnalyticsReport(analytics);
    res.json({ ...analytics, report });
  } catch (e) {
    logger.error(`[api] Analytics report error: ${(e as Error).message}`);
    res.status(500).json({ error: (e as Error).message });
  }
});

// ── Analytics Snapshots — save & retrieve for external apps ──

// POST /api/analytics/snapshot — Run full analytics and save snapshot to Supabase
router.post("/analytics/snapshot", async (_req: Request, res: Response) => {
  try {
    const { runFullAnalytics, generateAnalyticsReport } = await import("../services/analytics");
    logger.info("[api] Analytics snapshot triggered");
    const analytics = await runFullAnalytics();
    const report = await generateAnalyticsReport(analytics);

    // Get content ideas if available
    let contentIdeas: unknown[] | undefined;
    try {
      const { analyzeNiches } = await import("../services/youtube-ideas");
      const niches = await analyzeNiches();
      contentIdeas = niches.map(n => ({
        niche: n.label,
        jobCount: n.jobCount,
        avgBudget: n.avgBudget,
        budgetRange: n.budgetRange,
        topJobs: n.exampleJobs?.slice(0, 3),
      }));
    } catch { /* content ideas are optional */ }

    const snapshotId = await cloud.saveAnalyticsSnapshot(
      analytics as any,
      report,
      contentIdeas,
    );

    // Also save the report as a content brief
    if (snapshotId) {
      await cloud.saveContentBrief({
        type: "market_report",
        title: `Upwork Market Report — ${new Date().toISOString().split("T")[0]}`,
        summary: `Analysis of ${(analytics as any).overview?.totalJobs || 0} jobs. Win rate: ${(analytics as any).closeRate?.overall?.winRate || 0}%. Top niches: ${((analytics as any).niches || []).slice(0, 3).map((n: any) => n.niche).join(", ")}`,
        content: report,
        dataSources: { analytics_snapshot_id: snapshotId, proposal_count: (analytics as any).overview?.totalJobs },
        tags: ["market-report", "analytics", "weekly"],
        metadata: { word_count: report.split(/\s+/).length },
      });
    }

    res.json({
      ok: true,
      snapshotId,
      totalJobs: (analytics as any).overview?.totalJobs,
      winRate: (analytics as any).closeRate?.overall?.winRate,
      topNiches: ((analytics as any).niches || []).slice(0, 5).map((n: any) => n.niche),
      recommendations: (analytics as any).recommendations,
    });
  } catch (e) {
    logger.error(`[api] Analytics snapshot error: ${(e as Error).message}`);
    res.status(500).json({ error: (e as Error).message });
  }
});

// GET /api/analytics/latest — Get most recent analytics snapshot from Supabase
router.get("/analytics/latest", async (_req: Request, res: Response) => {
  try {
    const snapshot = await cloud.getLatestSnapshot();
    if (!snapshot) {
      res.status(404).json({ error: "No snapshots found. Run POST /api/analytics/snapshot first." });
      return;
    }
    res.json(snapshot);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ── Content Briefs — pre-packaged content for podcast/YouTube ──

// POST /api/content/brief — Generate a content brief from latest analytics
router.post("/content/brief", async (req: Request, res: Response) => {
  const { type = "podcast_episode" } = req.body as { type?: string };
  try {
    const { runFullAnalytics, generateAnalyticsReport } = await import("../services/analytics");
    const analytics = await runFullAnalytics();
    const overview = analytics.overview;
    const closeRate = analytics.closeRate;

    // Generate tailored content based on type
    let title: string;
    let content: string;

    if (type === "youtube_script") {
      content = await generateAnalyticsReport(analytics);
      title = `What People Want from AI — Week of ${new Date().toISOString().split("T")[0]}`;
    } else {
      // Podcast / general brief
      const topNiches = analytics.niches.slice(0, 5);
      const topCombos = analytics.textInsights.topTechCombos.slice(0, 5);
      const painPoints = analytics.textInsights.clientPainPoints.slice(0, 5);

      content = [
        `# Upwork AI Market Brief — ${new Date().toLocaleDateString()}`,
        ``,
        `## Key Numbers`,
        `- ${overview.totalJobs} jobs analyzed, $${Math.round(overview.totalBudget).toLocaleString()} total budget pool`,
        `- Average budget: $${Math.round(overview.avgBudget)}`,
        `- Win rate: ${closeRate.overall.winRate}% (${closeRate.overall.won} won / ${closeRate.overall.submitted} submitted)`,
        ``,
        `## Top Niches by Demand`,
        ...topNiches.map((n, i) => `${i + 1}. **${n.niche}** — ${n.count} jobs, avg $${Math.round(n.avgBudget)}, ${n.winRate}% win rate`),
        ``,
        `## Trending Tech Combos`,
        ...topCombos.map((c, i) => `${i + 1}. ${c.combo} (${c.count} jobs)`),
        ``,
        `## What Clients Are Struggling With`,
        ...painPoints.map((p, i) => `${i + 1}. "${p.phrase}" (${p.count} mentions)`),
        ``,
        `## Recommendations`,
        ...analytics.recommendations.map((r, i) => `${i + 1}. ${r}`),
        ``,
        `## Best Days to Apply`,
        ...analytics.timing.bestDays.slice(0, 3).map((d, i) => `${i + 1}. ${d.day} — avg score ${d.avgScore.toFixed(1)} (${d.count} jobs)`),
      ].join("\n");
      title = `AI Freelancing Market Brief — ${new Date().toISOString().split("T")[0]}`;
    }

    const briefId = await cloud.saveContentBrief({
      type,
      title,
      summary: `${overview.totalJobs} jobs, $${Math.round(overview.avgBudget)} avg budget, ${closeRate.overall.winRate}% win rate`,
      content,
      dataSources: { proposal_count: overview.totalJobs, date: new Date().toISOString() },
      tags: [type, "ai-market", new Date().toISOString().split("T")[0]],
      metadata: { word_count: content.split(/\s+/).length },
    });

    res.json({ ok: true, briefId, title, type, wordCount: content.split(/\s+/).length, content });
  } catch (e) {
    logger.error(`[api] Content brief error: ${(e as Error).message}`);
    res.status(500).json({ error: (e as Error).message });
  }
});

// GET /api/content/briefs — List content briefs
router.get("/content/briefs", async (req: Request, res: Response) => {
  const type = req.query.type as string | undefined;
  const limit = parseInt(req.query.limit as string) || 10;
  try {
    const briefs = await cloud.getContentBriefs(type, limit);
    res.json(briefs);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ── Research: Perplexity job research ──
// POST /api/upwork/research { title, description, budget?, skills? }
router.post("/upwork/research", async (req: Request, res: Response) => {
  const { title, description, budget, skills } = req.body as {
    title?: string; description?: string; budget?: string; skills?: string[];
  };
  if (!title || !description) {
    res.status(400).json({ error: "Required: title, description" });
    return;
  }
  try {
    const { researchJob, formatResearchBrief } = await import("../services/research");
    logger.info(`[api] Research triggered for: ${title.slice(0, 50)}`);
    const research = await researchJob({ title, description, budget, skills });
    if (!research) {
      res.status(503).json({ error: "Research unavailable — check PERPLEXITY_API_KEY" });
      return;
    }
    res.json({ ...research, brief: formatResearchBrief(research) });
  } catch (e) {
    logger.error(`[api] Research error: ${(e as Error).message}`);
    res.status(500).json({ error: (e as Error).message });
  }
});

// ── Archived Proposals & Lessons Learned ──

router.post("/upwork/archived", async (_req: Request, res: Response) => {
  try {
    const { syncArchivedProposals } = await import("../client/Upwork");
    const result = await syncArchivedProposals();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

router.get("/upwork/lessons", async (_req: Request, res: Response) => {
  try {
    const { analyzeLessonsLearned } = await import("../client/Upwork");
    const result = await analyzeLessonsLearned();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

export default router;
