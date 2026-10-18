/**
 * Test: Actually submit the top-scoring proposal and verify on proposals page.
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

  const testJob = {
    url: "https://www.upwork.com/jobs/Python-Developer-for-Powered-Product-span-class-highlight-LLM-span-API-span-class-highlight-Integration-span-amp-AWS-Infrastructure_~022031721977786293019/",
    title: "Python Developer for AI-Powered Product – LLM API Integration & AWS Infrastructure",
    description: "Looking for Python developer with LLM API integration experience and AWS infrastructure knowledge."
  };

  logger.info(`[Test] Generating cover letter...`);
  const coverLetter = await generateCoverLetter({
    title: testJob.title,
    description: testJob.description,
  });
  logger.info(`[Test] Cover letter: ${coverLetter.length} chars`);

  // REAL SUBMIT
  logger.info(`[Test] REAL SUBMIT: Sending proposal...`);
  const result = await upworkBrowser.submitProposal(testJob.url, coverLetter);

  logger.info(`[Test] Result: ${result ? "SUBMITTED SUCCESSFULLY" : "SUBMISSION FAILED"}`);

  await engine.close();
  process.exit(result ? 0 : 1);
}

main().catch(e => {
  logger.error(`[Test] Error: ${e.message}`);
  process.exit(1);
});
