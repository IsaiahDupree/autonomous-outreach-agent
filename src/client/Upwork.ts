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
import { generateProposalContent, getLastVariantPicked, getPortfolioLineTracked, qualityCheckCoverLetter, qualityCheckSlots, refineCoverLetter, type ProposalSlots } from "../Agent";
import { researchJob, formatResearchBrief } from "../services/research";
import { scoreJob } from "../Agent/scorer";
import * as upworkBrowser from "../browser/upwork";
import type { SearchFilters, UpworkNotification, ArchivedProposal } from "../browser/upwork";
import { AUTO_SEND, AUTO_SEND_MIN_SCORE, AUTO_SEND_MIN_CONNECTS } from "../secret";
import { getConnectsRemaining } from "../browser/upwork";

const SAFARI_BASE = `http://localhost:${SAFARI_UPWORK_PORT}`;

// Submission lock — prevents parallel submissions from overspending connects
let _submissionLock = false;
async function withSubmissionLock<T>(fn: () => Promise<T>): Promise<T> {
  while (_submissionLock) {
    await new Promise(r => setTimeout(r, 500));
  }
  _submissionLock = true;
  try {
    return await fn();
  } finally {
    _submissionLock = false;
  }
}

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
  // Structured proposal beats — populated by buildProposal()
  proposalSlots?: ProposalSlots;
  // A/B variant picked at gen time (read from getLastVariantPicked after buildProposal).
  variantNiche?: string | null;
  variantName?: string | null;
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

  // Check for proof-of-work artifact (generated by daily strategy for top jobs)
  let proofArtifact: { url?: string; brief: { analysis: string } } | undefined;
  try {
    const proof = await cloud.getProofArtifact(job.id);
    if (proof) {
      proofArtifact = proof;
      logger.info(`[Upwork] Found proof artifact for "${job.title.slice(0, 40)}"${proof.url ? ` — ${proof.url}` : ""}`);
    }
  } catch { /* proceed without */ }

  let { text: coverLetter, slots: proposalSlots } = await generateProposalContent({
    title: job.title,
    description: job.description,
    budget: job.budget,
    researchBrief,
    proofArtifact,
    tags: job.tags,
    jobId: job.id,
  });
  // Capture which A/B variant (if any) the prompt picked. Read immediately so a parallel
  // generation can't overwrite the module-level state before we stash it on the job.
  const pickedVariant = getLastVariantPicked();
  job.variantNiche = pickedVariant?.niche ?? null;
  job.variantName = pickedVariant?.variant.name ?? null;

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

  // Per-beat slot coverage — surfaced for the dashboard, not blocking yet.
  const slotCheck = qualityCheckSlots(proposalSlots || {});
  const beats = (slotCheck.slotCoverage || []).map(s => `${s.name}=${s.present ? "✓" : "✗"}`).join(" ");
  logger.info(`[Upwork] Slot coverage (${slotCheck.score}/100): ${beats}`);

  return { ...job, coverLetter, proposalSlots };
}

// Connects budget thresholds
const MIN_CONNECTS_RESERVE = 50;   // warn below this
// Hard-stop floor — env-driven via AUTO_SEND_MIN_CONNECTS (default 16). All submission paths
// (interactive, auto-send, daily plan, fast-poll, controller tools) gate on this single value
// so a low-connects pause is consistent and the reason surfaces to logs + Telegram + dashboard.
const MIN_CONNECTS_CRITICAL = AUTO_SEND_MIN_CONNECTS;

// Hard ceiling on a single submission attempt. Successful submissions complete in 15-30s; the
// fast-poll cycle is 60s. If a submit takes longer than 90s it's hung — usually Cloudflare
// deadlock, a Puppeteer tab that never resolved, or AI rate-limit retries. We log + return
// false so the lock releases and the queue moves on instead of cascading the backlog.
const SUBMIT_TIMEOUT_MS = 90 * 1000;

