/**
 * src/services/daily-strategy.ts — Daily submission strategy
 *
 * Two modes working together:
 * 1. FAST-APPLY: Immediately submit high-scoring jobs found during scans (immediacy wins on Upwork)
 * 2. DAILY TOP-5: At 6:30 AM UTC, rank the queue and schedule top 5 for staggered submission
 *
 * Upwork rewards speed — first proposals get more visibility. So we fast-apply great jobs
 * the moment we find them, and use the daily plan to catch anything the scans queued overnight.
 */
import logger from "../config/logger";
import { notify } from "./telegram";
import { rankDailyQueue, selectDailyTop5, type RankedJob } from "./ranking";
import * as cloud from "./cloud";
import * as ops from "./operations";

// ── Types ──

export interface DailyPlan {
  date: string;                          // YYYY-MM-DD
  selectedJobs: RankedJob[];
  submittedIds: Set<string>;
  proofJobs: RankedJob[];                // subset eligible for proof-of-work
  createdAt: string;
}

// ── State (in-memory, rebuilt daily) ──

let _currentPlan: DailyPlan | null = null;

// ── Fast-Apply Threshold ──
// Jobs scoring this high during a scan get submitted immediately (don't wait for daily plan)
const FAST_APPLY_MIN_SCORE = 7;
const FAST_APPLY_MIN_COMPOSITE = 70;

// ── Public API ──

/** Get today's plan (or null if not built yet) */
export function getDailyPlan(): DailyPlan | null {
  if (!_currentPlan) return null;
  // Check if plan is from today
  const today = new Date().toISOString().slice(0, 10);
  if (_currentPlan.date !== today) return null;
  return _currentPlan;
}

/**
 * Build the daily submission plan.
 * Called at 6:30 AM UTC by cron. Ranks all queued jobs and selects top 5.
 */
export async function buildDailyPlan(): Promise<DailyPlan> {
  const today = new Date().toISOString().slice(0, 10);
  logger.info(`[strategy] Building daily plan for ${today}`);

  const ranked = await rankDailyQueue();

  if (ranked.length === 0) {
    logger.info("[strategy] No queued jobs — empty plan");
    const plan: DailyPlan = {
      date: today,
      selectedJobs: [],
      submittedIds: new Set(),
      proofJobs: [],
      createdAt: new Date().toISOString(),
    };
    _currentPlan = plan;
    await notify("📊 *Daily Plan*\nNo queued jobs available for today.");
    return plan;
  }

  // Select top 5 with diversity
  const selected = selectDailyTop5(ranked);
  const proofJobs = selected.filter(j => j.proofEligible);

  const plan: DailyPlan = {
    date: today,
    selectedJobs: selected,
    submittedIds: new Set(),
    proofJobs,
    createdAt: new Date().toISOString(),
  };
  _currentPlan = plan;

  // Notify
  const summary = selected.map((j, i) =>
    `${i + 1}. [${j.compositeScore}] ${j.title.slice(0, 45)} — AI:${j.aiScore}/10 | ${j.scheduledSlot}${j.proofEligible ? " 🔨" : ""}`
  ).join("\n");

  await notify(
    `📊 *Daily Plan: ${selected.length} jobs selected*\n` +
    `Queue: ${ranked.length} total | Proof-eligible: ${proofJobs.length}\n\n` +
    `${summary}\n\n` +
    `🔨 = proof-of-work will be generated\n` +
    `Slots: morning (8AM) | midday (1PM) | evening (6PM) UTC`
  );

  logger.info(`[strategy] Plan built: ${selected.length} jobs, ${proofJobs.length} proof-eligible`);
  return plan;
}

/**
 * Execute a submission slot — submit the jobs scheduled for this time window.
 * Falls back to score-sort if no daily plan exists.
 */
