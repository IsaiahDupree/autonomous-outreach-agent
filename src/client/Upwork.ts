/**
 * src/client/Upwork.ts — Upwork platform client
 * Dual-mode: tries Safari service first, falls back to Puppeteer.
 * Includes AI-powered job scoring + configurable filters.
 * Supports both keyword search and Best Matches feed scanning.
 */
import logger from "../config/logger";
import { SAFARI_UPWORK_PORT, BROWSER_MODE } from "../secret";
import * as cloud from "../services/cloud";
import * as obsidian from "../services/obsidian";
import * as tg from "../services/telegram";
import { generateCoverLetter, getPortfolioLine } from "../Agent";
import { scoreJob } from "../Agent/scorer";
import * as upworkBrowser from "../browser/upwork";
import type { SearchFilters } from "../browser/upwork";
import { AUTO_SEND, AUTO_SEND_MIN_SCORE } from "../secret";
import { getConnectsRemaining } from "../browser/upwork";

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
  source?: "search" | "best_matches";
  // Freelancer Plus insights
  clientHireRate?: number;
  clientHires?: number;
  competitiveBidRange?: { low?: number; avg?: number; high?: number };
  interviewing?: number;
  invitesSent?: number;
  unansweredInvites?: number;
  // Enhanced insights
  paymentVerified?: boolean;
  screeningQuestionCount?: number;
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
    return scraped.map((j) => ({ ...j, score: j.score || 0, source: "search" as const }));
  } catch (e) {
    logger.error(`[Upwork] scanJobs error: ${(e as Error).message}`);
    return [];
  }
}

/**
 * Scrape Best Matches / Featured feed — Upwork's curated recommendations.
 */
