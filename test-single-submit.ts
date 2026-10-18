/**
 * Test: Submit a single proposal with DRY RUN to verify the form-filling works.
 * Uses the highest-scoring queued job.
 */
import dotenv from "dotenv";
dotenv.config();

import logger from "./src/config/logger";
import { initAgent } from "./src/Agent/index";
import { generateCoverLetter } from "./src/Agent";
import * as upworkBrowser from "./src/browser/upwork";
import { engine } from "./src/browser";

async function main() {
  await initAgent("sample.character.json");

  // Use the 10/10 job as test target
  const testJob = {
    url: "https://www.upwork.com/jobs/Python-Developer-for-Powered-Product-span-class-highlight-LLM-span-API-span-class-highlight-Integration-span-amp-AWS-Infrastructure_~022031721977786293019/",
    title: "Python Developer for AI-Powered Product – LLM API Integration & AWS Infrastructure",
    description: "Looking for Python developer with LLM API integration experience and AWS infrastructure knowledge."
  };

  logger.info(`[Test] Generating cover letter for: ${testJob.title.slice(0, 60)}`);
  const coverLetter = await generateCoverLetter({
    title: testJob.title,
    description: testJob.description,
  });
  logger.info(`[Test] Cover letter generated: ${coverLetter.length} chars`);
  logger.info(`[Test] Preview: ${coverLetter.slice(0, 200)}...`);

  // DRY RUN — fill form but don't click submit
  logger.info(`[Test] DRY RUN: Filling proposal form...`);
  const result = await upworkBrowser.submitProposal(testJob.url, coverLetter, {
    dryRun: true,
  });

  logger.info(`[Test] DRY RUN result: ${result ? "FORM FILLED SUCCESSFULLY" : "FAILED TO FILL FORM"}`);

  await engine.close();
  process.exit(result ? 0 : 1);
}

main().catch(e => {
  logger.error(`[Test] Error: ${e.message}`);
  process.exit(1);
});