export async function executeSlot(
  slot: "morning" | "midday" | "evening",
  submitFn: (jobId: string) => Promise<boolean>,
): Promise<{ submitted: number; failed: number }> {
  let submitted = 0;
  let failed = 0;

  // Check daily total first
  const todayCount = await getTodaySubmittedCount();
  if (todayCount >= 5) {
    logger.info(`[strategy] Already ${todayCount} submitted today — skipping ${slot} slot`);
    return { submitted: 0, failed: 0 };
  }

  const plan = getDailyPlan();
  if (!plan || plan.selectedJobs.length === 0) {
    logger.info(`[strategy] No daily plan for ${slot} — building one now`);
    await buildDailyPlan();
    const freshPlan = getDailyPlan();
    if (!freshPlan || freshPlan.selectedJobs.length === 0) {
      return { submitted: 0, failed: 0 };
    }
    return executeSlot(slot, submitFn);
  }

  // Get jobs for this slot that haven't been submitted yet
  const slotJobs = plan.selectedJobs.filter(
    j => j.scheduledSlot === slot && !plan.submittedIds.has(j.jobId)
  );

  if (slotJobs.length === 0) {
    logger.info(`[strategy] No pending jobs for ${slot} slot`);
    return { submitted: 0, failed: 0 };
  }

  logger.info(`[strategy] Executing ${slot} slot: ${slotJobs.length} jobs`);
  await notify(`🕐 *${slot.charAt(0).toUpperCase() + slot.slice(1)} slot*\nSubmitting ${slotJobs.length} proposals...`);

  for (const job of slotJobs) {
    try {
      const ok = await submitFn(job.jobId);
      if (ok) {
        submitted++;
        plan.submittedIds.add(job.jobId);
        logger.info(`[strategy] ${slot}: submitted "${job.title.slice(0, 40)}" (composite: ${job.compositeScore})`);
      } else {
        failed++;
        logger.warn(`[strategy] ${slot}: failed "${job.title.slice(0, 40)}"`);
      }
      // Human-like delay between submissions
      if (slotJobs.indexOf(job) < slotJobs.length - 1) {
        await new Promise(r => setTimeout(r, 3000 + Math.random() * 5000));
      }
    } catch (e) {
      failed++;
      logger.error(`[strategy] ${slot} error: ${(e as Error).message}`);
    }
  }

  await notify(`📊 *${slot} slot complete*\n✅ ${submitted} submitted | ❌ ${failed} failed | 📤 ${todayCount + submitted} total today`);
  return { submitted, failed };
}

/**
 * Check if a newly-scanned job should be fast-applied immediately.
 * Upwork rewards immediacy — being first to apply gets more visibility.
 * Returns true if the job is high enough quality to skip the daily queue.
 */
export function shouldFastApply(aiScore: number, compositeInputs?: {
  clientHireRate?: number;
  paymentVerified?: boolean;
  proposals?: number;
}): boolean {
  if (aiScore < FAST_APPLY_MIN_SCORE) return false;

  // If we have composite inputs, do a quick quality check
  if (compositeInputs) {
    const { clientHireRate, paymentVerified, proposals } = compositeInputs;
    // Don't fast-apply to unverified clients
    if (paymentVerified === false) return false;
    // Don't fast-apply if already 50+ proposals (too competitive)
    if (proposals && proposals > 50) return false;
    // Bonus: fast-apply to great clients even at score 7
    if (clientHireRate && clientHireRate >= 60 && aiScore >= 7) return true;
  }

  return aiScore >= FAST_APPLY_MIN_SCORE;
}

/**
 * Mark a job as submitted in the daily plan (if it's part of today's plan).
 * Called after any submission (fast-apply or scheduled) to keep the plan in sync.
 */
export function markSubmitted(jobId: string): void {
  const plan = getDailyPlan();
  if (plan) {
    plan.submittedIds.add(jobId);
  }
}

/** Get plan summary for controller/API */
export function getPlanSummary(): Record<string, unknown> | null {
  const plan = getDailyPlan();
  if (!plan) return null;

  return {
    date: plan.date,
    totalSelected: plan.selectedJobs.length,
    submitted: plan.submittedIds.size,
    pending: plan.selectedJobs.filter(j => !plan.submittedIds.has(j.jobId)).length,
    proofEligible: plan.proofJobs.length,
    jobs: plan.selectedJobs.map(j => ({
      jobId: j.jobId,
      title: j.title.slice(0, 60),
      aiScore: j.aiScore,
      compositeScore: j.compositeScore,
      slot: j.scheduledSlot,
      submitted: plan.submittedIds.has(j.jobId),
      proofEligible: j.proofEligible,
    })),
  };
}

// ── Helpers ──

async function getTodaySubmittedCount(): Promise<number> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const all = await cloud.getProposalsByFilter({ status: "submitted", limit: 50 });
  return all.filter(r => {
    const at = r.submitted_at || r.updated_at || r.created_at;
    return at && new Date(at as string) >= todayStart;
  }).length;
}
