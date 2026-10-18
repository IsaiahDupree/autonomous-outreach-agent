/**
 * src/services/ranking.ts — Composite job ranking for daily strategy
 * Goes beyond AI score (0-10) to holistically rank queued jobs using
 * recency, client quality, competition level, budget, and connects efficiency.
 */
import logger from "../config/logger";
import * as cloud from "./cloud";

// ── Types ──

export interface RankedJob {
  jobId: string;
  title: string;
  url: string;
  description: string;
  budget?: string;
  tags?: string[];
  aiScore: number;
  compositeScore: number;
  scheduledSlot: "morning" | "midday" | "evening";
  proofEligible: boolean;
  raw: Record<string, unknown>;
}

// ── Weights (must sum to 1.0) ──

const WEIGHTS = {
  aiScore: 0.40,
  recency: 0.20,
  clientQuality: 0.15,
  competition: 0.10,
  budget: 0.10,
  connectsEfficiency: 0.05,
};

// ── Component Scorers ──

/** Normalize AI score (0-10) to 0-100 */
function scoreAI(row: Record<string, unknown>): number {
  const score = Number(row.score) || 0;
  return Math.min(score * 10, 100);
}

/** Recency: jobs posted more recently score higher. Max 100 for <1h, 0 for >48h */
function scoreRecency(row: Record<string, unknown>): number {
  const created = row.created_at as string | undefined;
  if (!created) return 50; // unknown age, middle score
  const hoursOld = (Date.now() - new Date(created).getTime()) / (1000 * 60 * 60);
  if (hoursOld < 1) return 100;
  if (hoursOld < 4) return 85;
  if (hoursOld < 8) return 70;
  if (hoursOld < 16) return 55;
  if (hoursOld < 24) return 40;
  if (hoursOld < 48) return 20;
  return 5;
}

/** Client quality: hire rate + payment verified + hires count */
function scoreClientQuality(row: Record<string, unknown>): number {
  let score = 0;
  const hireRate = Number(row.client_hire_rate) || 0;
  const hires = Number(row.client_hires) || 0;
  const verified = row.payment_verified;

  // Hire rate: 0-50 points
  if (hireRate >= 80) score += 50;
  else if (hireRate >= 60) score += 40;
  else if (hireRate >= 40) score += 30;
  else if (hireRate >= 20) score += 20;
  else if (hireRate > 0) score += 10;

  // Payment verified: 20 points
  if (verified === true || verified === "true") score += 20;

  // Hire count: 0-30 points
  if (hires >= 20) score += 30;
  else if (hires >= 10) score += 25;
  else if (hires >= 5) score += 20;
  else if (hires >= 1) score += 15;

  return Math.min(score, 100);
}

/** Competition: fewer existing proposals = higher score */
function scoreCompetition(row: Record<string, unknown>): number {
  const proposals = Number(row.proposals) || 0;
  if (proposals === 0) return 100;
  if (proposals <= 5) return 85;
  if (proposals <= 10) return 65;
  if (proposals <= 20) return 40;
  if (proposals <= 50) return 20;
  return 5;
}

/** Budget: higher budgets score better */
function scoreBudget(row: Record<string, unknown>): number {
  const budgetStr = (row.budget as string) || "";
  // Extract numeric value from budget string like "Fixed $500-1000" or "$50/hr"
  const nums = budgetStr.match(/[\d,]+/g);
  if (!nums || nums.length === 0) return 30; // unknown budget
  const values = nums.map(n => Number(n.replace(/,/g, "")));
  const maxVal = Math.max(...values);

  if (maxVal >= 5000) return 100;
  if (maxVal >= 2000) return 80;
  if (maxVal >= 1000) return 65;
  if (maxVal >= 500) return 50;
  if (maxVal >= 200) return 35;
  return 15;
}

/** Connects efficiency: score per connect spent */
function scoreConnectsEfficiency(row: Record<string, unknown>): number {
  const aiScore = Number(row.score) || 0;
  const connects = Number(row.submitted_connects_cost) || 4; // default 4 connects
  const ratio = aiScore / connects;
  if (ratio >= 2) return 100;
  if (ratio >= 1.5) return 80;
  if (ratio >= 1) return 60;
  if (ratio >= 0.5) return 40;
  return 20;
}

// ── Main Functions ──