export async function scanBestMatches(limit = 20): Promise<UpworkJob[]> {
  try {
    if (BROWSER_MODE === "safari") return [];
    logger.info("[Upwork] Scanning Best Matches feed...");
    const scraped = await upworkBrowser.scrapeBestMatches(limit);
    return scraped.map((j) => ({ ...j, score: j.score || 0, source: "best_matches" as const }));
  } catch (e) {
    logger.error(`[Upwork] scanBestMatches error: ${(e as Error).message}`);
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

export async function submitProposal(job: UpworkJob, opts?: { dryRun?: boolean }): Promise<boolean> {
  try {
    // Regenerate cover letter if empty (e.g. queued jobs from before the fix)
    if (!job.coverLetter || job.coverLetter.trim().length === 0) {
      logger.info(`[Upwork] Cover letter empty for "${(job.title || "").slice(0, 50)}" — regenerating...`);
      const rebuilt = await buildProposal(job);
      job.coverLetter = rebuilt.coverLetter;
      if (job.coverLetter && job.coverLetter.trim().length > 0) {
        // Save regenerated cover letter back to Supabase
        await cloud.saveProposal({
          jobId: job.id, title: job.title, url: job.url,
          description: job.description, budget: job.budget,
          score: job.score || 0, bid: job.bid || 0,
          coverLetter: job.coverLetter,
        });
        logger.info(`[Upwork] Regenerated cover letter: ${job.coverLetter.length} chars`);
      } else {
        logger.error(`[Upwork] Cover letter regeneration failed — still empty`);
        return false;
      }
    }
    if (!opts?.dryRun && await checkSafari()) {
      const res = await fetch(`${SAFARI_BASE}/api/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id, coverLetter: job.coverLetter, bid: job.bid }),
        signal: AbortSignal.timeout(30000),
      });
      return res.ok;
    }
    if (!opts?.dryRun && BROWSER_MODE === "safari") return false;
    return await upworkBrowser.submitProposal(job.url, job.coverLetter || "", {
      dryRun: opts?.dryRun,
      milestones: job.bid ? [{ description: "Full project delivery", amount: job.bid }] : undefined,
      clientBudget: job.budget,
      jobTitle: job.title,
      jobDescription: job.description,
    });
  } catch (e) {
    logger.error(`[Upwork] submitProposal error: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Shared scoring + dedup + approval flow for any job list.
 * Used by both keyword search and Best Matches.
 */
async function processJobs(
  jobs: UpworkJob[],
  scoreThreshold: number,
  label: string,
): Promise<void> {
  if (jobs.length === 0) {
    logger.info(`[Upwork] ${label}: No jobs found`);
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
    logger.info(`[Upwork] ${label}: Skipped ${dupeCount} duplicates`);
  }

  // Score each new job
  const scoredJobs: UpworkJob[] = [];
  let preFiltered = 0;
  for (const job of newJobs) {
    logger.info(`[Upwork] Scoring: "${job.title.slice(0, 60)}..."`);
    const result = await scoreJob({
      title: job.title,
      description: job.description,
      budget: job.budget,
      posted: job.posted,
      proposals: job.proposals,
      clientHireRate: job.clientHireRate,
      clientHires: job.clientHires,
      competitiveBidRange: job.competitiveBidRange,
      interviewing: job.interviewing,
      invitesSent: job.invitesSent,
      paymentVerified: job.paymentVerified,
    });
    job.score = result.score;
    job.reasoning = result.reasoning;
    job.bidRange = result.bidRange;
    job.tags = result.tags;

    if (result.excluded) {
      preFiltered++;
      logger.info(`[Upwork]   ✗ Excluded: ${result.excluded}`);
      await cloud.saveProposal({
        jobId: job.id, title: job.title, url: job.url,
        description: job.description, budget: job.budget,
        score: 0, status: "excluded",
        reasoning: result.excluded,
      }).catch(() => {});
      continue;
    }

    logger.info(`[Upwork]   Score: ${result.score}/10 (pre: ${result.preScore}/100) — ${result.reasoning}`);

    const status = result.score >= scoreThreshold ? "queued" : "below_threshold";

    // Generate cover letter at queue time so it's ready for instant submission
    if (result.score >= scoreThreshold) {
      try {
        const built = await buildProposal(job);
        job.coverLetter = built.coverLetter;
        logger.info(`[Upwork] Pre-generated cover letter: ${(job.coverLetter || "").length} chars`);
      } catch (e) {
        logger.warn(`[Upwork] Cover letter pre-gen failed: ${(e as Error).message}`);
      }
    }

    await cloud.saveProposal({
      jobId: job.id, title: job.title, url: job.url,
      description: job.description, budget: job.budget,
      score: result.score, preScore: result.preScore,
      status,
      reasoning: result.reasoning,
      tags: result.tags,
      coverLetter: job.coverLetter,
      // Freelancer Plus insights
      clientHireRate: job.clientHireRate,
      clientHires: job.clientHires,
      competitiveBidRange: job.competitiveBidRange,
      interviewing: job.interviewing,
      invitesSent: job.invitesSent,
      unansweredInvites: job.unansweredInvites,
      // Enhanced insights
      paymentVerified: job.paymentVerified,
      screeningQuestionCount: job.screeningQuestionCount,
    }).catch((e) => logger.warn(`[Upwork] Failed to save: ${(e as Error).message}`));

    if (result.score >= scoreThreshold) {
      scoredJobs.push(job);
    }
  }

  logger.info(`[Upwork] ${label}: ${scoredJobs.length}/${newJobs.length} qualified (${preFiltered} pre-filtered, ${dupeCount} dupes, threshold >=${scoreThreshold})`);

  if (scoredJobs.length === 0) {
    await tg.notify(`📋 *${label} complete*\n${jobs.length} scraped, ${newJobs.length} new, 0 above threshold (${scoreThreshold}/10)`);
    return;
  }

  // Send summary to Telegram
  const sorted = scoredJobs.sort((a, b) => (b.score || 0) - (a.score || 0));
  const summary = sorted
    .map((j, i) => `${i + 1}. *${j.title.slice(0, 50)}* — ${j.score}/10\n   💰 ${j.budget || "N/A"} | ${j.bidRange || "TBD"}\n   📊 ${j.proposals || "? proposals"}\n   ${j.reasoning || ""}\n   🔗 ${j.url}`)
    .join("\n\n");
  await tg.notify(`📋 *${label}: ${scoredJobs.length} qualified jobs*\n\n${summary}`);

  // Process each qualified job
  for (const job of scoredJobs) {
    // Check connects budget before submitting
    const connects = getConnectsRemaining();
    if (connects !== null && connects < 16) {
      logger.warn(`[Upwork] Low connects: ${connects} remaining — pausing auto-submissions`);
      await tg.notify(`⚠️ Low connects: ${connects} remaining. Pausing auto-submissions.`);
      break;
    }

    const proposal = await buildProposal(job);

    // Always add portfolio line in auto-send mode
    const autoSendEligible = AUTO_SEND && (proposal.score || 0) >= AUTO_SEND_MIN_SCORE;
    if (autoSendEligible) {
      const portfolioLine = getPortfolioLine(proposal.tags);
      if (portfolioLine) {
        proposal.coverLetter = `${portfolioLine}\n\n${proposal.coverLetter || ""}`;
      }
    }

    await cloud.saveProposal({
      jobId: proposal.id, title: proposal.title, url: proposal.url,
      description: proposal.description, budget: proposal.budget,
      score: proposal.score || 0, bid: proposal.bid || 0,
      coverLetter: proposal.coverLetter || "", status: autoSendEligible ? "auto_sending" : "pending",
    });
    obsidian.logProposal({ title: proposal.title, score: proposal.score || 0, bid: proposal.bid || 0 }, "pending");

    // Build Plus insights line if available
    const plusParts: string[] = [];
    if (proposal.clientHireRate !== undefined) plusParts.push(`Hire: ${proposal.clientHireRate}%`);
    if (proposal.competitiveBidRange?.avg) plusParts.push(`Avg bid: $${proposal.competitiveBidRange.avg}`);
    if (proposal.interviewing) plusParts.push(`Interviewing: ${proposal.interviewing}`);
    if (proposal.invitesSent) plusParts.push(`Invites: ${proposal.invitesSent}`);
    const plusLine = plusParts.length > 0 ? `🔍 ${plusParts.join(" | ")}` : "";

    const preview = [
      `📌 *${proposal.title}*`,
      `🔗 ${proposal.url}`,
      `💰 Budget: ${proposal.budget || "N/A"} | Suggested bid: ${proposal.bidRange || "TBD"}`,
      `📊 Proposals: ${proposal.proposals || "unknown"}`,
      `🎯 Score: ${proposal.score}/10 — ${proposal.reasoning || ""}`,
      proposal.tags?.length ? `🏷 Skills: ${proposal.tags.join(", ")}` : "",
      plusLine,
      proposal.source === "best_matches" ? "⭐ Source: Best Matches" : "",
      `\n📝 *Cover Letter:*\n${proposal.coverLetter || "(none)"}`,
    ].filter(Boolean).join("\n");

    if (autoSendEligible) {
      // ── AUTO-SEND: no human approval needed ──
      // Re-check connects right before submission (may have changed since loop start)
      const connectsNow = getConnectsRemaining();
      if (connectsNow !== null && connectsNow < 16) {
        logger.warn(`[Upwork] AUTO-SEND skipped: only ${connectsNow} connects remaining`);
        await tg.notify(`⚠️ Auto-send skipped for "${proposal.title.slice(0, 40)}" — only ${connectsNow} connects left`);
        await cloud.updateProposalStatus(proposal.id, "queued");
        continue;
      }
      logger.info(`[Upwork] AUTO-SEND: score ${proposal.score}/10 >= ${AUTO_SEND_MIN_SCORE} — submitting "${proposal.title.slice(0, 50)}"`);
      await tg.notify(`🤖 *Auto-sending proposal* (score ${proposal.score}/10)\n\n${preview}`);

      const ok = await submitProposal(proposal);
      const status = ok ? "submitted" : "error";
      await cloud.updateProposalStatus(proposal.id, status);
      obsidian.logProposal({ title: proposal.title, score: proposal.score || 0, bid: proposal.bid || 0 }, status);
      await tg.notify(ok ? `🚀 Auto-submitted: ${proposal.title}` : `❌ Auto-submit failed: ${proposal.title}`);
    } else {
      // ── MANUAL APPROVAL: send to Telegram and wait ──
      await tg.sendForApproval({
        id: proposal.id, type: "proposal",
        title: `Upwork: ${proposal.title}`,
        preview,
        jobUrl: proposal.url,
      });

      const { action } = await tg.waitForApproval(proposal.id, "upwork");

      if (action === "send" || action === "send_with_portfolio") {
        if (action === "send_with_portfolio") {
          const portfolioLine = getPortfolioLine(proposal.tags);
          if (portfolioLine) {
            proposal.coverLetter = `${portfolioLine}\n\n${proposal.coverLetter || ""}`;
            await cloud.saveProposal({
              jobId: proposal.id, title: proposal.title, url: proposal.url,
              description: proposal.description, budget: proposal.budget,
              score: proposal.score || 0, bid: proposal.bid || 0,
              coverLetter: proposal.coverLetter, status: "pending",
            });
            await tg.notify(`📋 Portfolio link added to proposal: ${proposal.title}`);
          }
        }

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
  }
}

/**
 * Full cycle: keyword search → AI score → approval → submit
 */
export async function runProposalCycle(
  keywords: string[],
  filters: SearchFilters = {},
  scoreThreshold = 6
): Promise<void> {
  logger.info(`[Upwork] Starting proposal cycle (${keywords.length} keywords, threshold=${scoreThreshold})`);
  const jobs = await scanJobs(keywords, filters, 50);
  logger.info(`[Upwork] Found ${jobs.length} raw jobs from search`);
  await processJobs(jobs, scoreThreshold, "Upwork search");
  logger.info("[Upwork] Proposal cycle complete");
}

/**
 * Best Matches cycle: scrape featured feed → AI score → approval → submit
 * Filters for AI-relevant jobs with < 20 proposals.
 */
export async function runBestMatchesCycle(
  scoreThreshold = 5
): Promise<void> {
  logger.info("[Upwork] Starting Best Matches cycle");
  const jobs = await scanBestMatches(50);
  logger.info(`[Upwork] Found ${jobs.length} best-match jobs`);
  await processJobs(jobs, scoreThreshold, "Best Matches");
  logger.info("[Upwork] Best Matches cycle complete");
}

/**
 * Get close rate metrics from Supabase.
 * Tracks: submitted → won/rejected/no_response
 */
export async function getCloseRateMetrics(): Promise<{
  submitted: number;
  won: number;
  rejected: number;
  noResponse: number;
  closeRate: number;
  avgScore: number;
}> {
  const metrics = await cloud.getProposalMetrics();
  const closeRate = metrics.submitted > 0
    ? Math.round((metrics.won / metrics.submitted) * 100)
    : 0;
  return { ...metrics, closeRate };
}
