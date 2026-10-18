/**
 * src/routes/tracking.ts — public /r/:slug redirect for tracked short links.
 * Mounted at the app root (not under /api) so URLs are short enough to drop into proposals.
 */
import { Router, Request, Response } from "express";
import { resolveSlug, recordClick, getClickStats } from "../services/tracking";
import logger from "../config/logger";

const router = Router();

router.get("/r/:slug", async (req: Request, res: Response) => {
  const slug = req.params.slug;
  if (!slug || !/^[A-Za-z0-9_-]{4,32}$/.test(slug)) {
    res.status(404).send("Not found");
    return;
  }

  const target = await resolveSlug(slug);
  if (!target) {
    res.status(404).send("Not found");
    return;
  }

  // Fire-and-forget click logging — must never block the redirect.
  const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "";
  const userAgent = req.headers["user-agent"] || "";
  const referer = (req.headers["referer"] || req.headers["referrer"] || "") as string;
  recordClick(slug, { ip, userAgent, referer }).catch(e => {
    logger.warn(`[Tracking] background click log failed: ${(e as Error).message}`);
  });

  res.redirect(302, target);
});

router.get("/api/tracking/stats", async (req: Request, res: Response) => {
  const jobId = (req.query.jobId as string) || undefined;
  const limit = Math.min(parseInt((req.query.limit as string) || "200", 10) || 200, 1000);
  const rows = await getClickStats(jobId, limit);
  res.json({ count: rows.length, rows });
});

export default router;