// Per-job recent-failure cooldown. After a submission fails (timeout, validation, expired,
// already_applied, etc.) we record the jobId and refuse to retry it for COOLDOWN_MS. Without
// this, the controller's submit_proposal_for_job tool keeps re-picking the same dead job from
// the queue and burning the submission lock on it every cycle. Persists in-memory only — a
// daemon restart clears it, which is fine: a few minutes of grace is enough for transient
// failures, and after restart we'd want to retry once anyway.
const RECENT_FAILURE_COOLDOWN_MS = 30 * 60 * 1000;   // 30 min
const _recentFailures = new Map<string, { reason: string; at: number }>();

export function markJobFailed(jobId: string, reason: string): void {
  if (!jobId) return;
  _recentFailures.set(jobId, { reason, at: Date.now() });
  // Cap map size — drop oldest entries when we exceed a sensible ceiling.
  if (_recentFailures.size > 500) {
    const oldest = Array.from(_recentFailures.entries()).sort((a, b) => a[1].at - b[1].at).slice(0, 50);
    for (const [k] of oldest) _recentFailures.delete(k);
  }
}

export function isJobInCooldown(jobId: string): { inCooldown: boolean; reason?: string; ageSec?: number } {
  const entry = _recentFailures.get(jobId);
  if (!entry) return { inCooldown: false };
  const age = Date.now() - entry.at;
  if (age > RECENT_FAILURE_COOLDOWN_MS) {
    _recentFailures.delete(jobId);
    return { inCooldown: false };
  }
  return { inCooldown: true, reason: entry.reason, ageSec: Math.round(age / 1000) };
}

/** Snapshot of all currently-cooled-down jobs for the dashboard / diagnostics. */
export function getCooldownSnapshot(): { count: number; window_minutes: number; jobs: Array<{ jobId: string; reason: string; age_sec: number }> } {
  const now = Date.now();
  const jobs: Array<{ jobId: string; reason: string; age_sec: number }> = [];
  for (const [jobId, entry] of _recentFailures.entries()) {
    const age = now - entry.at;
    if (age > RECENT_FAILURE_COOLDOWN_MS) { _recentFailures.delete(jobId); continue; }
    jobs.push({ jobId, reason: entry.reason, age_sec: Math.round(age / 1000) });
  }
  jobs.sort((a, b) => a.age_sec - b.age_sec);
  return { count: jobs.length, window_minutes: RECENT_FAILURE_COOLDOWN_MS / 60000, jobs };
}

export async function submitProposal(job: UpworkJob, opts?: { dryRun?: boolean }): Promise<boolean> {
  // Cooldown gate — skip jobs that just failed, regardless of caller. Dry runs bypass the
  // gate so the manual smoke test can still exercise a known-flaky job.
  if (!opts?.dryRun && job.id) {
    const cd = isJobInCooldown(job.id);
    if (cd.inCooldown) {
      logger.warn(`[Upwork] Skipping ${job.id.slice(0, 10)} — in failure cooldown (${cd.reason}, ${cd.ageSec}s ago, ${Math.round(RECENT_FAILURE_COOLDOWN_MS / 60000)}-min window)`);
      return false;
    }
  }
  // Wrap in submission lock to prevent parallel submissions from overspending connects
  const ok = await withSubmissionLock(async () => {
    return Promise.race([
      _submitProposalInner(job, opts),
      new Promise<boolean>((resolve) => {
        setTimeout(() => {
          logger.error(`[Upwork] submitProposal HARD TIMEOUT (${SUBMIT_TIMEOUT_MS / 1000}s) for "${job.title?.slice(0, 60)}" — aborting + freeing lock`);
          // Mark as timeout-failed so we don't immediately retry it.
          if (job.id) markJobFailed(job.id, "hard_timeout");
          resolve(false);
        }, SUBMIT_TIMEOUT_MS);
      }),
    ]);
  });
  // Failure capture: read the typed reason from the browser layer so cooldown reflects WHY.
  if (!ok && !opts?.dryRun && job.id) {
    try {
      const { getLastSubmitFailure } = await import("../browser/upwork");
      const failure = getLastSubmitFailure();
      // Don't double-mark for hard_timeout (already set above) — but otherwise tag with the
      // typed reason so cooldown messages are useful in the log.
      if (failure.reason && !_recentFailures.has(job.id)) {
        markJobFailed(job.id, failure.reason);
      }
    } catch { /* ignore */ }
  }
  return ok;
}

