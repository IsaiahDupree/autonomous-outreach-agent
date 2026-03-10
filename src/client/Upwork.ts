/**
 * src/client/Upwork.ts — Upwork platform client
 * Dual-mode: tries Safari service first, falls back to Puppeteer.
 * Includes AI-powered job scoring + configurable filters.
 */
import logger from "../config/logger";
import { SAFARI_UPWORK_PORT, BROWSER_MODE } from "../secret";
import * as cloud from "../services/cloud";
import * as obsidian from "../services/obsidian";
import * as tg from "../services/telegram";
import { generateCoverLetter } from "../Agent";
import { scoreJob } from "../Agent/scorer";
import * as upworkBrowser from "../browser/upwork";
import type { SearchFilters } from "../browser/upwork";

const SAFARI_BASE = `http://localhost:${SAFARI_UPWORK_PORT}`;

export interface UpworkJob {
  id: string;
  title: string;
  description: string;
  url: string;
  budget?: string;
  score?: number;
  bid?: number;
  coverLetter?: string;
  reasoning?: string;
  bidRange?: string;
  tags?: string[];
  posted?: string;
  proposals?: string;
  clientSpend?: string;
  skills?: string[];
}

let safariUp: boolean | null = null;

async function checkSafari(): Promise<boolean> {
  if (BROWSER_MODE === "puppeteer") return false;
  if (safariUp !== null) return safariUp;
  safariUp = await cloud.checkService(SAFARI_UPWORK_PORT);
  if (safariUp) {
    logger.info(`[Upwork] Safari service UP at :${SAFARI_UPWORK_PORT}`);
  } else {
    logger.info(`[Upwork] Safari service DOWN — ${BROWSER_MODE === "safari" ? "will skip" : "using Puppeteer"}`);
  }
  return safariUp;
}

