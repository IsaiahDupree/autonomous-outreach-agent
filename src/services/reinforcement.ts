/**
 * src/services/reinforcement.ts — outcome-based feedback loop.
 *
 * Reads outcomed proposals from Supabase, computes per-niche stats, and persists them
 * to `niche_performance`. Two consumers read that cache:
 *   1. generateProposalContent — injects "what's been winning in this niche" into the prompt
 *   2. scorer — biases scores toward niches with high win/response rates
 */
import { SUPABASE_URL, SUPABASE_KEY } from "../secret";
import * as cloud from "./cloud";
import logger from "../config/logger";
import { SLOT_NAMES, type SlotName } from "../Agent/slots";

const supabaseHeaders = () => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
});

async function safeFetch(url: string, opts: RequestInit = {}, timeoutMs = 10000): Promise<Response> {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
}

/** Minimum number of outcomed proposals before we trust niche stats. */
export const MIN_SAMPLES = 5;

export interface NichePerformance {
  niche: string;
  win_rate: number | null;
  response_rate: number | null;
  sample_count: number;
  won_count: number;
  lost_count: number;
  no_response_count: number;
  interviewed_count: number;
  winning_patterns: string | null;
  winning_slot_freq: Record<string, number> | null;
  avg_win_bid: number | null;
  avg_loss_bid: number | null;
  updated_at: string;
}

interface ProposalRow {
  job_id: string;
  status: string;
  score?: number;
  tags?: string[];
  submitted_bid_amount?: number;
  proposal_slots_json?: Record<string, string>;
}

/** Fetch outcomed proposals across all four outcome statuses. */
async function fetchOutcomedProposals(): Promise<ProposalRow[]> {
  const won = await cloud.getProposalsByFilter({ status: "won", limit: 500 });
  const rejected = await cloud.getProposalsByFilter({ status: "rejected", limit: 500 });
  const noResponse = await cloud.getProposalsByFilter({ status: "no_response", limit: 500 });
  const interviewed = await cloud.getProposalsByFilter({ status: "interviewed", limit: 500 });
  return [...won, ...rejected, ...noResponse, ...interviewed] as unknown as ProposalRow[];
}

interface NicheBucket {
  won: ProposalRow[];
  lost: ProposalRow[];
  no_response: ProposalRow[];
  interviewed: ProposalRow[];
}

function groupByNiche(rows: ProposalRow[]): Map<string, NicheBucket> {
  const buckets = new Map<string, NicheBucket>();
  for (const row of rows) {
    const tags = (row.tags || []).map(t => t.toLowerCase()).filter(Boolean);
    if (tags.length === 0) tags.push("other");
    for (const tag of tags) {
      if (!buckets.has(tag)) {
        buckets.set(tag, { won: [], lost: [], no_response: [], interviewed: [] });
      }
      const bucket = buckets.get(tag)!;
      if (row.status === "won") bucket.won.push(row);
      else if (row.status === "rejected") bucket.lost.push(row);
      else if (row.status === "no_response") bucket.no_response.push(row);
      else if (row.status === "interviewed") bucket.interviewed.push(row);
    }
  }
  return buckets;
}

function computeSlotFreq(rows: ProposalRow[]): Record<string, number> {
  const freq: Record<string, number> = {};
  for (const slot of SLOT_NAMES) freq[slot] = 0;
  if (rows.length === 0) return freq;
  for (const row of rows) {
    const slots = row.proposal_slots_json || {};
    for (const slot of SLOT_NAMES) {
      if ((slots[slot] || "").trim().length >= 20) freq[slot]++;
    }
  }
  for (const slot of SLOT_NAMES) {
    freq[slot] = Math.round((freq[slot] / rows.length) * 100) / 100;
  }
  return freq;
}

function avg(nums: number[]): number | null {
  const filtered = nums.filter(n => typeof n === "number" && !isNaN(n));
  if (filtered.length === 0) return null;
  return Math.round(filtered.reduce((a, b) => a + b, 0) / filtered.length);
}

function summarizeWinningPatterns(bucket: NicheBucket, slotFreq: Record<string, number>): string {
  const parts: string[] = [];
  const winners = bucket.won;
  if (winners.length === 0) return "";

  // Which beats appear in ≥80% of winners?
  const dominantBeats = (Object.entries(slotFreq) as Array<[SlotName, number]>)
    .filter(([_, v]) => v >= 0.8)
    .map(([k]) => k);
  if (dominantBeats.length > 0) {
    parts.push(`Winners consistently include: ${dominantBeats.join(", ")}.`);
  }

  // Bid bracket of winners
  const winBids = winners.map(w => w.submitted_bid_amount).filter((n): n is number => typeof n === "number");
  if (winBids.length >= 3) {
    const lo = Math.min(...winBids);
    const hi = Math.max(...winBids);
    const mean = Math.round(winBids.reduce((a, b) => a + b, 0) / winBids.length);
    parts.push(`Winning bids: $${lo}–$${hi} (avg $${mean}).`);
  }

  // Score bracket of winners
  const winScores = winners
    .map(w => w.score)
    .filter((n): n is number => typeof n === "number");
  if (winScores.length >= 3) {
    const minS = Math.min(...winScores);
    const meanS = Math.round((winScores.reduce((a, b) => a + b, 0) / winScores.length) * 10) / 10;
    parts.push(`Winning score range: ${minS}–10 (avg ${meanS}).`);
  }

  return parts.join(" ");
}

