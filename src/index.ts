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
import { PORT } from "./secret";
import cron from "node-cron";

const UPWORK_KEYWORDS = ["AI automation", "Claude API", "Python automation", "n8n workflow", "marketing automation"];
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
  const moduleFilter = args.find((a) => a.startsWith("--module="))?.split("=")[1];

  if (once) {
    // Single run mode
    if (!moduleFilter || moduleFilter === "upwork") await runProposalCycle(UPWORK_KEYWORDS);
    if (!moduleFilter || moduleFilter === "chrome") await runDiscoveryCycle(CHROME_KEYWORDS);
    process.exit(0);
    return;
  }

  // Start HTTP server
  const server = app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
    logger.info(`Health: http://localhost:${PORT}/api/health`);
  });

  // Cron schedules
  // Upwork scan every 2 hours
  cron.schedule("0 */2 * * *", async () => {
    logger.info("[cron] Upwork scan");
    await runProposalCycle(UPWORK_KEYWORDS).catch((e) => logger.error("[cron] upwork error", e));
  });

  // Chrome discovery every 30 minutes
  cron.schedule("*/30 * * * *", async () => {
    logger.info("[cron] Chrome discovery");
    await runDiscoveryCycle(CHROME_KEYWORDS).catch((e) => logger.error("[cron] chrome error", e));
  });

  await notify("🚀 *Autonomous Outreach Agent started*\nUpwork: every 2h | Chrome: every 30min");
  logger.info("All crons registered. Agent running 24/7.");

  process.on("SIGTERM", () => { logger.info("SIGTERM"); shutdown(server); });
  process.on("SIGINT", () => { logger.info("SIGINT"); shutdown(server); });
}

startServer();
