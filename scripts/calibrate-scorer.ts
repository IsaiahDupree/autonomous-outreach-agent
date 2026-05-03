/**
 * scripts/calibrate-scorer.ts — Re-fit Stage-1 scorer weights from Supabase outcomes.
 *
 * Pulls the last N days (default 90) of upwork_proposals, computes per-keyword
 * win-rate vs. baseline, and writes calibrated weights to data/scorer-weights.json.
 *
 * Usage:
 *   ts-node scripts/calibrate-scorer.ts            # 90 days, write data/scorer-weights.json
 *   ts-node scripts/calibrate-scorer.ts --days=60  # custom window
 *   ts-node scripts/calibrate-scorer.ts --dry-run  # print, do not write
 *
 * Methodology:
 *   - "Outcome" = a proposal with status in (won, rejected, no_response, interviewed).
 *   - "Win" = won OR interviewed OR replied (i.e. the client engaged).
 *   - For each ICP keyword that appears in ≥ MIN_KEYWORD_SAMPLES outcomes,
 *     compute its win-rate. Bonus is scaled relative to the baseline win-rate:
 *       bonus = round( BASE_BONUS * (kw_winrate / baseline_winrate) )
 *     clamped to [0, MAX_BONUS]. Keywords with too few samples keep the
 *     default flat bonus (handled by scorer-weights.ts fallback).
 *   - Strong cap and weak cap are scaled proportionally to the median
 *     calibrated bonus so the cap stays roughly 3× the typical hit value.
 */
import fs from "fs";
import path from "path";
import "dotenv/config";

import { ICP_STRONG_KEYWORDS, ICP_WEAK_KEYWORDS, matchedKeywords } from "../src/Agent/scorer";
import { DEFAULT_WEIGHTS, type ScorerWeights } from "../src/Agent/scorer-weights";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const WIN_STATUSES = new Set(["won", "interviewed", "replied"]);
const OUTCOME_STATUSES = new Set(["won", "rejected", "no_response", "interviewed", "replied"]);
const MIN_KEYWORD_SAMPLES = 5;

interface ProposalRow {
  title: string | null;
  description: string | null;
  status: string | null;
  created_at: string | null;
}

function parseFlag(name: string, fallback?: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (arg) return arg.split("=", 2)[1];
  if (process.argv.includes(`--${name}`)) return "true";
  return fallback;
}

async function fetchOutcomes(days: number): Promise<ProposalRow[]> {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("SUPABASE_URL / SUPABASE_KEY are required to calibrate.");
  }
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const statusFilter = `status=in.(${[...OUTCOME_STATUSES].join(",")})`;
  const url =
    `${SUPABASE_URL}/rest/v1/upwork_proposals` +
    `?select=title,description,status,created_at` +
    `&${statusFilter}` +
    `&created_at=gte.${encodeURIComponent(since)}` +
    `&limit=10000`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Supabase fetch failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as ProposalRow[];
}

interface KeywordStats {
  keyword: string;
  hits: number;
  wins: number;
  winRate: number;
}

function computeKeywordStats(rows: ProposalRow[], keywords: string[]): {
  baselineWinRate: number;
  perKeyword: KeywordStats[];
} {
  const totalOutcomes = rows.length;
  const totalWins = rows.filter((r) => WIN_STATUSES.has(r.status || "")).length;
  const baselineWinRate = totalOutcomes > 0 ? totalWins / totalOutcomes : 0;

  // Pre-compute matched keyword sets once per row.
  const rowMatches = rows.map((r) => {
    const text = `${r.title || ""} ${r.description || ""}`;
    const { strongHits, weakHits } = matchedKeywords(text);
    return { won: WIN_STATUSES.has(r.status || ""), set: new Set([...strongHits, ...weakHits]) };
  });

  const perKeyword: KeywordStats[] = keywords.map((kw) => {
    let hits = 0;
    let wins = 0;
    for (const m of rowMatches) {
      if (m.set.has(kw)) {
        hits++;
        if (m.won) wins++;
      }
    }
    return { keyword: kw, hits, wins, winRate: hits > 0 ? wins / hits : 0 };
  });

  return { baselineWinRate, perKeyword };
}

