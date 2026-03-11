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
import { runProposalCycle, runBestMatchesCycle, getCloseRateMetrics } from "./client/Upwork";
import { runDiscoveryCycle } from "./client/Chrome";
import { PORT, BROWSER_MODE } from "./secret";
import { engine } from "./browser";
import cron from "node-cron";

// Upwork search keywords — each is searched individually
const UPWORK_KEYWORDS = [
  "AI automation",
  "Claude API",
  "Python automation",
  "web scraping bot",
  "marketing automation",
  "AI chatbot development",
  "data pipeline",
  "mobile app development",
  "react native app",
  "flutter app",
  "full stack app",
];

// Default filters for Upwork search
const UPWORK_FILTERS = {
  sort: "recency" as const,
  postedWithin: "24" as const,                      // only jobs from last 24 hours
  budgetMin: 500,                                   // fixed-price $500+ minimum
  hourlyRateMin: 35,                                // hourly $35/hr+ minimum
  paymentVerified: true,                            // verified clients only
  experienceLevel: ["2", "3"] as ("2" | "3")[],     // intermediate + expert
  proposalRange: "0-4" as const,                    // low competition (< 5 proposals)
  clientHires: "1-9" as const,                      // clients with hiring history
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
    if (!moduleFilter || moduleFilter === "chrome") await runDiscoveryCycle(CHROME_KEYWORDS);
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

  // Run initial scans on startup
  logger.info("[startup] Running initial Upwork scan...");
  await runProposalCycle(UPWORK_KEYWORDS, UPWORK_FILTERS, UPWORK_SCORE_THRESHOLD).catch((e) => logger.error("[startup] upwork error", e));
  logger.info("[startup] Running initial Best Matches scan...");
  await runBestMatchesCycle(UPWORK_SCORE_THRESHOLD).catch((e) => logger.error("[startup] best-matches error", e));

  // Cron schedules
  // Upwork keyword search every 3 hours (top of hour)
  cron.schedule("0 */3 * * *", async () => {
    logger.info("[cron] Upwork keyword search");
    await runProposalCycle(UPWORK_KEYWORDS, UPWORK_FILTERS, UPWORK_SCORE_THRESHOLD).catch((e) => logger.error("[cron] upwork error", e));
  });

  // Best Matches feed every 3 hours (offset by 90 min so they alternate)
  cron.schedule("30 1,4,7,10,13,16,19,22 * * *", async () => {
    logger.info("[cron] Best Matches scan");
    await runBestMatchesCycle(UPWORK_SCORE_THRESHOLD).catch((e) => logger.error("[cron] best-matches error", e));
  });

  // Chrome discovery every 30 minutes
  cron.schedule("*/30 * * * *", async () => {
    logger.info("[cron] Chrome discovery");
    await runDiscoveryCycle(CHROME_KEYWORDS).catch((e) => logger.error("[cron] chrome error", e));
  });

  // Daily metrics report at 9 AM
  cron.schedule("0 9 * * *", async () => {
    logger.info("[cron] Daily metrics report");
    await sendMetricsReport().catch((e) => logger.error("[cron] metrics error", e));
  });

  await notify(`🚀 *Autonomous Outreach Agent started*\nMode: ${BROWSER_MODE}\nUpwork search: every 3h | Best Matches: every 3h (offset)\nChrome: every 30min | Metrics: daily 9 AM`);
  logger.info(`All crons registered. Browser mode: ${BROWSER_MODE}. Agent running 24/7.`);

  const graceful = async () => {
    await engine.close();
    shutdown(server);
  };
  process.on("SIGTERM", () => { logger.info("SIGTERM"); graceful(); });
  process.on("SIGINT", () => { logger.info("SIGINT"); graceful(); });
}

startServer();
