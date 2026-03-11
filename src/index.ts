/**
 * src/index.ts — Entry point (mirrors Riona's index.ts exactly)
 * Starts Express server + initializes AI agent + runs cron cycles
 */
import dotenv from "dotenv";
dotenv.config();

import logger from "./config/logger";
import { shutdown } from "./services";
import { notify } from "./services/telegram";
import app from "./app";
import { initAgent } from "./Agent/index";
import { runProposalCycle } from "./client/Upwork";
import { runDiscoveryCycle } from "./client/Chrome";
import { PORT, BROWSER_MODE } from "./secret";
import { engine } from "./browser";
import cron from "node-cron";

// Upwork search keywords — each is searched individually
const UPWORK_KEYWORDS = [
  "AI automation",
  "Claude API",
  "Python automation",
  "n8n workflow",
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
  // projectLength: "months" as const,              // 1-3 month projects
  // clientLocation: "United States",               // US clients only
  // connectPrice: "0-2",                           // cheap to apply
  // perPage: 50,                                   // max results per page
};

// Score threshold: 0-10, jobs below this are skipped
const UPWORK_SCORE_THRESHOLD = 5;

const CHROME_KEYWORDS = ["saas founder", "ai automation", "b2b startup", "software founder"];

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
    // Keep the browser open until user presses Ctrl+C
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
    if (!moduleFilter || moduleFilter === "chrome") await runDiscoveryCycle(CHROME_KEYWORDS);
    await engine.close();
    process.exit(0);
    return;
  }

  // Start HTTP server
  const server = app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
    logger.info(`Health: http://localhost:${PORT}/api/health`);
  });

  // Run initial Upwork scan on startup
  logger.info("[startup] Running initial Upwork scan...");
  await runProposalCycle(UPWORK_KEYWORDS, UPWORK_FILTERS, UPWORK_SCORE_THRESHOLD).catch((e) => logger.error("[startup] upwork error", e));

  // Cron schedules
  // Upwork scan every 3 hours
  cron.schedule("0 */3 * * *", async () => {
    logger.info("[cron] Upwork scan");
    await runProposalCycle(UPWORK_KEYWORDS, UPWORK_FILTERS, UPWORK_SCORE_THRESHOLD).catch((e) => logger.error("[cron] upwork error", e));
  });

  // Chrome discovery every 30 minutes
  cron.schedule("*/30 * * * *", async () => {
    logger.info("[cron] Chrome discovery");
    await runDiscoveryCycle(CHROME_KEYWORDS).catch((e) => logger.error("[cron] chrome error", e));
  });

  await notify(`🚀 *Autonomous Outreach Agent started*\nMode: ${BROWSER_MODE} | Upwork: every 3h | Chrome: every 30min`);
  logger.info(`All crons registered. Browser mode: ${BROWSER_MODE}. Agent running 24/7.`);

  const graceful = async () => {
    await engine.close();
    shutdown(server);
  };
  process.on("SIGTERM", () => { logger.info("SIGTERM"); graceful(); });
  process.on("SIGINT", () => { logger.info("SIGINT"); graceful(); });
}

startServer();
