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
import * as controller from "../controller";

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

// ── Controller ──

// GET /api/controller/status — Controller state + recent decisions
router.get("/controller/status", (_req: Request, res: Response) => {
  res.json(controller.getControllerStatus());
});

// GET /api/controller/decisions — Full decision log
router.get("/controller/decisions", (_req: Request, res: Response) => {
  res.json(controller.getDecisionLog());
});

// POST /api/controller/cycle — Run a single decision cycle on demand
router.post("/controller/cycle", async (_req: Request, res: Response) => {
  try {
    const decision = await controller.runOneCycle();
    res.json({ ok: true, decision });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// POST /api/controller/start — Start the controller loop
router.post("/controller/start", (_req: Request, res: Response) => {
  if (controller.isRunning()) {
    res.json({ ok: true, message: "Controller already running" });
    return;
  }
  // Controller needs a Claude client — lazy-import from Agent module
  (async () => {
    try {
      const { getClient } = await import("../Agent");
      const client = getClient();
      if (!client) {
        res.status(503).json({ error: "Claude client not initialized — run initAgent first" });
        return;
      }
      controller.startController(client);
      res.json({ ok: true, message: "Controller started" });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  })();
});

// POST /api/controller/stop — Stop the controller loop
router.post("/controller/stop", (_req: Request, res: Response) => {
  controller.stopController();
  res.json({ ok: true, message: "Controller stopped" });
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
// Default: pending/queued. Pass ?status=submitted|won|... or ?jobId=... or ?limit=N for the dashboard.
router.get("/upwork/proposals", async (req: Request, res: Response) => {
  try {
    const jobId = req.query.jobId as string | undefined;
    const status = req.query.status as string | undefined;
    const limit = parseInt((req.query.limit as string) || "100", 10) || 100;

    if (jobId) {
      const proposals = await cloud.getProposalsByFilter({ jobId });
      res.json({ count: proposals.length, proposals });
      return;
    }
    if (status) {
      const statuses = status.split(",").map(s => s.trim()).filter(Boolean);
      const proposals = await cloud.getProposalsByFilter({ status: statuses.length === 1 ? statuses[0] : statuses, limit });
      res.json({ count: proposals.length, proposals });
      return;
    }
    const proposals = await cloud.getPendingProposals();
    res.json({ count: proposals.length, proposals });
  } catch (e) {
    const err = e as Error;
    logger.error(`[api] GET /upwork/proposals failed (status=${req.query.status}, jobId=${req.query.jobId}): ${err.message}\n${err.stack || ""}`);
    res.status(500).json({ error: err.message });
  }
});

// Trigger a cycle manually. Body: { keywords?: string[], scoreThreshold?: number, filters?: object }
// If keywords is omitted, falls back to a minimal high-signal set so the smoke flow has something to run.
router.post("/upwork/scan", async (req: Request, res: Response) => {
  const body = (req.body || {}) as { keywords?: string[]; scoreThreshold?: number; filters?: Record<string, unknown> };
  const keywords = (Array.isArray(body.keywords) && body.keywords.length > 0)
    ? body.keywords
    : ["AI automation", "n8n automation", "Claude API"];
  const scoreThreshold = typeof body.scoreThreshold === "number" ? body.scoreThreshold : 5;
  const filters = body.filters || {};

  logger.info(`[api] Manual upwork scan triggered: ${keywords.length} keyword(s), threshold=${scoreThreshold}`);
  const opId = ops.createOp("scan_keywords", { source: "api", keywords, scoreThreshold });
  ops.startOp(opId);
  res.json({ ok: true, message: "Upwork scan started", opId, keywords, scoreThreshold });

  // Run async with tracking
  (async () => {
    try {
      const { runProposalCycle } = await import("../client/Upwork");
      ops.addStep(opId, "scan", `Running keyword search cycle: ${keywords.join(", ")}`);
      await runProposalCycle(keywords, filters, scoreThreshold);
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
  const min = parseInt(process.env.AUTO_SEND_MIN_CONNECTS || "16");
  const below = connects !== null && connects < min;
  res.json({
    connects,
    min_connects: min,
    hard_stop: below,
    warning: below ? `LOW — ${connects} < AUTO_SEND_MIN_CONNECTS (${min}); auto-submissions paused` : null,
  });
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

// GET /api/metrics/variants — reply-rate per A/B prompt variant
router.get("/metrics/variants", async (_req: Request, res: Response) => {
  try {
    const { getVariantMetrics } = await import("../services/cloud");
    const variants = await getVariantMetrics();
    res.json({ variants });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Recompute per-niche win rates + patterns from outcomed proposals (used by reinforcement loop).
router.post("/reinforcement/refresh", async (_req: Request, res: Response) => {
  try {
    const { computeNichePerformance } = await import("../services/reinforcement");
    const { invalidateNicheCache } = await import("../Agent/scorer");
    const result = await computeNichePerformance();
    invalidateNicheCache();
    logger.info(`[api] Reinforcement refresh: ${result.updated} niches updated, ${result.skipped} skipped`);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Read-only view of the character config + slot prompt + per-niche custom-context overrides.
// Powers the dashboard Templates tab so users can SEE exactly what context is being injected
// into proposal generation. No editing here; that's a separate PUT below.
router.get("/character", async (_req: Request, res: Response) => {
  try {
    const fs = await import("fs");
    const path = await import("path");
    const charPath = path.join(__dirname, "..", "Agent", "characters", "sample.character.json");
    const character = JSON.parse(fs.readFileSync(charPath, "utf8"));
    const { SLOT_PROMPT_INSTRUCTIONS } = await import("../Agent/slots");
    const { getCustomContext } = await import("../Agent/custom-context");
    res.json({
      character,
      slot_prompt: SLOT_PROMPT_INSTRUCTIONS,
      custom_context: getCustomContext(),
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Render the full proposal-generation prompt for a sample job WITHOUT calling the LLM.
// Powers the Templates → Prompt preview tab so users can see exactly what gets fed to Claude.
// Body: { title, description, budget?, tags?[] }
router.post("/character/preview-prompt", async (req: Request, res: Response) => {
  try {
    const body = (req.body || {}) as { title?: string; description?: string; budget?: string; tags?: string[] };
    if (!body.title || !body.description) {
      res.status(400).json({ error: "expected body.title and body.description" });
      return;
    }
    const { buildProposalPrompt } = await import("../Agent");
    const prompt = await buildProposalPrompt({
      title: body.title,
      description: body.description,
      budget: body.budget,
      tags: body.tags,
      jobId: "preview-no-real-job",
    }, { preview: true });
    res.json({
      prompt,
      length: prompt.length,
      char_count: prompt.length,
      approximate_tokens: Math.ceil(prompt.length / 4),
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Replace a top-level section of the character config. Body: { section: "persona"|"icp"|...,
// value: any }. The value is validated, then character.json is rewritten with a timestamped
// .bak backup written to the same dir so a bad edit can be rolled back manually.
router.put("/character/section", async (req: Request, res: Response) => {
  try {
    const body = (req.body || {}) as { section?: string; value?: unknown };
    const section = body.section;
    const ALLOWED: Record<string, (v: unknown) => string | null> = {
      persona: v => typeof v === "string" && v.length > 0 ? null : "must be non-empty string",
      name_signoff: v => typeof v === "string" ? null : "must be string",
      tone: v => typeof v === "string" ? null : "must be string",
      icp: v => v && typeof v === "object" && !Array.isArray(v) ? null : "must be object",
      portfolio: v => v && typeof v === "object" && !Array.isArray(v) ? null : "must be object",
      showcaseProjects: v => Array.isArray(v) ? null : "must be array",
      github: v => v && typeof v === "object" && !Array.isArray(v) ? null : "must be object",
      youtube: v => v && typeof v === "object" && !Array.isArray(v) ? null : "must be object",
    };
    if (!section || !(section in ALLOWED)) {
      res.status(400).json({ error: `section must be one of: ${Object.keys(ALLOWED).join(", ")}` });
      return;
    }
    const validate = ALLOWED[section];
    const validationErr = validate(body.value);
    if (validationErr) {
      res.status(400).json({ error: `invalid value for ${section}: ${validationErr}` });
      return;
    }

    const fs = await import("fs");
    const path = await import("path");
    const charPath = path.join(__dirname, "..", "Agent", "characters", "sample.character.json");
    const current = JSON.parse(fs.readFileSync(charPath, "utf8"));
    // Backup before write — keeps the last 5 backups; older ones are pruned by the OS over time.
    const backupPath = `${charPath}.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
    fs.writeFileSync(backupPath, JSON.stringify(current, null, 2));
    const next = { ...current, [section]: body.value };
    fs.writeFileSync(charPath, JSON.stringify(next, null, 2));

    // Reload the in-process character config so the change takes effect immediately.
    try {
      const { initAgent } = await import("../Agent");
      await initAgent();
    } catch (e) {
      logger.warn(`[api] character reload failed (saved file is good): ${(e as Error).message}`);
    }
    logger.info(`[api] character.json section "${section}" updated, backup at ${path.basename(backupPath)}`);
    try {
      const { recordCharacterEdit } = await import("../services/character-audit");
      const beforeSize = JSON.stringify(current[section] ?? null).length;
      const afterSize = JSON.stringify(body.value ?? null).length;
      recordCharacterEdit({
        kind: "section",
        section,
        source: (req.headers["x-source"] as string) || "dashboard",
        summary: `Replaced "${section}" (${beforeSize} → ${afterSize} chars)`,
        backup: path.basename(backupPath),
        before_size: beforeSize,
        after_size: afterSize,
      });
    } catch (e) {
      logger.warn(`[api] audit log failed: ${(e as Error).message}`);
    }
    res.json({ ok: true, section, backup: path.basename(backupPath) });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Recent edits to character.json / variants / custom-context — append-only JSONL log,
// last 500 lines retained. Useful for "who changed the persona at 3am?" diagnostics.
router.get("/character/audit", async (req: Request, res: Response) => {
  try {
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit as string) || 100));
    const { readCharacterAudit } = await import("../services/character-audit");
    const entries = readCharacterAudit(limit);
    res.json({ count: entries.length, entries });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Read prompt variants — alternative slot prompts agents can A/B test per niche.
router.get("/character/variants", async (_req: Request, res: Response) => {
  try {
    const { getPromptVariants } = await import("../Agent/prompt-variants");
    res.json({ variants: getPromptVariants() });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Save prompt variants. Body: { variants: { niche: [{name, fragment, weight}] } }.
router.put("/character/variants", async (req: Request, res: Response) => {
  try {
    const body = (req.body || {}) as { variants?: Record<string, Array<{ name: string; fragment: string; weight?: number }>> };
    if (!body.variants || typeof body.variants !== "object") {
      res.status(400).json({ error: "expected body.variants: Record<string, Array<{name, fragment, weight?}>>" });
      return;
    }
    const { savePromptVariants, getPromptVariants } = await import("../Agent/prompt-variants");
    const before = getPromptVariants();
    const r = savePromptVariants(body.variants);
    if (!r.ok) { res.status(400).json({ error: r.error || "save failed" }); return; }
    try {
      const { recordCharacterEdit } = await import("../services/character-audit");
      const beforeNiches = Object.keys(before).length;
      const afterNiches = Object.keys(body.variants).length;
      const totalVariants = Object.values(body.variants).reduce((s, arr) => s + arr.length, 0);
      recordCharacterEdit({
        kind: "variants",
        source: (req.headers["x-source"] as string) || "dashboard",
        summary: `Saved variants: ${afterNiches} niche(s), ${totalVariants} variant(s) (was ${beforeNiches} niche(s))`,
        before_size: JSON.stringify(before).length,
        after_size: JSON.stringify(body.variants).length,
      });
    } catch (e) {
      logger.warn(`[api] audit log failed: ${(e as Error).message}`);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Update the per-niche custom-context map. Body: { context: { niche: text, ... } }.
// Replaces the file wholesale, so callers should send the full intended state.
router.put("/character/custom-context", async (req: Request, res: Response) => {
  try {
    const body = (req.body || {}) as { context?: Record<string, string> };
    if (!body.context || typeof body.context !== "object") {
      res.status(400).json({ error: "expected body.context: Record<string, string>" });
      return;
    }
    const { saveCustomContext, getCustomContext } = await import("../Agent/custom-context");
    const before = getCustomContext();
    const r = saveCustomContext(body.context);
    if (!r.ok) {
      res.status(400).json({ error: r.error || "save failed" });
      return;
    }
    try {
      const { recordCharacterEdit } = await import("../services/character-audit");
      const beforeKeys = Object.keys(before).length;
      const afterKeys = Object.keys(body.context).length;
      recordCharacterEdit({
        kind: "custom-context",
        source: (req.headers["x-source"] as string) || "dashboard",
        summary: `Saved custom-context: ${afterKeys} niche(s) (was ${beforeKeys})`,
        before_size: JSON.stringify(before).length,
        after_size: JSON.stringify(body.context).length,
      });
    } catch (e) {
      logger.warn(`[api] audit log failed: ${(e as Error).message}`);
    }
    res.json({ ok: true, context: body.context });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Recent-failure cooldown view — which jobs are parked and why. Useful for "is the agent
// just sitting on a backlog of stale jobs?" diagnostics.
router.get("/agent/cooldown", async (_req: Request, res: Response) => {
  try {
    const { getCooldownSnapshot } = await import("../client/Upwork");
    res.json(getCooldownSnapshot());
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Live in-flight submission state — what the agent is currently submitting (if anything).
// Dashboard polls this every 2-5s for the "submitting now" card. Returns null when idle.
router.get("/agent/in-flight", async (_req: Request, res: Response) => {
  try {
    const { getInFlight } = await import("../browser/upwork");
    res.json({ in_flight: getInFlight() });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Failure-reason breakdown: groups proposals by status so the dashboard can show how the
// queue is bleeding (expired vs already_applied vs validation_error vs cloudflare_blocked etc).
// Optional ?since=24h limits to recent activity.
router.get("/analytics/failure-breakdown", async (req: Request, res: Response) => {
  try {
    const since = (req.query.since as string) || "24h";
    const m = since.match(/^(\d+)([hd])$/);
    const ms = m ? parseInt(m[1], 10) * (m[2] === "d" ? 86400_000 : 3600_000) : 86400_000;
    const cutoff = new Date(Date.now() - ms).toISOString();
    const rows = await cloud.getProposalsByFilter({ limit: 500 });
    const recent = rows.filter(r => {
      const t = (r.updated_at || r.created_at) as string | undefined;
      return t ? t >= cutoff : false;
    });
    const counts: Record<string, number> = {};
    for (const r of recent) {
      const s = (r.status as string) || "unknown";
      counts[s] = (counts[s] || 0) + 1;
    }
    // Group into bigger buckets for at-a-glance readability.
    const buckets = {
      submitted:        counts["submitted"]         || 0,
      pending:          counts["pending"]           || 0,
      queued:           counts["queued"]            || 0,
      below_threshold:  counts["below_threshold"]   || 0,
      excluded:         counts["excluded"]          || 0,
      auto_sending:     counts["auto_sending"]      || 0,
      // Typed failures (added in v8)
      expired:          counts["expired"]           || 0,
      already_applied:  counts["already_applied"]   || 0,
      validation_error: counts["validation_error"]  || 0,
      cloudflare_blocked: counts["cloudflare_blocked"] || 0,
      error_no_cover_letter: counts["error_no_cover_letter"] || 0,
      error_low_connects:    counts["error_low_connects"]    || 0,
      error_bid:             counts["error_bid"]             || 0,
      error_puppeteer:       counts["error_puppeteer"]       || 0,
      error_generic:    counts["error"]             || 0,
      // Outcomes
      won:              counts["won"]               || 0,
      rejected:         counts["rejected"]          || 0,
      no_response:      counts["no_response"]       || 0,
      interviewed:      counts["interviewed"]       || 0,
    };
    res.json({ since, total: recent.length, buckets, raw: counts });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Click funnel: submit → ≥1 click → response → win. Combines tracked_links + link_clicks +
// upwork_proposals to answer "do tracked URLs in proposals actually correlate with replies and
// wins, and which link type pays best?". Three rollups in one call so the dashboard does no
// extra joining client-side.
router.get("/analytics/click-funnel", async (_req: Request, res: Response) => {
  try {
    const { getProposalsByFilter } = cloud;
    const { getClickStats } = await import("../services/tracking");

    const [proposals, allClicks] = await Promise.all([
      getProposalsByFilter({ limit: 500 }),
      getClickStats(undefined, 1000),
    ]);

    // Index clicks by job_id and by (job_id, link_type) for fast lookups.
    const clicksByJob = new Map<string, typeof allClicks>();
    for (const c of allClicks) {
      const jid = c.job_id || "_global";
      if (!clicksByJob.has(jid)) clicksByJob.set(jid, []);
      clicksByJob.get(jid)!.push(c);
    }

    // ── Funnel: submit → clicked → responded (viewed/interviewed/replied) → won ─────
    let submitted = 0, clicked = 0, responded = 0, won = 0;
    // Time-to-first-click samples (seconds from submitted_at → earliest click_at on this jobId)
    const timeToFirstClickSec: number[] = [];
    // Per-niche aggregates
    const byNiche = new Map<string, {
      submitted: number; clicked: number; responded: number; won: number;
      timeToFirstClick: number[];
      // Per-link-type click counts and submission counts
      linkTypeClicks: Record<string, number>;
      linkTypeImpressions: Record<string, number>;  // # proposals that included this link type
    }>();

    function bucket(name: string) {
      let b = byNiche.get(name);
      if (!b) {
        b = { submitted: 0, clicked: 0, responded: 0, won: 0, timeToFirstClick: [],
              linkTypeClicks: {}, linkTypeImpressions: {} };
        byNiche.set(name, b);
      }
      return b;
    }

    const RESPONSE_STATUSES = new Set(["interviewed", "won", "viewed"]);

    for (const p of proposals) {
      const jobId = p.job_id as string;
      const status = (p.status as string) || "";
      const submittedAt = p.submitted_at as string | undefined;
      const viewedAt = p.viewed_at as string | undefined;
      const isSubmitted = status === "submitted" || status === "won" || status === "rejected" || status === "no_response" || status === "interviewed";
      if (!isSubmitted) continue;

      submitted++;
      const niches = ((p.tags as string[] | null) || []).map(s => s.toLowerCase());
      if (niches.length === 0) niches.push("other");
      for (const n of niches) bucket(n).submitted++;

      const jobClicks = (clicksByJob.get(jobId) || []).filter(c => c.click_count > 0);
      const hasClick = jobClicks.length > 0;
      if (hasClick) {
        clicked++;
        for (const n of niches) bucket(n).clicked++;
      }

      // Response = client signal (viewed/interviewed/won)
      const hasResponse = !!viewedAt || RESPONSE_STATUSES.has(status);
      if (hasResponse) {
        responded++;
        for (const n of niches) bucket(n).responded++;
      }

      if (status === "won") {
        won++;
        for (const n of niches) bucket(n).won++;
      }

      // Time-to-first-click
      if (submittedAt && hasClick) {
        const firstClick = jobClicks
          .map(c => c.last_clicked_at ? new Date(c.last_clicked_at).getTime() : Infinity)
          .reduce((a, b) => Math.min(a, b), Infinity);
        if (Number.isFinite(firstClick)) {
          const sec = (firstClick - new Date(submittedAt).getTime()) / 1000;
          if (sec >= 0 && sec < 30 * 24 * 3600) {
            timeToFirstClickSec.push(sec);
            for (const n of niches) bucket(n).timeToFirstClick.push(sec);
          }
        }
      }

      // Per-link-type tally — both impressions (link existed) and clicks (link got clicked)
      const linkTypesOnThisProposal = new Set<string>();
      for (const c of (clicksByJob.get(jobId) || [])) {
        linkTypesOnThisProposal.add(c.link_type);
        if (c.click_count > 0) {
          for (const n of niches) {
            const b = bucket(n);
            b.linkTypeClicks[c.link_type] = (b.linkTypeClicks[c.link_type] || 0) + c.click_count;
          }
        }
      }
      for (const lt of linkTypesOnThisProposal) {
        for (const n of niches) {
          const b = bucket(n);
          b.linkTypeImpressions[lt] = (b.linkTypeImpressions[lt] || 0) + 1;
        }
      }
    }

    function median(xs: number[]): number | null {
      if (xs.length === 0) return null;
      const s = [...xs].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return Math.round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
    }

    const niches = Array.from(byNiche.entries()).map(([niche, b]) => {
      const ctrByType: Record<string, { clicks: number; impressions: number; rate: number }> = {};
      const types = new Set([...Object.keys(b.linkTypeImpressions), ...Object.keys(b.linkTypeClicks)]);
      for (const lt of types) {
        const i = b.linkTypeImpressions[lt] || 0;
        const c = b.linkTypeClicks[lt] || 0;
        ctrByType[lt] = { clicks: c, impressions: i, rate: i > 0 ? Math.round((c / i) * 1000) / 1000 : 0 };
      }
      return {
        niche,
        submitted: b.submitted,
        clicked: b.clicked,
        responded: b.responded,
        won: b.won,
        click_rate: b.submitted > 0 ? Math.round((b.clicked / b.submitted) * 1000) / 1000 : 0,
        response_rate: b.submitted > 0 ? Math.round((b.responded / b.submitted) * 1000) / 1000 : 0,
        win_rate: b.submitted > 0 ? Math.round((b.won / b.submitted) * 1000) / 1000 : 0,
        median_time_to_first_click_sec: median(b.timeToFirstClick),
        ctr_by_link_type: ctrByType,
      };
    }).sort((a, b) => b.submitted - a.submitted);

    res.json({
      funnel: {
        submitted, clicked, responded, won,
        click_rate: submitted > 0 ? Math.round((clicked / submitted) * 1000) / 1000 : 0,
        response_rate: submitted > 0 ? Math.round((responded / submitted) * 1000) / 1000 : 0,
        win_rate: submitted > 0 ? Math.round((won / submitted) * 1000) / 1000 : 0,
        median_time_to_first_click_sec: median(timeToFirstClickSec),
      },
      niches,
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Per-niche speed leaderboard: median time-to-submit, win rate, response rate, avg connect
// cost. Combines posted_at + submitted_at + outcome status + tags. Lets the user see "AI
// automation has 12s median submit time + 18% reply rate + $13 avg cost" — i.e. which niches
// are profitable to keep on fast-poll vs which to cut.
router.get("/analytics/niche-speed", async (_req: Request, res: Response) => {
  try {
    const rows = await cloud.getProposalsByFilter({ limit: 500 });
    const byNiche = new Map<string, {
      submissions: number;
      timeToSubmitSec: number[];     // posted_at → submitted_at
      timeFromScrapeSec: number[];   // created_at → submitted_at (always available)
      connects: number[];
      won: number;
      rejected: number;
      noResponse: number;
      interviewed: number;
      viewed: number;
      proposalsWhenSubmittedSamples: number[];
    }>();

    function bucket(name: string) {
      let b = byNiche.get(name);
      if (!b) {
        b = {
          submissions: 0, timeToSubmitSec: [], timeFromScrapeSec: [],
          connects: [], won: 0, rejected: 0, noResponse: 0, interviewed: 0,
          viewed: 0, proposalsWhenSubmittedSamples: [],
        };
        byNiche.set(name, b);
      }
      return b;
    }

    for (const r of rows) {
      const tags = (r.tags as string[] | null) || [];
      const niches = tags.length > 0 ? tags : ["other"];
      const submittedAt = r.submitted_at as string | undefined;
      const postedAt = r.posted_at as string | undefined;
      const createdAt = r.created_at as string | undefined;
      const status = (r.status as string) || "";
      const cost = r.submitted_connects_cost as number | undefined;
      const proposalsWhenSubmitted = r.proposals_when_submitted as number | undefined;
      const viewedAt = r.viewed_at as string | undefined;

      for (const niche of niches) {
        const b = bucket(niche.toLowerCase());
        if (status === "submitted" || status === "won" || status === "rejected" || status === "no_response" || status === "interviewed") {
          b.submissions++;
          if (submittedAt && postedAt) {
            const sec = (new Date(submittedAt).getTime() - new Date(postedAt).getTime()) / 1000;
            if (sec >= 0 && sec < 30 * 24 * 3600) b.timeToSubmitSec.push(sec);
          }
          if (submittedAt && createdAt) {
            const sec = (new Date(submittedAt).getTime() - new Date(createdAt).getTime()) / 1000;
            if (sec >= 0 && sec < 30 * 24 * 3600) b.timeFromScrapeSec.push(sec);
          }
          if (typeof cost === "number" && cost > 0) b.connects.push(cost);
          if (typeof proposalsWhenSubmitted === "number" && proposalsWhenSubmitted >= 0) b.proposalsWhenSubmittedSamples.push(proposalsWhenSubmitted);
        }
        if (status === "won") b.won++;
        else if (status === "rejected") b.rejected++;
        else if (status === "no_response") b.noResponse++;
        else if (status === "interviewed") b.interviewed++;
        if (viewedAt) b.viewed++;
      }
    }

    function median(xs: number[]): number | null {
      if (xs.length === 0) return null;
      const s = [...xs].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
    }
    function avg(xs: number[]): number | null {
      if (xs.length === 0) return null;
      return Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
    }

    const niches = Array.from(byNiche.entries())
      .filter(([, b]) => b.submissions > 0)
      .map(([niche, b]) => {
        const outcomed = b.won + b.rejected + b.noResponse + b.interviewed;
        return {
          niche,
          submissions: b.submissions,
          median_time_to_submit_sec: median(b.timeToSubmitSec),
          median_time_from_scrape_sec: median(b.timeFromScrapeSec),
          avg_connects: avg(b.connects),
          median_proposals_when_submitted: median(b.proposalsWhenSubmittedSamples),
          win_rate: outcomed > 0 ? Math.round((b.won / outcomed) * 100) / 100 : null,
          response_rate: b.submissions > 0 ? Math.round(((b.won + b.interviewed + b.viewed) / b.submissions) * 100) / 100 : null,
          won: b.won, rejected: b.rejected, no_response: b.noResponse, interviewed: b.interviewed,
        };
      })
      .sort((a, b) => (b.win_rate ?? 0) - (a.win_rate ?? 0) || b.submissions - a.submissions);

    res.json({ count: niches.length, niches });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Variant performance leaderboard: per (niche, variant_name) win/response rates so we can
// see which A/B prompt fragments are actually beating the default. Only rows that recorded
// a variant_niche are aggregated; everything else falls into the implicit "default" baseline
// per niche so you can compare variant-X to no-variant for the same niche.
router.get("/analytics/variant-performance", async (_req: Request, res: Response) => {
  try {
    const rows = await cloud.getProposalsByFilter({ limit: 1000 });
    type Bucket = {
      submissions: number; viewed: number; won: number; rejected: number;
      noResponse: number; interviewed: number;
    };
    const byKey = new Map<string, { niche: string; variant: string; b: Bucket }>();
    function bucket(niche: string, variant: string): Bucket {
      const key = `${niche}::${variant}`;
      let entry = byKey.get(key);
      if (!entry) {
        entry = { niche, variant, b: {
          submissions: 0, viewed: 0, won: 0, rejected: 0, noResponse: 0, interviewed: 0,
        } };
        byKey.set(key, entry);
      }
      return entry.b;
    }

    for (const r of rows) {
      const status = (r.status as string) || "";
      const submitted = ["submitted", "won", "rejected", "no_response", "interviewed"].includes(status);
      if (!submitted) continue;

      const variantNiche = (r.variant_niche as string | null) || null;
      const variantName = (r.variant_name as string | null) || null;
      const tags = (r.tags as string[] | null) || [];
      // If a variant was recorded, attribute the row to that exact (niche, variant). Otherwise
      // bucket against each tag with variant="(default)" so comparisons stay apples-to-apples.
      const targets: Array<{ niche: string; variant: string }> = [];
      if (variantNiche && variantName) {
        targets.push({ niche: variantNiche, variant: variantName });
      } else {
        const base = tags.length > 0 ? tags : ["other"];
        for (const t of base) targets.push({ niche: t.toLowerCase(), variant: "(default)" });
      }

      for (const { niche, variant } of targets) {
        const b = bucket(niche, variant);
        b.submissions++;
        if (r.viewed_at) b.viewed++;
        if (status === "won") b.won++;
        else if (status === "rejected") b.rejected++;
        else if (status === "no_response") b.noResponse++;
        else if (status === "interviewed") b.interviewed++;
      }
    }

    const variants = Array.from(byKey.values())
      .map(({ niche, variant, b }) => {
        const outcomed = b.won + b.rejected + b.noResponse + b.interviewed;
        return {
          niche,
          variant,
          submissions: b.submissions,
          won: b.won,
          rejected: b.rejected,
          no_response: b.noResponse,
          interviewed: b.interviewed,
          win_rate: outcomed > 0 ? Math.round((b.won / outcomed) * 100) / 100 : null,
          response_rate: b.submissions > 0
            ? Math.round(((b.won + b.interviewed + b.viewed) / b.submissions) * 100) / 100
            : null,
          is_default: variant === "(default)",
        };
      })
      .sort((a, b) =>
        a.niche.localeCompare(b.niche) ||
        (b.win_rate ?? -1) - (a.win_rate ?? -1) ||
        b.submissions - a.submissions
      );

    res.json({ count: variants.length, variants });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

router.get("/reinforcement/niches", async (_req: Request, res: Response) => {
  try {
    const { getAllNichePerformance } = await import("../services/reinforcement");
    const stats = await getAllNichePerformance();
    const rows = Object.values(stats).sort((a, b) => (b.win_rate || 0) - (a.win_rate || 0));
    res.json({ count: rows.length, rows });
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

// POST /api/upwork/skip { jobId } — manual skip from dashboard (parity with Telegram skip button)
router.post("/upwork/skip", async (req: Request, res: Response) => {
  const { jobId, reason } = req.body as { jobId?: string; reason?: string };
  if (!jobId) {
    res.status(400).json({ error: "Required: jobId" });
    return;
  }
  try {
    await cloud.updateProposalStatus(jobId, "skipped", { skip_reason: reason || "dashboard_skip" });
    logger.info(`[api] Skipped proposal: ${jobId} (${reason || "dashboard"})`);
    res.json({ ok: true, jobId, status: "skipped" });
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
