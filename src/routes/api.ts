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

const router = Router();

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
  res.json({ ok: true, message: "Upwork scan queued" });
  // Actual run happens async — trigger event or use queue
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
    res.json({ ok: true, message: "Submission started", jobId, title: job.title });

    // Run async — don't block the response
    (async () => {
      await cloud.updateProposalStatus(jobId, "auto_sending");
      const ok = await submitProposal(job);
      await cloud.updateProposalStatus(jobId, ok ? "submitted" : "error");
      logger.info(`[api] Submit result for ${jobId}: ${ok ? "SUCCESS" : "FAILED"}`);
    })().catch(e => {
      logger.error(`[api] Submit error for ${jobId}: ${(e as Error).message}`);
      cloud.updateProposalStatus(jobId, "error").catch((e) => logger.error(`[api] Failed to mark ${jobId} as error: ${(e as Error).message}`));
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ── Batch submit: retry all queued/error jobs above a score threshold ──
// POST /api/upwork/submit-batch { minScore?: 7, statuses?: ["queued","error"] }
router.post("/upwork/submit-batch", async (req: Request, res: Response) => {
  const { minScore = 7, statuses = ["queued"] } = req.body as { minScore?: number; statuses?: string[] };
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
          const ok = await submitProposal(job);
          await cloud.updateProposalStatus(job.id, ok ? "submitted" : "error");
          if (ok) submitted++; else failed++;
          logger.info(`[api] Batch: ${ok ? "✓" : "✗"} ${job.title.slice(0, 50)}`);
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

export default router;
