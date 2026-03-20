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
import { initAgent } from "./Agent/index";
import { runProposalCycle, runBestMatchesCycle, getCloseRateMetrics, submitTopQueued, checkAndProcessNotifications } from "./client/Upwork";
import { runDiscoveryCycle } from "./client/Chrome";
import { PORT, BROWSER_MODE } from "./secret";
import { engine } from "./browser";
import cron from "node-cron";
import * as control from "./services/process-control";
import * as ops from "./services/operations";

// Upwork search keywords — 10 niches × 2-3 variations each
const UPWORK_KEYWORDS = [
  // Niche 1: AI/LLM automation
  "AI automation", "LLM integration", "AI workflow",
  // Niche 2: Claude/OpenAI/GPT
  "Claude API", "OpenAI API", "GPT integration",
  // Niche 3: Python automation/scripting
  "Python automation", "Python script", "Python developer automation",
  // Niche 4: Web scraping & data extraction
  "web scraping", "data extraction", "web crawler",
  // Niche 5: Chatbot / AI agent
  "AI chatbot", "AI agent", "chatbot development",
  // Niche 6: Marketing automation / CRM
  "marketing automation", "CRM automation", "email automation",
  // Niche 7: Workflow / no-code automation
  "n8n automation", "zapier automation", "workflow automation", "make.com",
  // Niche 8: Data pipeline / ETL
  "data pipeline", "ETL pipeline", "data integration",
  // Niche 9: Mobile app development
  "mobile app development", "react native app", "flutter app", "cross platform app",
  // Niche 10: Full stack / SaaS / MVP
  "full stack app", "SaaS MVP", "full stack developer", "MVP development",
  // Niche 11: Web app development
  "web app development", "web application", "dashboard development", "admin panel",
  // Niche 12: Voice AI / Audio
  "elevenlabs", "11labs", "voice ai", "text to speech", "voice cloning", "voice agent",
  // Niche 13: CAD / 3D Design
  "CAD design", "3D modeling", "AutoCAD", "SolidWorks", "Fusion 360", "CAD automation",
  // Niche 14: Arduino / Embedded / IoT
  "Arduino", "ESP32", "Raspberry Pi", "IoT development", "embedded systems", "microcontroller",
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

  // Run initial scans on startup (tracked)
  logger.info("[startup] Running initial Upwork scan...");
  await ops.trackedSafe("scan_keywords", { source: "startup", keywords: UPWORK_KEYWORDS }, async (opId) => {
    ops.addStep(opId, "search", `Searching ${UPWORK_KEYWORDS.length} keywords`);
    await runProposalCycle(UPWORK_KEYWORDS, UPWORK_FILTERS, UPWORK_SCORE_THRESHOLD);
  });
  logger.info("[startup] Running initial Best Matches scan...");
  await ops.trackedSafe("scan_best_matches", { source: "startup" }, async () => {
    await runBestMatchesCycle(UPWORK_SCORE_THRESHOLD);
  });

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

  // Auto-submit top queued proposals every 12 hours to meet daily minimum (2/day)
  // Runs at 8 AM and 8 PM UTC — picks highest-scoring queued jobs
  const DAILY_SUBMIT_TARGET = 2;
  cron.schedule("0 8,20 * * *", async () => {
    if (!control.isActive()) { logger.info("[cron] Skipped auto-submit (agent paused/stopped)"); return; }
    if (control.isSystemPaused("submitting")) { logger.info("[cron] Skipped auto-submit (submitting paused)"); return; }
    logger.info("[cron] Auto-submit top queued (daily minimum)");
    await ops.trackedSafe("auto_submit", { source: "cron", target: DAILY_SUBMIT_TARGET }, async () => {
      await submitTopQueued(DAILY_SUBMIT_TARGET);
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

  // Daily metrics report at 9 AM (runs even when paused — it's read-only)
  cron.schedule("0 9 * * *", async () => {
    if (control.getState() === "stopped" || control.getState() === "stopping") return;
    logger.info("[cron] Daily metrics report");
    await ops.trackedSafe("metrics", { source: "cron" }, async () => {
      await sendMetricsReport();
    });
  });

  // Register cleanup for graceful stop (via API, Telegram, or signal)
  control.onStop(async () => {
    await engine.close();
    shutdown(server);
  });

  await notify(`🚀 *Autonomous Outreach Agent started*\nMode: ${BROWSER_MODE}\nUpwork search: every 20min | Best Matches: every 20min (offset)\nNotifications: every 1h | Auto-submit: ${DAILY_SUBMIT_TARGET}/day\nMetrics: daily 9 AM\n\n⏸️ /pause — pause all  |  🛑 /stop — shutdown`);
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
