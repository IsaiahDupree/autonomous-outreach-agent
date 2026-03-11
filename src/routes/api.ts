/**
 * src/routes/api.ts — REST endpoints (mirrors Riona's routes/api.ts)
 */
import { Router, Request, Response } from "express";
import * as cloud from "../services/cloud";
import { checkCDP } from "../client/Chrome";
import { SAFARI_UPWORK_PORT, SAFARI_LINKEDIN_PORT } from "../secret";
import logger from "../config/logger";

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

export default router;