/** Compute composite score (0-100) for a single proposal row */
export function computeCompositeScore(row: Record<string, unknown>): number {
  const components = {
    aiScore: scoreAI(row),
    recency: scoreRecency(row),
    clientQuality: scoreClientQuality(row),
    competition: scoreCompetition(row),
    budget: scoreBudget(row),
    connectsEfficiency: scoreConnectsEfficiency(row),
  };

  const composite =
    components.aiScore * WEIGHTS.aiScore +
    components.recency * WEIGHTS.recency +
    components.clientQuality * WEIGHTS.clientQuality +
    components.competition * WEIGHTS.competition +
    components.budget * WEIGHTS.budget +
    components.connectsEfficiency * WEIGHTS.connectsEfficiency;

  return Math.round(composite * 10) / 10; // 1 decimal
}

/** Fetch all queued proposals and rank them by composite score */
export async function rankDailyQueue(): Promise<RankedJob[]> {
  const queued = await cloud.getProposalsByFilter({
    status: ["queued", "pending"],
    minScore: 5,
    limit: 100,
  });

  if (queued.length === 0) {
    logger.info("[ranking] No queued jobs to rank");
    return [];
  }

  const ranked: RankedJob[] = queued.map(row => ({
    jobId: row.job_id as string,
    title: (row.job_title as string) || "Untitled",
    url: row.job_url as string,
    description: (row.job_description as string) || "",
    budget: row.budget as string | undefined,
    tags: row.tags as string[] | undefined,
    aiScore: Number(row.score) || 0,
    compositeScore: computeCompositeScore(row),
    scheduledSlot: "morning" as const, // assigned later by selectDailyTop5
    proofEligible: (Number(row.score) || 0) >= 8,
    raw: row,
  }));

  ranked.sort((a, b) => b.compositeScore - a.compositeScore);

  logger.info(`[ranking] Ranked ${ranked.length} jobs. Top: ${ranked[0]?.title.slice(0, 40)} (${ranked[0]?.compositeScore})`);
  return ranked;
}

/**
 * Select top 5 jobs with niche diversity.
 * Avoids picking 5 jobs from the same category by checking tag overlap.
 */
export function selectDailyTop5(ranked: RankedJob[]): RankedJob[] {
  if (ranked.length <= 5) {
    return assignSlots(ranked);
  }

  const selected: RankedJob[] = [];
  const usedNiches = new Set<string>();

  for (const job of ranked) {
    if (selected.length >= 5) break;

    // Determine the job's primary niche from tags
    const niche = getPrimaryNiche(job.tags || []);

    // Allow max 2 jobs per niche for diversity
    const nicheCount = selected.filter(s => getPrimaryNiche(s.tags || []) === niche).length;
    if (nicheCount >= 2 && niche !== "other") {
      continue; // skip, too many from this niche
    }

    usedNiches.add(niche);
    selected.push(job);
  }

  // If diversity filtering left us short, backfill from top remaining
  if (selected.length < 5) {
    const selectedIds = new Set(selected.map(s => s.jobId));
    for (const job of ranked) {
      if (selected.length >= 5) break;
      if (!selectedIds.has(job.jobId)) {
        selected.push(job);
      }
    }
  }

  logger.info(`[ranking] Selected ${selected.length} jobs for today. Niches: ${[...usedNiches].join(", ")}`);
  return assignSlots(selected);
}

/** Map tags to broad niche categories for diversity check */
function getPrimaryNiche(tags: string[]): string {
  const text = tags.join(" ").toLowerCase();
  if (/\b(ai|llm|gpt|claude|openai|machine learning|ml)\b/.test(text)) return "ai";
  if (/\b(react|vue|angular|frontend|next\.?js|svelte)\b/.test(text)) return "frontend";
  if (/\b(python|django|fastapi|flask)\b/.test(text)) return "python";
  if (/\b(mobile|react native|flutter|ios|android)\b/.test(text)) return "mobile";
  if (/\b(data|pipeline|etl|scraping|extraction)\b/.test(text)) return "data";
  if (/\b(chatbot|bot|conversational)\b/.test(text)) return "chatbot";
  if (/\b(automation|n8n|zapier|workflow|crm)\b/.test(text)) return "automation";
  if (/\b(cad|solidworks|fusion|3d|arduino|iot|esp32|raspberry)\b/.test(text)) return "hardware";
  if (/\b(saas|mvp|full.?stack|web app)\b/.test(text)) return "fullstack";
  if (/\b(voice|tts|speech|elevenlabs)\b/.test(text)) return "voice";
  return "other";
}

/** Assign time slots: morning (2), midday (2), evening (1) */
function assignSlots(jobs: RankedJob[]): RankedJob[] {
  const slots: Array<"morning" | "midday" | "evening"> = ["morning", "morning", "midday", "midday", "evening"];
  return jobs.map((job, i) => ({
    ...job,
    scheduledSlot: slots[i] || "evening",
    proofEligible: job.aiScore >= 8 || job.compositeScore >= 80,
  }));
}