async function _submitProposalInner(job: UpworkJob, opts?: { dryRun?: boolean }): Promise<boolean> {
  // Reset per-submission state so processJobs reads fresh signals after this attempt.
  const browserMod = await import("../browser/upwork");
  browserMod.resetLastSubmitConnectsCost();
  browserMod.resetSubmitFailure();
  browserMod.resetLastProposalsAtSubmit();
  try {
    // Connects budget check (skip for dry runs)
    if (!opts?.dryRun) {
      const connects = getConnectsRemaining();
      if (connects !== null && connects < MIN_CONNECTS_CRITICAL) {
        logger.warn(`[Upwork] Skipping submission — connects critically low (${connects})`);
        browserMod.setSubmitFailure("low_connects", `Connects=${connects}, min=${MIN_CONNECTS_CRITICAL}`);
        await tg.notify(`⚠️ *Connects critically low: ${connects}*\nSkipping proposal for "${job.title.slice(0, 50)}"\nBuy more connects to resume submissions.`);
        return false;
      }
      if (connects !== null && connects < MIN_CONNECTS_RESERVE) {
        logger.warn(`[Upwork] Low connects warning: ${connects} remaining`);
        await tg.notify(`⚠️ *Low connects: ${connects} remaining*\nSubmitting but running low. Consider buying more.`);
      }
    }

    // Bid amount sanity check — prevent absurd bids from being submitted
    if (job.bid && !opts?.dryRun) {
      const MAX_BID = 50000; // $50K cap — anything higher is likely a bug
      const MIN_BID = 5;     // $5 minimum
      if (job.bid > MAX_BID) {
        logger.error(`[Upwork] Bid $${job.bid} exceeds max ($${MAX_BID}) for "${job.title.slice(0, 50)}" — aborting`);
        await tg.notify(`🚨 *Bid too high: $${job.bid}*\nJob: ${job.title.slice(0, 50)}\nMax allowed: $${MAX_BID}. Submission blocked.`);
        return false;
      }
      if (job.bid < MIN_BID) {
        logger.warn(`[Upwork] Bid $${job.bid} below minimum ($${MIN_BID}) for "${job.title.slice(0, 50)}" — aborting`);
        return false;
      }
    }

    // Regenerate cover letter if empty (e.g. queued jobs from before the fix). Check the
    // prewarm cache first — if fast-poll or processJobs kicked off generation earlier, we can
    // unwrap the result instantly instead of paying another 4-10s of Claude latency.
    if (!job.coverLetter || job.coverLetter.trim().length === 0) {
      const { getPrewarmedProposal } = await import("../services/prewarm");
      const prewarmed = await getPrewarmedProposal(job.id);
      const rebuilt = prewarmed || await (async () => {
        logger.info(`[Upwork] Cover letter empty for "${(job.title || "").slice(0, 50)}" — regenerating...`);
        return buildProposal(job);
      })();
      job.coverLetter = rebuilt.coverLetter;
      job.variantNiche = rebuilt.variantNiche ?? job.variantNiche;
      job.variantName = rebuilt.variantName ?? job.variantName;
      if (job.coverLetter && job.coverLetter.trim().length > 0) {
        // Save regenerated cover letter back to Supabase
        await cloud.saveProposal({
          jobId: job.id, title: job.title, url: job.url,
          description: job.description, budget: job.budget,
          score: job.score || 0, bid: job.bid || 0,
          coverLetter: job.coverLetter,
          variantNiche: job.variantNiche,
          variantName: job.variantName,
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
    const result = await upworkBrowser.submitProposal(job.url, job.coverLetter || "", {
      dryRun: opts?.dryRun,
      milestones: job.bid ? [{ description: "Full project delivery", amount: job.bid }] : undefined,
      clientBudget: job.budget,
      jobTitle: job.title,
      jobDescription: job.description,
    });

    // Track bid amount after successful submission
    if (result && !opts?.dryRun && job.bid) {
      await cloud.updateProposalBid(job.id, job.bid);
      logger.info(`[Upwork] Tracked bid amount: $${job.bid} for ${job.id}`);
    }

    return result;
  } catch (e) {
    logger.error(`[Upwork] submitProposal error: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Shared scoring + dedup + approval flow for any job list.
 * Used by both keyword search and Best Matches.
 */
export async function processJobs(
  jobs: UpworkJob[],
  scoreThreshold: number,
  label: string,
): Promise<void> {
  const cycleStart = Date.now();
  if (jobs.length === 0) {
    logger.info(`[Upwork] ${label}: No jobs found`);
    return;
  }

  // Dedup: skip jobs already in Supabase (single batch query instead of N+1)
  const existingIds = await cloud.proposalExistsBatch(jobs.map(j => j.id));
  const newJobs = jobs.filter(j => !existingIds.has(j.id));
  const dupeCount = jobs.length - newJobs.length;
  if (dupeCount > 0) {
    logger.info(`[Upwork] ${label}: Skipped ${dupeCount} duplicates`);
  }

  // Score each new job (circuit breaker: stop after 3 consecutive failures)
  const scoredJobs: UpworkJob[] = [];
  let preFiltered = 0;
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 3;
  for (const job of newJobs) {
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      logger.error(`[Upwork] Circuit breaker: ${MAX_CONSECUTIVE_FAILURES} consecutive scoring failures — pausing remaining ${newJobs.length - scoredJobs.length - preFiltered} jobs`);
      await tg.notify(`🔌 *Circuit breaker tripped*\n${MAX_CONSECUTIVE_FAILURES} consecutive scoring failures in ${label}.\nRemaining jobs skipped. Check logs.`);
      break;
    }
    logger.info(`[Upwork] Scoring: "${job.title.slice(0, 60)}..."`);
    let result;
    try {
      result = await scoreJob({
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
        job.proposalSlots = built.proposalSlots;
        logger.info(`[Upwork] Pre-generated cover letter: ${(job.coverLetter || "").length} chars`);
      } catch (e) {
        logger.warn(`[Upwork] Cover letter pre-gen failed: ${(e as Error).message}`);
      }
    }

    // Snapshot the absolute posted timestamp from the relative string Upwork showed at scrape
    // time. We do this here (not at scan time) because some scan paths skip the parse step.
    const { parseRelativePosted } = await import("../services/posted-at");
    const postedAt = parseRelativePosted(job.posted)?.toISOString() ?? null;

    await cloud.saveProposal({
      jobId: job.id, title: job.title, url: job.url,
      description: job.description, budget: job.budget,
      score: result.score, preScore: result.preScore,
      status,
      reasoning: result.reasoning,
      aiScore: result.aiScore,
      aiReasoning: result.aiReasoning,
      tags: result.tags,
      coverLetter: job.coverLetter,
      slots: job.proposalSlots,
      postedAt,
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
      variantNiche: job.variantNiche,
      variantName: job.variantName,
    }).catch((e) => logger.warn(`[Upwork] Failed to save: ${(e as Error).message}`));

    if (result.score >= scoreThreshold) {
      scoredJobs.push(job);
    }
    consecutiveFailures = 0; // reset on success
    } catch (e) {
      consecutiveFailures++;
      logger.error(`[Upwork] Scoring/processing error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${(e as Error).message}`);
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
    if (connects !== null && connects < MIN_CONNECTS_CRITICAL) {
      logger.warn(`[Upwork] Hard-stop: ${connects} connects < AUTO_SEND_MIN_CONNECTS (${MIN_CONNECTS_CRITICAL}) — pausing auto-submissions`);
      await tg.notify(`⚠️ Hard-stop: ${connects} connects < min ${MIN_CONNECTS_CRITICAL}. Pausing auto-submissions.`);
      break;
    }

    const proposal = await buildProposal(job);

    // Add portfolio line in auto-send mode (only if not already present)
    const autoSendEligible = AUTO_SEND && (proposal.score || 0) >= AUTO_SEND_MIN_SCORE;
    if (autoSendEligible) {
      const portfolioLine = await getPortfolioLineTracked(proposal.tags, proposal.id);
      if (portfolioLine && !(proposal.coverLetter || "").includes(portfolioLine)) {
        proposal.coverLetter = `${portfolioLine}\n\n${proposal.coverLetter || ""}`;
      }
    }

    await cloud.saveProposal({
      jobId: proposal.id, title: proposal.title, url: proposal.url,
      description: proposal.description, budget: proposal.budget,
      score: proposal.score || 0, bid: proposal.bid || 0,
      coverLetter: proposal.coverLetter || "", status: autoSendEligible ? "auto_sending" : "pending",
      slots: proposal.proposalSlots,
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
      if (connectsNow !== null && connectsNow < MIN_CONNECTS_CRITICAL) {
        logger.warn(`[Upwork] AUTO-SEND skipped: ${connectsNow} connects < AUTO_SEND_MIN_CONNECTS (${MIN_CONNECTS_CRITICAL})`);
        await tg.notify(`⚠️ Auto-send skipped for "${proposal.title.slice(0, 40)}" — ${connectsNow} connects < min ${MIN_CONNECTS_CRITICAL}`);
        await cloud.updateProposalStatus(proposal.id, "queued");
        continue;
      }
      logger.info(`[Upwork] AUTO-SEND: score ${proposal.score}/10 >= ${AUTO_SEND_MIN_SCORE} — submitting "${proposal.title.slice(0, 50)}"`);
      await tg.notify(`🤖 *Auto-sending proposal* (score ${proposal.score}/10)\n\n${preview}`);

      const submitStart = Date.now();
      const ok = await submitProposal(proposal);
      const submitSec = ((Date.now() - submitStart) / 1000).toFixed(0);

      // Pull connect cost + typed failure reason + proposals-at-submit from the browser layer.
      const { getLastSubmitConnectsCost, getLastSubmitFailure, getLastProposalsAtSubmit } = await import("../browser/upwork");
      const connectsCost = getLastSubmitConnectsCost();
      const connectsRemaining = getConnectsRemaining();
      const failure = getLastSubmitFailure();
      const proposalsAtSubmit = getLastProposalsAtSubmit();

      // Map the typed reason to a specific status so the queue / dashboard / reinforcement loop
      // can distinguish stale-job churn from real bugs. Generic "error" was hiding all of it.
      const FAILURE_TO_STATUS: Record<string, string> = {
        job_not_found: "expired",
        apply_disabled: "already_applied",
        cloudflare: "cloudflare_blocked",
        validation_error: "validation_error",
        no_cover_letter: "error_no_cover_letter",
        low_connects: "error_low_connects",
        bid_out_of_range: "error_bid",
        puppeteer_error: "error_puppeteer",
        unknown: "error",
      };
      const status = ok
        ? "submitted"
        : (failure.reason ? (FAILURE_TO_STATUS[failure.reason] || "error") : "error");

      const extra: Record<string, unknown> = {};
      if (connectsCost != null) extra.submitted_connects_cost = connectsCost;
      if (proposalsAtSubmit != null) extra.proposals_when_submitted = proposalsAtSubmit;
      if (!ok && failure.detail) extra.reasoning = failure.detail;

      await cloud.updateProposalStatus(proposal.id, status, extra);
      obsidian.logProposal({ title: proposal.title, score: proposal.score || 0, bid: proposal.bid || 0 }, status);
      const posted = proposal.posted || "";
      const speedInfo = posted ? ` | Posted: ${posted}` : "";
      const costInfo = connectsCost != null ? ` | Spent ${connectsCost}c, ${connectsRemaining ?? "?"} left` : "";
      const reasonInfo = !ok && failure.reason ? ` (${failure.reason})` : "";
      await tg.notify(ok
        ? `🚀 Auto-submitted in ${submitSec}s: ${proposal.title}${speedInfo}${costInfo}`
        : `❌ Auto-submit failed [${status}] (${submitSec}s)${reasonInfo}: ${proposal.title}`);
    } else {
      // ── MANUAL APPROVAL: send to Telegram and wait ──
      await tg.sendForApproval({
        id: proposal.id, type: "proposal",
        title: `Upwork: ${proposal.title}`,
        preview,
        jobUrl: proposal.url,
      });

      // While the human is reviewing, kick off prewarm so the cover letter is already cached
      // by the time they hit Approve — submit happens instantly instead of paying a regen.
      try {
        const { prewarmProposal } = await import("../services/prewarm");
        prewarmProposal(proposal);
      } catch { /* prewarm is best-effort */ }

      const { action } = await tg.waitForApproval(proposal.id, "upwork");

      if (action === "send" || action === "send_with_portfolio") {
        if (action === "send_with_portfolio") {
          const portfolioLine = await getPortfolioLineTracked(proposal.tags, proposal.id);
          if (portfolioLine && !(proposal.coverLetter || "").includes(portfolioLine)) {
            proposal.coverLetter = `${portfolioLine}\n\n${proposal.coverLetter || ""}`;
            await cloud.saveProposal({
              jobId: proposal.id, title: proposal.title, url: proposal.url,
              description: proposal.description, budget: proposal.budget,
              score: proposal.score || 0, bid: proposal.bid || 0,
              coverLetter: proposal.coverLetter, status: "pending",
              slots: proposal.proposalSlots,
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

  const cycleSec = ((Date.now() - cycleStart) / 1000).toFixed(0);
  logger.info(`[Upwork] ${label} pipeline done in ${cycleSec}s — ${scoredJobs.length} qualified, ${newJobs.length} new`);
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
    if (connects !== null && connects < MIN_CONNECTS_CRITICAL) {
      logger.warn(`[Upwork] Auto-submit: ${connects} connects < AUTO_SEND_MIN_CONNECTS (${MIN_CONNECTS_CRITICAL}) — stopping`);
      await tg.notify(`⚠️ Auto-submit paused: ${connects} connects < min ${MIN_CONNECTS_CRITICAL}`);
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
 * Submit a specific proposal by job ID. Used by the daily strategy to submit
 * individually-selected jobs from the daily plan.
 */
export async function submitProposalById(jobId: string): Promise<boolean> {
  const rows = await cloud.getProposalsByFilter({ jobId, limit: 1 });
  if (rows.length === 0) {
    logger.warn(`[Upwork] submitById: job ${jobId} not found`);
    return false;
  }

  const row = rows[0];
  const job: UpworkJob = {
    id: row.job_id as string,
    title: (row.job_title as string) || "Untitled",
    description: (row.job_description as string) || "",
    url: row.job_url as string,
    budget: row.budget as string | undefined,
    score: row.score as number | undefined,
    bid: row.submitted_bid_amount as number | undefined,
    coverLetter: row.proposal_text as string | undefined,
    tags: row.tags as string[] | undefined,
  };

  // Check connects
  const connects = getConnectsRemaining();
  if (connects !== null && connects < MIN_CONNECTS_CRITICAL) {
    logger.warn(`[Upwork] submitById: connects critically low (${connects})`);
    await tg.notify(`⚠️ *Connects critically low: ${connects}*\nSkipping "${job.title.slice(0, 50)}"`);
    return false;
  }

  logger.info(`[Upwork] submitById: [${job.score}/10] "${job.title.slice(0, 50)}"`);
  await tg.notify(`🤖 *Submitting* (daily plan)\n[${job.score}/10] ${job.title.slice(0, 50)}\n💰 ${job.budget || "N/A"}\n🔗 ${job.url}`);

  try {
    await cloud.updateProposalStatus(job.id, "auto_sending");
    const ok = await submitProposal(job);
    await cloud.updateProposalStatus(job.id, ok ? "submitted" : "error");
    if (ok) {
      logger.info(`[Upwork] submitById: SUCCESS — ${job.title.slice(0, 50)}`);
      await tg.notify(`🚀 Submitted (daily plan): ${job.title.slice(0, 50)}`);
    } else {
      logger.warn(`[Upwork] submitById: FAILED — ${job.title.slice(0, 50)}`);
      await tg.notify(`❌ Submit failed (daily plan): ${job.title.slice(0, 50)}`);
    }
    return ok;
  } catch (e) {
    logger.error(`[Upwork] submitById error: ${(e as Error).message}`);
    await cloud.updateProposalStatus(job.id, "error").catch(() => {});
    return false;
  }
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

  // ── Outcome auto-capture ────────────────────────────────────────────────
  // Every notification that references a job we've submitted on becomes a status update.
  // Maps the typed notification → outcome so the dashboard / reinforcement loop see real
  // signals instead of every submitted proposal sitting in "submitted" forever.
  // We match by job_id parsed from the notification URL — only proposals already in Supabase
  // get touched (we don't fabricate rows from new-job alerts here).
  const NOTIFICATION_TO_OUTCOME: Partial<Record<UpworkNotification["type"], "won" | "rejected" | "interviewed" | "no_response">> = {
    hire: "won",
    offer: "won",
    proposal_declined: "rejected",
    interview_invite: "interviewed",
    message: "interviewed",            // client messaged us = active conversation
    // proposal_viewed is intentionally not mapped — it's a soft signal we capture below
    //   without overwriting the binary outcome state.
  };
  let outcomeUpdates = 0;
  let viewedSignals = 0;
  for (const n of notifications) {
    if (!n.url) continue;
    const m = n.url.match(/~0?([a-f0-9]{10,})/);
    if (!m) continue;
    const jobId = m[1];
    // Only act on jobs that are already in our DB (i.e. we've submitted on them).
    const exists = await cloud.proposalExists(jobId).catch(() => false);
    if (!exists) continue;

    const outcome = NOTIFICATION_TO_OUTCOME[n.type];
    if (outcome) {
      try {
        await cloud.recordOutcome(jobId, outcome);
        outcomeUpdates++;
        logger.info(`[Upwork] Auto-marked outcome: ${jobId.slice(0, 10)} → ${outcome} (from ${n.type} notification)`);
      } catch (e) {
        logger.warn(`[Upwork] Failed to record outcome for ${jobId}: ${(e as Error).message}`);
      }
    } else if (n.type === "proposal_viewed") {
      // Soft signal: don't change status, just stamp the viewed timestamp via reasoning text.
      // updateProposalStatus's `extra` map lets us persist a timestamp without forcing an
      // outcome category. This unblocks "we got viewed in N minutes" analytics later.
      await cloud.updateProposalStatus(jobId, "submitted", {
        viewed_at: new Date().toISOString(),
      }).catch(() => {});
      viewedSignals++;
    }
  }
  if (outcomeUpdates > 0 || viewedSignals > 0) {
    logger.info(`[Upwork] Notification → outcome sync: ${outcomeUpdates} status updates, ${viewedSignals} viewed signals`);
  }

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
            aiScore: result.aiScore, aiReasoning: result.aiReasoning,
            slots: built.proposalSlots,
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
            aiScore: result.aiScore, aiReasoning: result.aiReasoning,
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
            aiScore: result.aiScore, aiReasoning: result.aiReasoning,
            slots: built.proposalSlots,
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
            aiScore: result.aiScore, aiReasoning: result.aiReasoning,
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
  windows: {
    "7d": { submitted: number; won: number; closeRate: number };
    "30d": { submitted: number; won: number; closeRate: number };
    "90d": { submitted: number; won: number; closeRate: number };
  };
}> {
  const [metrics, w7, w30, w90] = await Promise.all([
    cloud.getProposalMetrics(),
    cloud.getCloseRateWindow(7),
    cloud.getCloseRateWindow(30),
    cloud.getCloseRateWindow(90),
  ]);
  const closeRate = metrics.submitted > 0
    ? Math.round((metrics.won / metrics.submitted) * 100)
    : 0;
  return { ...metrics, closeRate, windows: { "7d": w7, "30d": w30, "90d": w90 } };
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
