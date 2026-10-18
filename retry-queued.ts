/**
 * Retry all queued high-score proposals: regenerate cover letters and submit.
 * Uses src/services/retry-queue.ts for backoff + bounded retries instead of
 * a single-pass loop.
 */
import dotenv from "dotenv";
dotenv.config();

import logger from "./src/config/logger";
import { initAgent } from "./src/Agent/index";
import { generateCoverLetter } from "./src/Agent";
import * as upworkBrowser from "./src/browser/upwork";
import { engine } from "./src/browser";
import { RetryQueue } from "./src/services/retry-queue";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY)!;
const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" };

interface QueuedJob {
  job_id: string;
  job_title?: string;
  job_url: string;
  job_description?: string;
  score?: number;
  budget?: string;
  proposal_text?: string;
}

async function updateStatus(jobId: string, status: string, coverLetter?: string) {
  const body: Record<string, string> = { status };
  if (coverLetter) body.proposal_text = coverLetter;
  await fetch(`${SUPABASE_URL}/rest/v1/upwork_proposals?job_id=eq.${jobId}`, {
    method: "PATCH", headers: { ...headers, Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
}

async function processJob(job: QueuedJob): Promise<boolean> {
  let coverLetter = job.proposal_text || "";
  if (!coverLetter.trim()) {
    logger.info(`[Retry] Generating cover letter for ${job.job_id}`);
    coverLetter = await generateCoverLetter({
      title: job.job_title || "Untitled",
      description: job.job_description || job.job_title || "No description available",
      budget: job.budget,
    });
    await updateStatus(job.job_id, "queued", coverLetter);
  }
  if (!coverLetter.trim()) return false;

  await updateStatus(job.job_id, "auto_sending");
  const ok = await upworkBrowser.submitProposal(job.job_url, coverLetter, {
    milestones: job.budget
      ? [{ description: "Full project delivery", amount: parseFloat(job.budget) || 500 }]
      : undefined,
  });

  if (ok) {
    await updateStatus(job.job_id, "submitted");
    logger.info(`[Retry] ✓ SUBMITTED: ${job.job_title?.slice(0, 50)}`);
  } else {
    logger.warn(`[Retry] submitProposal returned false for ${job.job_id}`);
  }
  return ok;
}

async function main() {
  await initAgent("sample.character.json");

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/upwork_proposals?select=job_id,job_title,job_url,job_description,score,budget,proposal_text&status=eq.queued&score=gte.7&order=score.desc`,
    { headers }
  );
  const jobs: QueuedJob[] = await res.json();
  logger.info(`[Retry] Found ${jobs.length} queued jobs with score >= 7`);

  const queue = new RetryQueue<QueuedJob>(
    async (job) => {
      try {
        return await processJob(job);
      } catch (e) {
        logger.error(`[Retry] processJob error for ${job.job_id}: ${(e as Error).message}`);
        return false;
      }
    },
    {
      maxAttempts: Number(process.env.RETRY_MAX_ATTEMPTS) || 3,
      baseDelayMs: Number(process.env.RETRY_BASE_MS) || 5000,
      factor: 2,
      maxDelayMs: 5 * 60 * 1000,
      jitter: true,
    }
  );

  for (const job of jobs) queue.enqueue(job.job_id, job);

  const result = await queue.drain();
  for (const item of result.exhausted) {
    await updateStatus(item.id, "error");
    logger.error(`[Retry] ✗ EXHAUSTED ${item.id} after ${item.attempts} attempts: ${item.lastError ?? "non-throw failure"}`);
  }

  logger.info(`[Retry] Done: ${result.succeeded.length} submitted, ${result.exhausted.length} exhausted out of ${jobs.length}`);
  await engine.close();
  process.exit(result.exhausted.length > 0 ? 1 : 0);
}

main().catch(e => {
  logger.error(`[Retry] Fatal: ${e.message}`);
  process.exit(1);
});
