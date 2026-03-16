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
import { generateCoverLetter, getPortfolioLine, qualityCheckCoverLetter, refineCoverLetter } from "../Agent";
import { researchJob, formatResearchBrief } from "../services/research";
import { scoreJob } from "../Agent/scorer";
import * as upworkBrowser from "../browser/upwork";
import type { SearchFilters, UpworkNotification, ArchivedProposal } from "../browser/upwork";
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
  // Research the job with Perplexity for technical context
  let researchBrief: string | undefined;
  try {
    const research = await researchJob({
      title: job.title,
      description: job.description,
      budget: job.budget,
      skills: job.skills || job.tags,
    });
    if (research) {
      researchBrief = formatResearchBrief(research);
      logger.info(`[Upwork] Research complete for "${job.title.slice(0, 50)}" — ${research.techInsights.length} insights`);
    }
  } catch (e) {
    logger.warn(`[Upwork] Research failed: ${(e as Error).message} — proceeding without`);
  }

  let coverLetter = await generateCoverLetter({
    title: job.title,
    description: job.description,
    budget: job.budget,
    researchBrief,
  });

  // Quality gate: validate cover letter meets winning proposal standards
  const qualityCheck = qualityCheckCoverLetter(coverLetter, {
    title: job.title,
    description: job.description,
    skills: job.skills || job.tags,
    tags: job.tags,
  });

  if (!qualityCheck.passed) {
    logger.info(`[Upwork] Quality gate FAILED (${qualityCheck.score}/100) for "${job.title.slice(0, 50)}" — refining...`);
    logger.info(`[Upwork]   Failed: ${qualityCheck.checks.filter(c => !c.passed).map(c => c.name).join(", ")}`);
    try {
      coverLetter = await refineCoverLetter(coverLetter, {
        title: job.title,
        description: job.description,
        skills: job.skills || job.tags,
        tags: job.tags,
      }, qualityCheck);

      // Re-check after refinement
      const recheck = qualityCheckCoverLetter(coverLetter, {
        title: job.title,
        description: job.description,
        skills: job.skills || job.tags,
        tags: job.tags,
      });
      logger.info(`[Upwork] Quality re-check: ${recheck.score}/100 (${recheck.passed ? "PASSED" : "still failing"})`);
    } catch (e) {
      logger.warn(`[Upwork] Refinement failed: ${(e as Error).message} — using original`);
    }
  } else {
    logger.info(`[Upwork] Quality gate PASSED (${qualityCheck.score}/100) for "${job.title.slice(0, 50)}"`);
  }

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
 * Auto-submit top queued proposals to meet daily minimum.
 * Called on a schedule (e.g. every 12h) to ensure at least N submissions per day.
 * Picks the highest-scoring queued jobs and submits them.
 */