/**
 * Recompute per-niche stats from the proposal table and persist to niche_performance.
 * Returns the number of niches updated.
 */
export async function computeNichePerformance(): Promise<{ updated: number; skipped: number }> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return { updated: 0, skipped: 0 };

  const rows = await fetchOutcomedProposals();
  if (rows.length === 0) {
    logger.info("[Reinforcement] No outcomed proposals — skipping niche refresh");
    return { updated: 0, skipped: 0 };
  }
  logger.info(`[Reinforcement] Analyzing ${rows.length} outcomed proposals`);

  const buckets = groupByNiche(rows);
  let updated = 0;
  let skipped = 0;

  for (const [niche, bucket] of buckets) {
    const total = bucket.won.length + bucket.lost.length + bucket.no_response.length + bucket.interviewed.length;
    if (total < MIN_SAMPLES) {
      skipped++;
      continue;
    }

    const winRate = (bucket.won.length + bucket.interviewed.length * 0.5) / total;
    const responseRate = (bucket.won.length + bucket.interviewed.length) / total;
    const slotFreq = computeSlotFreq(bucket.won);
    const summary = summarizeWinningPatterns(bucket, slotFreq);
    const avgWinBid = avg(bucket.won.map(w => w.submitted_bid_amount).filter((n): n is number => typeof n === "number"));
    const avgLossBid = avg([...bucket.lost, ...bucket.no_response].map(w => w.submitted_bid_amount).filter((n): n is number => typeof n === "number"));

    const body: NichePerformance = {
      niche,
      win_rate: Math.round(winRate * 1000) / 1000,
      response_rate: Math.round(responseRate * 1000) / 1000,
      sample_count: total,
      won_count: bucket.won.length,
      lost_count: bucket.lost.length,
      no_response_count: bucket.no_response.length,
      interviewed_count: bucket.interviewed.length,
      winning_patterns: summary || null,
      winning_slot_freq: slotFreq,
      avg_win_bid: avgWinBid,
      avg_loss_bid: avgLossBid,
      updated_at: new Date().toISOString(),
    };

    try {
      const res = await safeFetch(`${SUPABASE_URL}/rest/v1/niche_performance`, {
        method: "POST",
        headers: { ...supabaseHeaders(), Prefer: "return=representation,resolution=merge-duplicates" },
        body: JSON.stringify(body),
      });
      if (!res.ok && res.status !== 409) {
        const err = await res.text().catch(() => "");
        logger.warn(`[Reinforcement] Upsert failed for ${niche} (${res.status}): ${err.slice(0, 120)}`);
        continue;
      }
      if (res.status === 409) {
        const { niche: _n, ...patch } = body;
        await safeFetch(
          `${SUPABASE_URL}/rest/v1/niche_performance?niche=eq.${encodeURIComponent(niche)}`,
          { method: "PATCH", headers: supabaseHeaders(), body: JSON.stringify(patch) }
        );
      }
      updated++;
    } catch (e) {
      logger.warn(`[Reinforcement] Upsert error for ${niche}: ${(e as Error).message}`);
    }
  }

  logger.info(`[Reinforcement] Updated ${updated} niches, skipped ${skipped} (below ${MIN_SAMPLES} samples)`);
  return { updated, skipped };
}

/** Load a single niche's performance row for use in the proposal prompt. */
export async function getNichePerformance(niche: string): Promise<NichePerformance | null> {
  if (!SUPABASE_URL || !SUPABASE_KEY || !niche) return null;
  try {
    const res = await safeFetch(
      `${SUPABASE_URL}/rest/v1/niche_performance?niche=eq.${encodeURIComponent(niche.toLowerCase())}&select=*`,
      { headers: supabaseHeaders() }
    );
    if (!res.ok) return null;
    const rows = await res.json() as NichePerformance[];
    return rows[0] || null;
  } catch {
    return null;
  }
}

/** Load every niche's performance once — used by the scorer to bias scoring per scan cycle. */
export async function getAllNichePerformance(): Promise<Record<string, NichePerformance>> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return {};
  try {
    const res = await safeFetch(
      `${SUPABASE_URL}/rest/v1/niche_performance?select=*`,
      { headers: supabaseHeaders() }
    );
    if (!res.ok) return {};
    const rows = await res.json() as NichePerformance[];
    const out: Record<string, NichePerformance> = {};
    for (const r of rows) out[r.niche] = r;
    return out;
  } catch {
    return {};
  }
}

/**
 * Pick the most-relevant niche given a job's tags.
 * Looks for the niche with the most outcome data (highest sample_count among matches).
 */
export function pickNicheForJob(tags: string[] | undefined, allStats: Record<string, NichePerformance>): NichePerformance | null {
  if (!tags?.length) return null;
  let best: NichePerformance | null = null;
  for (const tag of tags) {
    const stats = allStats[tag.toLowerCase()];
    if (!stats) continue;
    if (!best || stats.sample_count > best.sample_count) best = stats;
  }
  return best;
}