export async function scanJobs(
  keywords: string[],
  filters: SearchFilters = {},
  limit = 20
): Promise<UpworkJob[]> {
  try {
    if (await checkSafari()) {
      const res = await fetch(`${SAFARI_BASE}/api/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keywords, limit }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`Scan failed: ${res.status}`);
      return res.json() as Promise<UpworkJob[]>;
    }
    if (BROWSER_MODE === "safari") return [];

    // Puppeteer: search each keyword individually with filters
    logger.info(`[Upwork] Searching ${keywords.length} keywords with filters: ${JSON.stringify(filters)}`);
    const scraped = await upworkBrowser.scanJobs(keywords, filters, limit);
    return scraped.map((j) => ({ ...j, score: j.score || 0 }));
  } catch (e) {
    logger.error(`[Upwork] scanJobs error: ${(e as Error).message}`);
    return [];
  }
}

export async function buildProposal(job: UpworkJob): Promise<UpworkJob> {
  const coverLetter = await generateCoverLetter({
    title: job.title,
    description: job.description,
    budget: job.budget,
  });
  return { ...job, coverLetter };
}

export async function submitProposal(job: UpworkJob): Promise<boolean> {
  try {
    if (await checkSafari()) {
      const res = await fetch(`${SAFARI_BASE}/api/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id, coverLetter: job.coverLetter, bid: job.bid }),
        signal: AbortSignal.timeout(30000),
      });
      return res.ok;
    }
    if (BROWSER_MODE === "safari") return false;
    return await upworkBrowser.submitProposal(job.url, job.coverLetter || "", {
      milestones: job.bid ? [{ description: "Full project delivery", amount: job.bid }] : undefined,
    });
  } catch (e) {
    logger.error(`[Upwork] submitProposal error: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Full cycle: search → AI score → build cover letter → Telegram approval → submit
 */
export async function runProposalCycle(
  keywords: string[],
  filters: SearchFilters = {},
  scoreThreshold = 6
): Promise<void> {
  logger.info(`[Upwork] Starting proposal cycle (${keywords.length} keywords, threshold=${scoreThreshold})`);

  const jobs = await scanJobs(keywords, filters);
  logger.info(`[Upwork] Found ${jobs.length} raw jobs`);

  if (jobs.length === 0) {
    logger.info("[Upwork] No jobs found — cycle complete");
    await tg.notify("📋 *Upwork scan complete* — 0 jobs found");
    return;
  }

  // Dedup: skip jobs already in Supabase
  const newJobs: UpworkJob[] = [];
  let dupeCount = 0;
  for (const job of jobs) {
    if (await cloud.proposalExists(job.id)) {
      dupeCount++;
      continue;
    }
    newJobs.push(job);
  }
  if (dupeCount > 0) {
    logger.info(`[Upwork] Skipped ${dupeCount} duplicate jobs already in Supabase`);
  }

  // Score each new job: Stage 1 (deterministic pre-filter) → Stage 2 (AI scoring)
  const scoredJobs: UpworkJob[] = [];
  let preFiltered = 0;
  for (const job of newJobs) {
    logger.info(`[Upwork] Scoring: "${job.title.slice(0, 60)}..."`);
    const result = await scoreJob({
      title: job.title,
      description: job.description,
      budget: job.budget,
      posted: job.posted,
    });
    job.score = result.score;
    job.reasoning = result.reasoning;
    job.bidRange = result.bidRange;
    job.tags = result.tags;

    if (result.excluded) {
      preFiltered++;
      logger.info(`[Upwork]   ✗ Excluded: ${result.excluded}`);
      // Save excluded jobs to Supabase for tracking
      await cloud.saveProposal({
        jobId: job.id, title: job.title, url: job.url,
        description: job.description, budget: job.budget,
        score: 0, status: "excluded",
        reasoning: result.excluded,
      }).catch(() => {});
      continue;
    }

    logger.info(`[Upwork]   Score: ${result.score}/10 (pre: ${result.preScore}/100) — ${result.reasoning}`);

    // Save scored job to Supabase (even if below threshold)
    const status = result.score >= scoreThreshold ? "queued" : "below_threshold";
    await cloud.saveProposal({
      jobId: job.id, title: job.title, url: job.url,
      description: job.description, budget: job.budget,
      score: result.score, preScore: result.preScore,
      status,
      reasoning: result.reasoning,
      tags: result.tags,
    }).catch((e) => logger.warn(`[Upwork] Failed to save to Supabase: ${(e as Error).message}`));

    if (result.score >= scoreThreshold) {
      scoredJobs.push(job);
    }
  }

  logger.info(`[Upwork] ${scoredJobs.length}/${newJobs.length} qualified (${preFiltered} pre-filtered, ${dupeCount} dupes, threshold >=${scoreThreshold})`);

  if (scoredJobs.length === 0) {
    await tg.notify(`📋 *Upwork scan complete*\n${jobs.length} scraped, ${newJobs.length} new, 0 above threshold (${scoreThreshold}/10)`);
    return;
  }

  // Send summary to Telegram
  const sorted = scoredJobs.sort((a, b) => (b.score || 0) - (a.score || 0));
  const summary = sorted
    .map((j, i) => `${i + 1}. *${j.title.slice(0, 50)}* — ${j.score}/10\n   💰 ${j.budget || "N/A"} | ${j.bidRange || "TBD"}\n   ${j.reasoning || ""}\n   🔗 ${j.url}`)
    .join("\n\n");
  await tg.notify(`📋 *Upwork scan: ${scoredJobs.length} qualified jobs*\n\n${summary}`);

  // Process each qualified job
  for (const job of scoredJobs) {
    const proposal = await buildProposal(job);
    // Update with cover letter
    await cloud.saveProposal({
      jobId: proposal.id, title: proposal.title, url: proposal.url,
      description: proposal.description, budget: proposal.budget,
      score: proposal.score || 0, bid: proposal.bid || 0,
      coverLetter: proposal.coverLetter || "", status: "pending",
    });
    obsidian.logProposal({ title: proposal.title, score: proposal.score || 0, bid: proposal.bid || 0 }, "pending");

    // Format preview for Telegram
    const preview = [
      `📌 *${proposal.title}*`,
      `🔗 ${proposal.url}`,
      `💰 Budget: ${proposal.budget || "N/A"} | Suggested bid: ${proposal.bidRange || "TBD"}`,
      `🎯 Score: ${proposal.score}/10 — ${proposal.reasoning || ""}`,
      proposal.tags?.length ? `🏷 Skills: ${proposal.tags.join(", ")}` : "",
      `\n📝 *Cover Letter:*\n${proposal.coverLetter || "(none)"}`,
    ].filter(Boolean).join("\n");

    await tg.sendForApproval({
      id: proposal.id, type: "proposal",
      title: `Upwork: ${proposal.title}`,
      preview,
    });

    const { approved } = await tg.waitForApproval(proposal.id, "upwork");

    if (approved) {
      const ok = await submitProposal(proposal);
      const status = ok ? "submitted" : "error";
      await cloud.updateProposalStatus(proposal.id, status);
      obsidian.logProposal({ title: proposal.title, score: proposal.score || 0, bid: proposal.bid || 0 }, status);
      await tg.notify(ok ? `🚀 Proposal submitted: ${proposal.title}` : `❌ Submission failed: ${proposal.title}`);
    } else {
      await cloud.updateProposalStatus(proposal.id, "skipped");
      obsidian.logProposal({ title: proposal.title, score: proposal.score || 0, bid: proposal.bid || 0 }, "skipped");
    }
  }

  logger.info("[Upwork] Proposal cycle complete");
}