export async function submitTopQueued(count = 1): Promise<{ submitted: number; failed: number }> {
  let submitted = 0;
  let failed = 0;

  // Check how many we already submitted today
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const allSubmitted = await cloud.getProposalsByFilter({ status: "submitted", limit: 50 });
  const todaySubmitted = allSubmitted.filter((r) => {
    const at = r.submitted_at || r.updated_at || r.created_at;
    return at && new Date(at as string) >= todayStart;
  });

  const remaining = count - todaySubmitted.length;
  if (remaining <= 0) {
    logger.info(`[Upwork] Auto-submit: already ${todaySubmitted.length} submitted today (target: ${count}/day) — skipping`);
    return { submitted: 0, failed: 0 };
  }

  logger.info(`[Upwork] Auto-submit: ${todaySubmitted.length} submitted today, need ${remaining} more`);

  // Get top queued jobs by score
  const queued = await cloud.getProposalsByFilter({ status: ["queued", "pending"], minScore: 5, limit: remaining + 2 });
  if (queued.length === 0) {
    logger.info("[Upwork] Auto-submit: no queued jobs to submit");
    await tg.notify("📭 Auto-submit: no queued jobs available. Need more scan results.");
    return { submitted: 0, failed: 0 };
  }

  // Sort by score descending, take top N
  const topJobs = queued
    .sort((a, b) => ((b.score as number) || 0) - ((a.score as number) || 0))
    .slice(0, remaining);

  for (const row of topJobs) {
    const connects = getConnectsRemaining();
    if (connects !== null && connects < 16) {
      logger.warn(`[Upwork] Auto-submit: only ${connects} connects — stopping`);
      await tg.notify(`⚠️ Auto-submit paused: ${connects} connects remaining`);
      break;
    }

    const job: UpworkJob = {
      id: row.job_id as string,
      title: (row.job_title as string) || "Untitled",
      description: (row.job_description as string) || (row.job_title as string) || "",
      url: row.job_url as string,
      budget: row.budget as string | undefined,
      score: row.score as number | undefined,
      bid: row.submitted_bid_amount as number | undefined,
      coverLetter: row.proposal_text as string | undefined,
      tags: row.tags as string[] | undefined,
    };

    logger.info(`[Upwork] Auto-submit: [${job.score}/10] "${job.title.slice(0, 50)}"`);
    await tg.notify(`🤖 *Auto-submitting* (daily quota)\n[${job.score}/10] ${job.title.slice(0, 50)}\n💰 ${job.budget || "N/A"}\n🔗 ${job.url}`);

    try {
      await cloud.updateProposalStatus(job.id, "auto_sending");
      const ok = await submitProposal(job);
      await cloud.updateProposalStatus(job.id, ok ? "submitted" : "error");
      if (ok) {
        submitted++;
        logger.info(`[Upwork] Auto-submit: SUCCESS — ${job.title.slice(0, 50)}`);
        await tg.notify(`🚀 Auto-submitted: ${job.title.slice(0, 50)}`);
      } else {
        failed++;
        logger.warn(`[Upwork] Auto-submit: FAILED — ${job.title.slice(0, 50)}`);
        await tg.notify(`❌ Auto-submit failed: ${job.title.slice(0, 50)}`);
      }
      // Pause between submissions to look human
      await new Promise((r) => setTimeout(r, 3000 + Math.random() * 5000));
    } catch (e) {
      failed++;
      logger.error(`[Upwork] Auto-submit error: ${(e as Error).message}`);
      await cloud.updateProposalStatus(job.id, "error").catch(() => {});
    }
  }

  const summary = `📊 Auto-submit complete: ${submitted} sent, ${failed} failed (${todaySubmitted.length + submitted} total today)`;
  logger.info(`[Upwork] ${summary}`);
  await tg.notify(summary);
  return { submitted, failed };
}

/**
 * Check Upwork notifications, classify them, forward important ones to Telegram,
 * and auto-record outcomes (hired, declined, etc.)
 */
