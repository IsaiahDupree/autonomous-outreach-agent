/**
 * src/index.ts — Entry point
 * Starts Express server + initializes AI agent + runs cron cycles
 * Upwork: keyword search (3h) + Best Matches feed (3h offset) + daily metrics
 */
import dotenv from "dotenv";
dotenv.config();

import logger from "./config/logger";
import { shutdown } from "./services";
import { notify } from "./services/telegram";
import app from "./app";
import { initAgent, proactiveTokenRefresh } from "./Agent/index";
import { runProposalCycle, runBestMatchesCycle, getCloseRateMetrics, submitTopQueued, checkAndProcessNotifications } from "./client/Upwork";
import * as cloud from "./services/cloud";
import { runDiscoveryCycle } from "./client/Chrome";
import { PORT, BROWSER_MODE, FAST_POLL, assertRequiredEnv } from "./secret";

assertRequiredEnv();
import { engine } from "./browser";
import cron from "node-cron";
import * as control from "./services/process-control";
import * as ops from "./services/operations";
import { startController, stopController } from "./controller";
import { buildDailyPlan, executeSlot } from "./services/daily-strategy";
import { enrichWithProofs } from "./services/proof-of-work";

// Upwork search keywords — consolidated to ~30 high-signal terms (reduced from 55)
const UPWORK_KEYWORDS = [
  // AI/LLM (core niche)
  "AI automation", "AI agent", "Claude API",
  // Python
  "Python automation", "web scraping",
  // Chatbot
  "AI chatbot", "chatbot development",
  // Marketing/CRM
  "CRM automation", "email automation",
  // Workflow/No-code
  "n8n automation", "workflow automation",
  // Data
  "data pipeline", "data extraction",
  // Mobile
  "mobile app development", "react native app", "flutter app",
  // Full stack / SaaS
  "full stack developer", "SaaS MVP", "web application",
  // Voice AI
  "voice ai", "text to speech", "elevenlabs",
  // CAD / 3D
  "CAD design", "SolidWorks", "Fusion 360",
  // IoT / Embedded
  "Arduino", "ESP32", "Raspberry Pi", "embedded systems",
];

// Default filters — loosened to maximize job volume
// (pre-filter in scorer.ts handles quality control)
const UPWORK_FILTERS = {
  sort: "recency" as const,
  postedWithin: "24" as const,                      // last 24 hours
  budgetMin: 200,                                   // lowered from $500 to catch more
  hourlyRateMin: 25,                                // lowered from $35
  paymentVerified: true,                            // keep: verified clients only
  experienceLevel: ["2", "3"] as ("2" | "3")[],     // keep: intermediate + expert
  // REMOVED: proposalRange — was "0-4", killing ~70% of jobs at search level
  // REMOVED: clientHires — was "1-9", excluding new clients with big budgets
};

// Score threshold: 0-10, jobs below this are skipped
const UPWORK_SCORE_THRESHOLD = 5;

const CHROME_KEYWORDS = ["saas founder", "ai automation", "b2b startup", "software founder"];

/**
 * Send daily close rate metrics to Telegram.
 */
async function sendMetricsReport(): Promise<void> {
  try {
    const m = await getCloseRateMetrics();
    if (m.submitted === 0) {
      await notify("📊 *Daily Metrics*\nNo proposals submitted yet.");
      return;
    }
    const report = [
      "📊 *Daily Close Rate Report*",
      "",
      `📤 Submitted: ${m.submitted}`,
      `🏆 Won: ${m.won}`,
      `❌ Rejected: ${m.rejected}`,
      `🔇 No Response: ${m.noResponse}`,
      `📈 Pending: ${m.submitted - m.won - m.rejected - m.noResponse}`,
      "",
      `*Close Rate: ${m.closeRate}%*`,
      `Avg Score of Submitted: ${m.avgScore}/10`,
    ].join("\n");
    await notify(report);
  } catch (e) {
    logger.error(`[Metrics] Report error: ${(e as Error).message}`);
  }
}

/**
 * Listen for Telegram text commands: /pause, /resume, /stop, /status
 * Runs alongside the approval polling — checks for message updates.
 */