function fitBonus(stats: KeywordStats, baseline: number, baseBonus: number, maxBonus: number): number | null {
  if (stats.hits < MIN_KEYWORD_SAMPLES || baseline <= 0) return null;
  const ratio = stats.winRate / baseline;
  const bonus = Math.round(baseBonus * ratio);
  return Math.max(0, Math.min(maxBonus, bonus));
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function main() {
  const days = parseInt(parseFlag("days", "90") || "90", 10);
  const dryRun = parseFlag("dry-run") === "true";

  console.log(`[Calibrate] Fetching outcomes from last ${days} days...`);
  const rows = await fetchOutcomes(days);
  console.log(`[Calibrate] Got ${rows.length} outcome rows.`);

  if (rows.length < 30) {
    console.warn(
      `[Calibrate] Only ${rows.length} outcomes — insufficient for reliable calibration. ` +
      `Need at least 30. Aborting without writing.`
    );
    process.exit(1);
  }

  const strong = computeKeywordStats(rows, ICP_STRONG_KEYWORDS);
  const weak = computeKeywordStats(rows, ICP_WEAK_KEYWORDS);
  console.log(`[Calibrate] Baseline win-rate: ${(strong.baselineWinRate * 100).toFixed(1)}%`);

  const keywordBonus: Record<string, number> = {};
  const strongFitted: number[] = [];
  for (const s of strong.perKeyword) {
    const b = fitBonus(s, strong.baselineWinRate, DEFAULT_WEIGHTS.STRONG_BONUS, 40);
    if (b !== null) {
      keywordBonus[s.keyword] = b;
      strongFitted.push(b);
    }
  }
  const weakFitted: number[] = [];
  for (const w of weak.perKeyword) {
    const b = fitBonus(w, weak.baselineWinRate, DEFAULT_WEIGHTS.WEAK_BONUS, 16);
    if (b !== null) {
      keywordBonus[w.keyword] = b;
      weakFitted.push(b);
    }
  }

  const medStrong = median(strongFitted) || DEFAULT_WEIGHTS.STRONG_BONUS;
  const medWeak = median(weakFitted) || DEFAULT_WEIGHTS.WEAK_BONUS;

  const calibrated: ScorerWeights = {
    STRONG_BONUS: Math.round(medStrong) || DEFAULT_WEIGHTS.STRONG_BONUS,
    STRONG_CAP: Math.max(DEFAULT_WEIGHTS.STRONG_CAP, Math.round(medStrong * 3)),
    WEAK_BONUS: Math.round(medWeak) || DEFAULT_WEIGHTS.WEAK_BONUS,
    WEAK_CAP: Math.max(DEFAULT_WEIGHTS.WEAK_CAP, Math.round(medWeak * 3)),
    KEYWORD_BONUS: keywordBonus,
    meta: {
      calibratedAt: new Date().toISOString(),
      sampleSize: rows.length,
      baselineWinRate: Number(strong.baselineWinRate.toFixed(4)),
    },
  };

  console.log("[Calibrate] Top 10 strong keywords by win-rate:");
  for (const s of [...strong.perKeyword].filter((s) => s.hits >= MIN_KEYWORD_SAMPLES).sort((a, b) => b.winRate - a.winRate).slice(0, 10)) {
    console.log(`  ${s.keyword.padEnd(28)} ${s.wins}/${s.hits} = ${(s.winRate * 100).toFixed(1)}%  bonus=${keywordBonus[s.keyword]}`);
  }

  if (dryRun) {
    console.log("[Calibrate] --dry-run: not writing file.");
    console.log(JSON.stringify(calibrated, null, 2));
    return;
  }

  const outDir = path.resolve(process.cwd(), "data");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "scorer-weights.json");
  fs.writeFileSync(outPath, JSON.stringify(calibrated, null, 2) + "\n");
  console.log(`[Calibrate] Wrote ${outPath} (${Object.keys(keywordBonus).length} per-keyword overrides).`);
}

main().catch((e) => {
  console.error("[Calibrate] Failed:", e);
  process.exit(1);
});