export async function checkAndProcessNotifications(): Promise<{
  total: number;
  unread: number;
  actionable: number;
  notifications: UpworkNotification[];
}> {
  const notifications = await upworkBrowser.checkNotifications();
  if (notifications.length === 0) {
    return { total: 0, unread: 0, actionable: 0, notifications: [] };
  }

  const unread = notifications.filter((n) => n.isUnread);
  const actionable = notifications.filter((n) =>
    ["interview_invite", "offer", "hire", "message", "proposal_declined"].includes(n.type)
  );

  // Emoji map for notification types
  const emoji: Record<string, string> = {
    interview_invite: "📩",
    message: "💬",
    offer: "🎉",
    hire: "🏆",
    proposal_viewed: "👁",
    proposal_declined: "❌",
    milestone: "📋",
    payment: "💰",
    feedback: "⭐",
    job_alert: "📋",
    other: "🔔",
  };

  // Forward actionable notifications to Telegram
  if (actionable.length > 0) {
    const lines = actionable.map((n) => {
      const e = emoji[n.type] || "🔔";
      const client = n.clientName ? ` from ${n.clientName}` : "";
      const job = n.jobTitle ? `\n   Job: ${n.jobTitle}` : "";
      const link = n.url ? `\n   🔗 ${n.url}` : "";
      return `${e} *${n.type.replace(/_/g, " ").toUpperCase()}*${client}${job}\n   ${n.title.slice(0, 100)}${link}`;
    });
    await tg.notify(`🔔 *${actionable.length} Upwork notification${actionable.length > 1 ? "s" : ""}*\n\n${lines.join("\n\n")}`);
  }

  // Auto-apply to interview invites — score the job, and if high enough, generate + submit proposal
  const invites = notifications.filter((n) => n.type === "interview_invite" && n.url);
  if (invites.length > 0) {
    logger.info(`[Upwork] Processing ${invites.length} interview invite(s) for potential auto-apply`);
    for (const invite of invites) {
      if (!invite.url) continue;
      // Check if we already have this job in Supabase
      const jobIdMatch = invite.url.match(/~0?([a-f0-9]{10,})/);
      const jobId = jobIdMatch ? jobIdMatch[1] : "";
      if (jobId && await cloud.proposalExists(jobId)) {
        logger.info(`[Upwork] Invite job already processed: ${jobId}`);
        continue;
      }

      // Get job details from the invite URL
      try {
        const details = await upworkBrowser.getJobDetails(invite.url);
        if (!details) continue;

        // Score the job
        const result = await (await import("../Agent/scorer")).scoreJob({
          title: details.title,
          description: details.description,
          budget: details.budget,
          proposals: details.proposals,
          clientHireRate: details.clientInfo.hireRate,
        });

        logger.info(`[Upwork] Invite job scored: [${result.score}/10] "${details.title.slice(0, 50)}"`);

        // Invites are higher priority — lower the threshold by 1 (client chose us)
        const inviteThreshold = Math.max(4, (AUTO_SEND_MIN_SCORE || 7) - 2);

        if (result.score >= inviteThreshold && !result.excluded) {
          const built = await buildProposal({
            id: jobId, title: details.title, description: details.description,
            url: invite.url, budget: details.budget, score: result.score,
            tags: result.tags, reasoning: result.reasoning, bidRange: result.bidRange,
          });

          await cloud.saveProposal({
            jobId, title: details.title, url: invite.url,
            description: details.description, budget: details.budget,
            score: result.score, preScore: result.preScore,
            coverLetter: built.coverLetter, status: "auto_sending",
            reasoning: result.reasoning, tags: result.tags,
          });

          await tg.notify(`📩 *Auto-applying to invite* [${result.score}/10]\n${details.title.slice(0, 60)}\n💰 ${details.budget || "N/A"}\n🔗 ${invite.url}`);

          const ok = await submitProposal(built);
          await cloud.updateProposalStatus(jobId, ok ? "submitted" : "error");
          await tg.notify(ok
            ? `🚀 Invite proposal submitted: ${details.title.slice(0, 50)}`
            : `❌ Invite proposal failed: ${details.title.slice(0, 50)}`);
        } else {
          // Save but don't auto-send — queue for manual review
          await cloud.saveProposal({
            jobId, title: details.title, url: invite.url,
            description: details.description, budget: details.budget,
            score: result.score, status: result.excluded ? "excluded" : "queued",
            reasoning: result.reasoning || result.excluded, tags: result.tags,
          });
          if (!result.excluded) {
            await tg.notify(`📩 *Invite queued* [${result.score}/10] — below auto-apply threshold\n${details.title.slice(0, 60)}\n🔗 ${invite.url}`);
          }
        }
      } catch (e) {
        logger.error(`[Upwork] Invite auto-apply error: ${(e as Error).message}`);
      }
    }
  }

  // Process unread job alerts — score them and auto-apply to good fits
  const jobAlerts = notifications.filter((n) => n.type === "job_alert" && n.isUnread && n.url);
  if (jobAlerts.length > 0) {
    const maxToProcess = 5; // Limit to avoid long processing times
    const alertsToProcess = jobAlerts.slice(0, maxToProcess);
    logger.info(`[Upwork] Processing ${alertsToProcess.length}/${jobAlerts.length} unread job alerts`);

    for (const alert of alertsToProcess) {
      if (!alert.url) continue;
      const jobIdMatch = alert.url.match(/~0?([a-f0-9]{10,})/);
      const jobId = jobIdMatch ? jobIdMatch[1] : "";
      if (jobId && await cloud.proposalExists(jobId)) {
        logger.info(`[Upwork] Alert job already processed: ${jobId}`);
        continue;
      }

      try {
        const details = await upworkBrowser.getJobDetails(alert.url);
        if (!details) continue;

        const result = await scoreJob({
          title: details.title,
          description: details.description,
          budget: details.budget,
          proposals: details.proposals,
          clientHireRate: details.clientInfo.hireRate,
        });

        logger.info(`[Upwork] Alert job scored: [${result.score}/10] "${details.title.slice(0, 50)}" ${result.excluded ? "(EXCLUDED)" : ""}`);

        if (result.excluded) continue;

        if (result.score >= (AUTO_SEND_MIN_SCORE || 7)) {
          // High score — build proposal and auto-submit
          const built = await buildProposal({
            id: jobId, title: details.title, description: details.description,
            url: alert.url, budget: details.budget, score: result.score,
            tags: result.tags, reasoning: result.reasoning, bidRange: result.bidRange,
          });

          await cloud.saveProposal({
            jobId, title: details.title, url: alert.url,
            description: details.description, budget: details.budget,
            score: result.score, preScore: result.preScore,
            coverLetter: built.coverLetter, status: "auto_sending",
            reasoning: result.reasoning, tags: result.tags,
          });

          await tg.notify(`🔔 *Job alert auto-apply* [${result.score}/10]\n${details.title.slice(0, 60)}\n💰 ${details.budget || "N/A"}\n🔗 ${alert.url}`);

          const ok = await submitProposal(built);
          await cloud.updateProposalStatus(jobId, ok ? "submitted" : "error");
          await tg.notify(ok
            ? `🚀 Alert proposal submitted: ${details.title.slice(0, 50)}`
            : `❌ Alert proposal failed: ${details.title.slice(0, 50)}`);
        } else if (result.score >= 5) {
          // Medium score — save and queue for review
          await cloud.saveProposal({
            jobId, title: details.title, url: alert.url,
            description: details.description, budget: details.budget,
            score: result.score, status: "queued",
            reasoning: result.reasoning, tags: result.tags,
          });
          await tg.notify(`📋 *Job alert queued* [${result.score}/10]\n${details.title.slice(0, 60)}\n💰 ${details.budget || "N/A"}\n🔗 ${alert.url}`);
        }
        // Below 5 — silently skip
      } catch (e) {
        logger.error(`[Upwork] Job alert processing error: ${(e as Error).message}`);
      }
    }
  }

  // Auto-record outcomes from notifications
  for (const n of notifications) {
    if (n.type === "hire" && n.jobTitle) {
      // Try to find the proposal in Supabase and mark as won
      const proposals = await cloud.getProposalsByFilter({ status: ["submitted", "interviewed"], limit: 50 });
      const match = proposals.find((p) =>
        n.jobTitle && (p.job_title as string || "").toLowerCase().includes(n.jobTitle.toLowerCase().slice(0, 30))
      );
      if (match) {
        await cloud.recordOutcome(match.job_id as string, "won");
        logger.info(`[Upwork] Auto-recorded WIN: ${match.job_title}`);
        await tg.notify(`🏆 *AUTO-RECORDED WIN*: ${(match.job_title as string).slice(0, 60)}`);
      }
    } else if (n.type === "proposal_declined" && n.jobTitle) {
      const proposals = await cloud.getProposalsByFilter({ status: ["submitted", "interviewed"], limit: 50 });
      const match = proposals.find((p) =>
        n.jobTitle && (p.job_title as string || "").toLowerCase().includes(n.jobTitle.toLowerCase().slice(0, 30))
      );
      if (match) {
        await cloud.recordOutcome(match.job_id as string, "rejected");
        logger.info(`[Upwork] Auto-recorded REJECTED: ${match.job_title}`);
      }
    } else if (n.type === "interview_invite" && n.jobTitle) {
      const proposals = await cloud.getProposalsByFilter({ status: "submitted", limit: 50 });
      const match = proposals.find((p) =>
        n.jobTitle && (p.job_title as string || "").toLowerCase().includes(n.jobTitle.toLowerCase().slice(0, 30))
      );
      if (match) {
        await cloud.recordOutcome(match.job_id as string, "interviewed");
        logger.info(`[Upwork] Auto-recorded INTERVIEWED: ${match.job_title}`);
      }
    }
  }

  return { total: notifications.length, unread: unread.length, actionable: actionable.length, notifications };
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

// ── Archived Proposals & Lessons Learned ──────────────────────────────────

/**
 * Scrape archived proposals from Upwork and sync outcomes to Supabase.
 * Updates existing proposals with their final outcome (hired, declined, etc.)
 * and creates new records for proposals not yet tracked.
 */
export async function syncArchivedProposals(): Promise<{
  total: number;
  synced: number;
  hired: ArchivedProposal[];
  lost: ArchivedProposal[];
}> {
  const archived = await upworkBrowser.scrapeArchivedProposals();
  if (archived.length === 0) {
    return { total: 0, synced: 0, hired: [], lost: [] };
  }

  const hired: ArchivedProposal[] = [];
  const lost: ArchivedProposal[] = [];
  let synced = 0;

  // Fetch all tracked proposals once (not per-loop) for title matching
  const allTracked = await cloud.getProposalsByFilter({ limit: 500 });

  for (const p of archived) {
    if (p.status === "hired") hired.push(p);
    else lost.push(p);

    if (!p.jobId) continue;
    // Skip withdrawn proposals — freelancer cancelled, not a client outcome
    if (p.status === "withdrawn") continue;

    // Match by title (archived page exposes proposal IDs, not job IDs)
    const titleLower = p.jobTitle.toLowerCase();
    const existing = allTracked.find(
      (r) => {
        const dbTitle = (r.job_title as string || "").toLowerCase();
        return dbTitle.includes(titleLower.slice(0, 40))
          || titleLower.includes(dbTitle.slice(0, 40));
      }
    );

    const outcome = p.status === "hired" ? "won"
      : p.status === "declined" ? "rejected"
      : "no_response";

    if (existing) {
      const currentStatus = existing.status as string;
      if (!["won", "rejected", "no_response"].includes(currentStatus)) {
        await cloud.recordOutcome(existing.job_id as string, outcome as "won" | "rejected" | "no_response");
        synced++;
        logger.info(`[Upwork] Synced outcome: ${p.jobTitle.slice(0, 40)} → ${outcome}`);
      }
    } else {
      // Save new record from archived data (jobs we didn't track)
      await cloud.saveProposal({
        jobId: p.jobId,
        title: p.jobTitle,
        url: p.jobUrl,
        description: "",
        budget: p.budget || "",
        score: 0,
        status: outcome,
        tags: [],
      });
      synced++;
    }
  }

  logger.info(`[Upwork] Archived sync complete: ${archived.length} total, ${synced} synced, ${hired.length} hired, ${lost.length} lost`);
  return { total: archived.length, synced, hired, lost };
}

/**
 * Analyze lessons learned from won vs lost proposals.
 * Compares patterns between hired and rejected/lost proposals to identify
 * what works and what doesn't.
 */
export async function analyzeLessonsLearned(): Promise<{
  totalAnalyzed: number;
  won: number;
  lost: number;
  lessons: {
    winPatterns: string[];
    lossPatterns: string[];
    recommendations: string[];
    nichePerformance: Array<{ niche: string; won: number; lost: number; winRate: number }>;
    bidAnalysis: { avgWinBid: number | null; avgLossBid: number | null; insight: string };
    clientProfile: { avgHireRateWon: number | null; avgHireRateLost: number | null };
  };
  aiSummary?: string;
}> {
  // Get all proposals with outcomes
  const won = await cloud.getProposalsByFilter({ status: "won", limit: 100 });
  const rejected = await cloud.getProposalsByFilter({ status: "rejected", limit: 100 });
  const noResponse = await cloud.getProposalsByFilter({ status: "no_response", limit: 100 });
  const lost = [...rejected, ...noResponse];

  if (won.length === 0 && lost.length === 0) {
    return {
      totalAnalyzed: 0, won: 0, lost: 0,
      lessons: {
        winPatterns: [], lossPatterns: [], recommendations: [],
        nichePerformance: [],
        bidAnalysis: { avgWinBid: null, avgLossBid: null, insight: "No data yet" },
        clientProfile: { avgHireRateWon: null, avgHireRateLost: null },
      },
    };
  }

  // Analyze bid amounts
  const winBids = won.map(p => p.submitted_bid_amount as number).filter(Boolean);
  const lossBids = lost.map(p => p.submitted_bid_amount as number).filter(Boolean);
  const avgWinBid = winBids.length > 0 ? Math.round(winBids.reduce((a, b) => a + b, 0) / winBids.length) : null;
  const avgLossBid = lossBids.length > 0 ? Math.round(lossBids.reduce((a, b) => a + b, 0) / lossBids.length) : null;

  let bidInsight = "Not enough data";
  if (avgWinBid && avgLossBid) {
    if (avgWinBid < avgLossBid) bidInsight = `Won bids avg $${avgWinBid} vs lost $${avgLossBid} — lower bids win more`;
    else if (avgWinBid > avgLossBid) bidInsight = `Won bids avg $${avgWinBid} vs lost $${avgLossBid} — higher bids win (quality signal)`;
    else bidInsight = `Won and lost bids similar (~$${avgWinBid}) — bid amount not a differentiator`;
  }

  // Client hire rate analysis
  const winHireRates = won.map(p => p.client_hire_rate as number).filter(Boolean);
  const lossHireRates = lost.map(p => p.client_hire_rate as number).filter(Boolean);
  const avgHireRateWon = winHireRates.length > 0 ? Math.round(winHireRates.reduce((a, b) => a + b, 0) / winHireRates.length) : null;
  const avgHireRateLost = lossHireRates.length > 0 ? Math.round(lossHireRates.reduce((a, b) => a + b, 0) / lossHireRates.length) : null;

  // Niche performance from tags
  const nicheMap = new Map<string, { won: number; lost: number }>();
  for (const p of won) {
    const tags = (p.tags as string[]) || [];
    for (const tag of tags) {
      const entry = nicheMap.get(tag) || { won: 0, lost: 0 };
      entry.won++;
      nicheMap.set(tag, entry);
    }
  }
  for (const p of lost) {
    const tags = (p.tags as string[]) || [];
    for (const tag of tags) {
      const entry = nicheMap.get(tag) || { won: 0, lost: 0 };
      entry.lost++;
      nicheMap.set(tag, entry);
    }
  }
  const nichePerformance = Array.from(nicheMap.entries())
    .map(([niche, data]) => ({
      niche,
      won: data.won,
      lost: data.lost,
      winRate: Math.round((data.won / (data.won + data.lost)) * 100),
    }))
    .filter(n => n.won + n.lost >= 2)
    .sort((a, b) => b.winRate - a.winRate);

  // Score analysis
  const avgWonScore = won.length > 0 ? Math.round((won.reduce((a, p) => a + (p.score as number || 0), 0) / won.length) * 10) / 10 : 0;
  const avgLostScore = lost.length > 0 ? Math.round((lost.reduce((a, p) => a + (p.score as number || 0), 0) / lost.length) * 10) / 10 : 0;

  // Deterministic pattern extraction
  const winPatterns: string[] = [];
  const lossPatterns: string[] = [];

  if (avgWonScore > avgLostScore + 1) winPatterns.push(`Higher-scored jobs win more (avg ${avgWonScore} vs ${avgLostScore})`);
  if (avgHireRateWon && avgHireRateLost && avgHireRateWon > avgHireRateLost)
    winPatterns.push(`Clients with higher hire rates (${avgHireRateWon}%) more likely to hire us`);
  if (nichePerformance.length > 0 && nichePerformance[0].winRate > 50)
    winPatterns.push(`Best niche: "${nichePerformance[0].niche}" (${nichePerformance[0].winRate}% win rate)`);

  if (noResponse.length > rejected.length)
    lossPatterns.push(`${noResponse.length} no-response vs ${rejected.length} explicit rejections — many clients ghost`);
  if (nichePerformance.length > 0) {
    const worstNiche = nichePerformance[nichePerformance.length - 1];
    if (worstNiche.winRate < 20 && worstNiche.won + worstNiche.lost >= 3)
      lossPatterns.push(`Weakest niche: "${worstNiche.niche}" (${worstNiche.winRate}% win rate)`);
  }

  // Build AI summary from won cover letters vs lost ones
  let aiSummary: string | undefined;
  try {
    const { ANTHROPIC_API_KEY } = await import("../secret");
    if (ANTHROPIC_API_KEY && won.length >= 1) {
      const Anthropic = (await import("@anthropic-ai/sdk")).default;
      const ai = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

      const wonSamples = won.slice(0, 5).map(p =>
        `TITLE: ${p.job_title}\nBID: $${p.submitted_bid_amount || "?"}\nSCORE: ${p.score}/10\nCOVER LETTER:\n${(p.proposal_text as string || "N/A").slice(0, 500)}`
      ).join("\n---\n");

      const lostSamples = lost.slice(0, 5).map(p =>
        `TITLE: ${p.job_title}\nBID: $${p.submitted_bid_amount || "?"}\nSCORE: ${p.score}/10\nCOVER LETTER:\n${(p.proposal_text as string || "N/A").slice(0, 500)}`
      ).join("\n---\n");

      const resp = await ai.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 800,
        messages: [{
          role: "user",
          content: `Analyze these Upwork proposals. I won ${won.length} and lost ${lost.length}.

WON PROPOSALS:
${wonSamples}

LOST PROPOSALS:
${lostSamples}

Give me 3-5 specific, actionable lessons learned. Focus on:
1. What patterns appear in winning cover letters (tone, length, specificity)?
2. What types of jobs/budgets convert better?
3. What should I change about my approach?

Be direct and specific. No generic advice.`,
        }],
      });

      const content = resp.content[0];
      if (content && content.type === "text") {
        aiSummary = content.text;
      }
    }
  } catch (e) {
    logger.warn(`[Upwork] AI lessons analysis failed: ${(e as Error).message}`);
  }

  const recommendations: string[] = [];
  if (nichePerformance.length > 0) recommendations.push(`Focus on "${nichePerformance[0].niche}" — ${nichePerformance[0].winRate}% win rate`);
  if (avgWinBid) recommendations.push(`Target bids around $${avgWinBid} (your winning average)`);
  if (avgHireRateWon && avgHireRateWon > 50) recommendations.push(`Prioritize clients with ${avgHireRateWon}%+ hire rate`);
  if (won.length > 0) recommendations.push(`Your scoring accuracy: won avg ${avgWonScore}/10, lost avg ${avgLostScore}/10`);

  return {
    totalAnalyzed: won.length + lost.length,
    won: won.length,
    lost: lost.length,
    lessons: {
      winPatterns,
      lossPatterns,
      recommendations,
      nichePerformance,
      bidAnalysis: { avgWinBid, avgLossBid, insight: bidInsight },
      clientProfile: { avgHireRateWon, avgHireRateLost },
    },
    aiSummary,
  };
}