function startTelegramCommandListener(): void {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = require("./secret");
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
  let cmdOffset = 0;

  const poll = async () => {
    if (control.getState() === "stopped") return;
    try {
      const res = await fetch(`${API}/getUpdates?offset=${cmdOffset + 1}&timeout=10&allowed_updates=message`, {
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json() as { result: Array<{ update_id: number; message?: { chat: { id: number }; text?: string } }> };

      for (const update of data?.result || []) {
        cmdOffset = Math.max(cmdOffset, update.update_id);
        const msg = update.message;
        if (!msg || String(msg.chat.id) !== String(TELEGRAM_CHAT_ID) || !msg.text) continue;

        const cmd = msg.text.trim().toLowerCase();

        if (cmd === "/pause" || cmd === "/pause scanning" || cmd === "/pause submitting" || cmd === "/pause notifications") {
          const system = cmd.split(" ")[1];
          if (system) {
            control.pauseSystem(system);
            await notify(`⏸️ *${system} paused*\nSend /resume ${system} to restart`);
          } else {
            control.pause("Telegram command");
            await notify("⏸️ *Agent paused*\nAll cron jobs will skip.\nSend /resume to restart.");
          }
        } else if (cmd === "/resume" || cmd.startsWith("/resume ")) {
          const system = cmd.split(" ")[1];
          if (system) {
            control.resumeSystem(system);
            await notify(`▶️ *${system} resumed*`);
          } else {
            control.resume();
            await notify("▶️ *Agent resumed* — all systems active");
          }
        } else if (cmd === "/stop") {
          await notify("🛑 *Agent shutting down...*");
          await control.stop("Telegram /stop command");
          return; // exit poll loop
        } else if (cmd === "/state" || cmd === "/status") {
          const s = control.getFullState();
          const uptime = Math.round(s.uptime / 60);
          const paused = s.pausedSystems.length > 0 ? `\nPaused: ${s.pausedSystems.join(", ")}` : "";
          await notify(
            `📊 *Agent State: ${s.state.toUpperCase()}*\n` +
            `⏱️ Uptime: ${uptime}m | 🧠 Memory: ${s.memory}MB${paused}\n` +
            `PID: ${s.pid}`
          );
        }
      }
    } catch (e) {
      // Silently retry on network errors
      if ((e as Error).message?.includes("aborted")) { /* timeout, normal */ }
      else logger.warn(`[telegram-cmd] Poll error: ${(e as Error).message}`);
    }
    // Continue polling
    setTimeout(poll, 2000);
  };

  // Start after a delay to not conflict with approval polling initialization
  setTimeout(poll, 5000);
  logger.info("[telegram-cmd] Listening for /pause /resume /stop /status commands");
}

async function startServer() {
  // Init AI agent with character
  try {
    await initAgent("sample.character.json");
  } catch (err) {
    logger.error("Agent init error:", err);
  }

  const args = process.argv.slice(2);
  const once = args.includes("--once");
  const login = args.includes("--login");
  const moduleFilter = args.find((a) => a.startsWith("--module="))?.split("=")[1];

  // Login mode: open a browser for manual login, then exit
  if (login) {
    const { newPage, close: closeBrowser } = await import("./browser/engine");
    const target = moduleFilter === "chrome" || moduleFilter === "linkedin"
      ? "https://www.linkedin.com/login"
      : "https://www.upwork.com/ab/account-security/login";
    logger.info(`[Login] Opening ${target} — log in manually, then press Ctrl+C to save session`);
    const page = await newPage();
    await page.goto(target, { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => { resolve(); });
      process.on("SIGTERM", () => { resolve(); });
    });
    await closeBrowser();
    logger.info("[Login] Session saved to persistent profile. Future runs will use this session.");
    process.exit(0);
    return;
  }

  if (once) {
    // Single run mode
    if (!moduleFilter || moduleFilter === "upwork") await runProposalCycle(UPWORK_KEYWORDS, UPWORK_FILTERS, UPWORK_SCORE_THRESHOLD);
    if (moduleFilter === "best-matches") await runBestMatchesCycle(UPWORK_SCORE_THRESHOLD);
    // LinkedIn discovery disabled — not using LinkedIn outreach
    // if (!moduleFilter || moduleFilter === "chrome") await runDiscoveryCycle(CHROME_KEYWORDS);
    if (moduleFilter === "metrics") await sendMetricsReport();
    await engine.close();
    process.exit(0);
    return;
  }

  // Start HTTP server
  const server = app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
    logger.info(`Health: http://localhost:${PORT}/api/health`);
  });

  // Verify (and auto-recover) Upwork login before any work starts. If we're signed out and
  // UPWORK_EMAIL/PASSWORD are set, this will fill the login form via Puppeteer using the
  // existing handleLogin flow. Notifies via Telegram on success/failure.
  try {
    const { ensureUpworkLoggedIn } = await import("./browser/upwork");
    const ok = await ensureUpworkLoggedIn(notify);
    if (!ok) {
      logger.warn("[startup] Upwork login failed — agent will retry via session-health cron every 15 min. Run `npm run login:upwork` to fix manually.");
    }
  } catch (e) {
    logger.warn(`[startup] Login check error: ${(e as Error).message}`);
  }

  // Start the fast-poll loop BEFORE the initial scans so the real-time loop kicks in within
  // seconds of boot. The 29-keyword initial scan can take 30+ minutes and would otherwise
  // monopolize Chrome before fast-poll ever gets to run.
  if (FAST_POLL) {
    try {
      const { startFastPoll } = await import("./services/fast-poll");
      startFastPoll();
    } catch (e) {
      logger.warn(`[startup] Fast-poll not started: ${(e as Error).message}`);
    }
  } else {
    logger.info("[startup] Fast-poll disabled (set FAST_POLL=true to enable)");
  }

  // Run initial scans on startup (tracked). Skip when SKIP_INITIAL_SCAN=true so dry-run smoke
  // tests and other manual flows don't have to fight a 29-keyword scan over the same Chrome tab.
  if (process.env.SKIP_INITIAL_SCAN === "true") {
    logger.info("[startup] SKIP_INITIAL_SCAN=true — skipping initial scans");
  } else {
    logger.info("[startup] Running initial Upwork scan...");
    await ops.trackedSafe("scan_keywords", { source: "startup", keywords: UPWORK_KEYWORDS }, async (opId) => {
      ops.addStep(opId, "search", `Searching ${UPWORK_KEYWORDS.length} keywords`);
      await runProposalCycle(UPWORK_KEYWORDS, UPWORK_FILTERS, UPWORK_SCORE_THRESHOLD);
    });
    logger.info("[startup] Running initial Best Matches scan...");
    await ops.trackedSafe("scan_best_matches", { source: "startup" }, async () => {
      await runBestMatchesCycle(UPWORK_SCORE_THRESHOLD);
    });
  }

  // Cron schedules — all check control.isActive() before running
  // Upwork keyword search every 20 min — catch jobs within 30 min of posting
  cron.schedule("*/20 * * * *", async () => {
    if (!control.isActive()) { logger.info("[cron] Skipped keyword search (agent paused/stopped)"); return; }
    if (control.isSystemPaused("scanning")) { logger.info("[cron] Skipped keyword search (scanning paused)"); return; }
    logger.info("[cron] Upwork keyword search");
    await ops.trackedSafe("scan_keywords", { source: "cron", keywords: UPWORK_KEYWORDS }, async (opId) => {
      ops.addStep(opId, "search", `Searching ${UPWORK_KEYWORDS.length} keywords`);
      await runProposalCycle(UPWORK_KEYWORDS, UPWORK_FILTERS, UPWORK_SCORE_THRESHOLD);
    });
  });

  // Best Matches feed every 20 min (offset by 10 min so they alternate with keyword search)
  cron.schedule("10,30,50 * * * *", async () => {
    if (!control.isActive()) { logger.info("[cron] Skipped Best Matches (agent paused/stopped)"); return; }
    if (control.isSystemPaused("scanning")) { logger.info("[cron] Skipped Best Matches (scanning paused)"); return; }
    logger.info("[cron] Best Matches scan");
    await ops.trackedSafe("scan_best_matches", { source: "cron" }, async () => {
      await runBestMatchesCycle(UPWORK_SCORE_THRESHOLD);
    });
  });

  // Chrome/LinkedIn discovery disabled — not using LinkedIn outreach
  // cron.schedule("*/30 * * * *", async () => {
  //   logger.info("[cron] Chrome discovery");
  //   await runDiscoveryCycle(CHROME_KEYWORDS).catch((e) => logger.error("[cron] chrome error", e));
  // });

  // ── Daily Strategy: Top-5 quality submissions with staggered timing ──
  const DAILY_SUBMIT_TARGET = 5;

  // 6:30 AM UTC — Build daily plan: rank queue, select top 5, kick off proof generation
  cron.schedule("30 6 * * *", async () => {
    if (!control.isActive()) { logger.info("[cron] Skipped daily plan (agent paused/stopped)"); return; }
    logger.info("[cron] Building daily submission plan");
    await ops.trackedSafe("daily_plan", { source: "cron" }, async () => {
      const plan = await buildDailyPlan();
      // Kick off proof-of-work generation for eligible jobs (async, non-blocking)
      if (plan.proofJobs.length > 0) {
        logger.info(`[cron] Generating proofs for ${plan.proofJobs.length} top jobs`);
        enrichWithProofs(plan.proofJobs.map(j => ({
          jobId: j.jobId, title: j.title, description: j.description,
          budget: j.budget, tags: j.tags,
        }))).catch(e => logger.error(`[cron] Proof enrichment error: ${(e as Error).message}`));
      }
    });
  });

  // Staggered submission slots — spread across the day for optimal client visibility
  // Morning (8 AM UTC): 2 jobs — catches US West Coast evening / EU morning
  cron.schedule("0 8 * * *", async () => {
    if (!control.isActive()) { logger.info("[cron] Skipped morning slot (agent paused/stopped)"); return; }
    if (control.isSystemPaused("submitting")) { logger.info("[cron] Skipped morning slot (submitting paused)"); return; }
    logger.info("[cron] Morning submission slot");
    await ops.trackedSafe("auto_submit", { source: "cron", slot: "morning" }, async () => {
      await executeSlot("morning", submitByJobId);
    });
  });

  // Midday (1 PM UTC): 2 jobs — catches US East Coast morning / EU afternoon
  cron.schedule("0 13 * * *", async () => {
    if (!control.isActive()) { logger.info("[cron] Skipped midday slot (agent paused/stopped)"); return; }
    if (control.isSystemPaused("submitting")) { logger.info("[cron] Skipped midday slot (submitting paused)"); return; }
    logger.info("[cron] Midday submission slot");
    await ops.trackedSafe("auto_submit", { source: "cron", slot: "midday" }, async () => {
      await executeSlot("midday", submitByJobId);
    });
  });

  // Evening (6 PM UTC): 1 job — catches US West Coast morning
  cron.schedule("0 18 * * *", async () => {
    if (!control.isActive()) { logger.info("[cron] Skipped evening slot (agent paused/stopped)"); return; }
    if (control.isSystemPaused("submitting")) { logger.info("[cron] Skipped evening slot (submitting paused)"); return; }
    logger.info("[cron] Evening submission slot");
    await ops.trackedSafe("auto_submit", { source: "cron", slot: "evening" }, async () => {
      await executeSlot("evening", submitByJobId);
    });
  });

  // Check Upwork notifications every hour — catch invites and job alerts fast
  cron.schedule("0 * * * *", async () => {
    if (!control.isActive()) { logger.info("[cron] Skipped notifications (agent paused/stopped)"); return; }
    if (control.isSystemPaused("notifications")) { logger.info("[cron] Skipped notifications (notifications paused)"); return; }
    logger.info("[cron] Checking Upwork notifications");
    await ops.trackedSafe("check_notifications", { source: "cron" }, async () => {
      await checkAndProcessNotifications();
    });
  });

  // Expire stale queued/error jobs daily at 6 AM UTC — keeps the queue fresh
  cron.schedule("0 6 * * *", async () => {
    if (control.getState() === "stopped" || control.getState() === "stopping") return;
    logger.info("[cron] Expiring stale jobs (>72h old)");
    await ops.trackedSafe("expire_stale", { source: "cron" }, async () => {
      const count = await cloud.expireStaleJobs();
      logger.info(`[cron] Expired ${count} stale jobs`);
      if (count > 0) await notify(`🧹 Expired ${count} stale queued/error jobs (>72h old)`);
    });
  });

  // Auto-retry recent error jobs every 6 hours — requeue errors <48h old
  cron.schedule("0 3,9,15,21 * * *", async () => {
    if (!control.isActive()) { logger.info("[cron] Skipped error retry (agent paused/stopped)"); return; }
    logger.info("[cron] Requeuing recent error jobs (<48h old)");
    await ops.trackedSafe("requeue_errors", { source: "cron" }, async () => {
      const count = await cloud.requeueRecentErrors();
      logger.info(`[cron] Requeued ${count} error jobs for retry`);
      if (count > 0) await notify(`🔄 Requeued ${count} recent error jobs for retry`);
    });
  });

  // Session health check every 15 minutes — auto-recover if signed out.
  cron.schedule("*/15 * * * *", async () => {
    if (control.getState() === "stopped" || control.getState() === "stopping") return;
    if (control.isSystemPaused("scanning")) return;
    try {
      const { ensureUpworkLoggedIn } = await import("./browser/upwork");
      await ensureUpworkLoggedIn(notify);
    } catch (e) {
      logger.warn(`[cron] Session health check error: ${(e as Error).message}`);
    }
  });

  // Proactive OAuth token refresh every 4 hours — keeps token fresh during quiet periods
  cron.schedule("0 */4 * * *", async () => {
    if (control.getState() === "stopped" || control.getState() === "stopping") return;
    logger.info("[cron] Proactive OAuth token refresh");
    const ok = await proactiveTokenRefresh();
    if (!ok) {
      await notify("⚠️ *OAuth token refresh failed*\nAgent may lose API access. Check credentials.");
    }
  });

  // Daily metrics report at 9 AM (runs even when paused — it's read-only)
  cron.schedule("0 9 * * *", async () => {
    if (control.getState() === "stopped" || control.getState() === "stopping") return;
    logger.info("[cron] Daily metrics report");
    await ops.trackedSafe("metrics", { source: "cron" }, async () => {
      await sendMetricsReport();
    });
  });

  // outcome-tracking-001: weekly scrape of /nx/proposals/ to catch viewed /
  // messaged / hired / declined transitions the notification stream missed.
  // Sunday 4 AM — stays clear of the 2 AM reinforcement job below so we
  // don't fight for the same Chrome tab.
  cron.schedule("0 4 * * 0", async () => {
    if (control.getState() === "stopped" || control.getState() === "stopping") return;
    logger.info("[cron] Weekly my-proposals outcome sync");
    await ops.trackedSafe("my_proposals_sync", { source: "cron" }, async () => {
      const { runWeeklyMyProposalsSync } = await import("./services/my-proposals-sync");
      const result = await runWeeklyMyProposalsSync();
      logger.info(`[cron] my-proposals sync: scanned=${result.scanned} updated=${result.updated} skipped=${result.skipped} unmatched=${result.unmatched}`);
    });
  });

  // Weekly reinforcement: recompute per-niche win rates + winning patterns from outcomed proposals
  cron.schedule("0 2 * * 0", async () => {
    if (control.getState() === "stopped" || control.getState() === "stopping") return;
    logger.info("[cron] Weekly reinforcement refresh");
    await ops.trackedSafe("reinforcement_refresh", { source: "cron" }, async () => {
      const { computeNichePerformance } = await import("./services/reinforcement");
      const { invalidateNicheCache } = await import("./Agent/scorer");
      const result = await computeNichePerformance();
      invalidateNicheCache();
      logger.info(`[cron] Reinforcement refresh: ${result.updated} niches updated, ${result.skipped} skipped`);
    });
  });

  // Helper: submit a specific job by ID (used by daily strategy slots)
  async function submitByJobId(jobId: string): Promise<boolean> {
    const { submitProposalById } = await import("./client/Upwork");
    return submitProposalById(jobId);
  }

  // Start the autonomous controller (Claude-powered decision loop)
  try {
    const { getClient } = await import("./Agent");
    const client = getClient();
    startController(client);
    logger.info("[startup] Autonomous controller started");
  } catch (e) {
    logger.warn(`[startup] Controller not started: ${(e as Error).message}`);
  }

  // Register cleanup for graceful stop (via API, Telegram, or signal)
  control.onStop(async () => {
    stopController();
    try {
      const { stopFastPoll } = await import("./services/fast-poll");
      stopFastPoll();
    } catch { /* noop */ }
    await engine.close();
    shutdown(server);
  });

  await notify(`🚀 *Autonomous Outreach Agent started*\nMode: ${BROWSER_MODE}\nUpwork search: every 20min | Best Matches: every 20min (offset)\nNotifications: every 1h\nDaily strategy: top ${DAILY_SUBMIT_TARGET} at 8AM/1PM/6PM UTC + fast-apply\nProof-of-work: auto for score 8+ jobs\nMetrics: daily 9 AM\n\n⏸️ /pause ��� pause all  |  🛑 /stop — shutdown`);
  logger.info(`All crons registered. Browser mode: ${BROWSER_MODE}. Agent running 24/7.`);

  // Start listening for Telegram control commands (/pause, /resume, /stop, /status)
  startTelegramCommandListener();

  const graceful = async () => {
    await control.stop("Process signal");
  };
  process.on("SIGTERM", () => { logger.info("SIGTERM"); graceful(); });
  process.on("SIGINT", () => { logger.info("SIGINT"); graceful(); });
}

startServer();
