/**
 * src/Agent/scorer-weights.ts — Calibrated weights for the Stage-1 deterministic scorer.
 *
 * Defaults are the historical hand-tuned values. If `data/scorer-weights.json`
 * exists (produced by `scripts/calibrate-scorer.ts`), its values override the
 * defaults at module load. Per-keyword bonus overrides take precedence over
 * the flat STRONG_BONUS / WEAK_BONUS values for keywords that appear in the map.
 */
import fs from "fs";
import path from "path";
import logger from "../config/logger";

export interface ScorerWeights {
  STRONG_BONUS: number;       // points per matched ICP strong keyword
  STRONG_CAP: number;         // cap on cumulative strong bonus
  WEAK_BONUS: number;         // points per matched ICP weak keyword
  WEAK_CAP: number;           // cap on cumulative weak bonus
  /** Optional per-keyword bonus override (e.g. {"n8n": 28, "wordpress": 0}). */
  KEYWORD_BONUS?: Record<string, number>;
  /** Metadata from the calibration run; ignored at runtime. */
  meta?: {
    calibratedAt?: string;
    sampleSize?: number;
    baselineWinRate?: number;
  };
}

export const DEFAULT_WEIGHTS: ScorerWeights = {
  STRONG_BONUS: 20,
  STRONG_CAP: 60,
  WEAK_BONUS: 8,
  WEAK_CAP: 24,
};

const CALIBRATION_PATH = path.resolve(process.cwd(), "data", "scorer-weights.json");

function loadCalibrated(): ScorerWeights {
  try {
    if (!fs.existsSync(CALIBRATION_PATH)) return DEFAULT_WEIGHTS;
    const raw = fs.readFileSync(CALIBRATION_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<ScorerWeights>;
    const merged: ScorerWeights = {
      STRONG_BONUS: numOr(parsed.STRONG_BONUS, DEFAULT_WEIGHTS.STRONG_BONUS),
      STRONG_CAP: numOr(parsed.STRONG_CAP, DEFAULT_WEIGHTS.STRONG_CAP),
      WEAK_BONUS: numOr(parsed.WEAK_BONUS, DEFAULT_WEIGHTS.WEAK_BONUS),
      WEAK_CAP: numOr(parsed.WEAK_CAP, DEFAULT_WEIGHTS.WEAK_CAP),
      KEYWORD_BONUS: parsed.KEYWORD_BONUS,
      meta: parsed.meta,
    };
    logger.info(
      `[ScorerWeights] Loaded calibrated weights from ${CALIBRATION_PATH} ` +
      `(strong=${merged.STRONG_BONUS}/cap${merged.STRONG_CAP}, weak=${merged.WEAK_BONUS}/cap${merged.WEAK_CAP}, ` +
      `kwOverrides=${Object.keys(merged.KEYWORD_BONUS || {}).length})`
    );
    return merged;
  } catch (e) {
    logger.warn(`[ScorerWeights] Failed to load calibration: ${(e as Error).message} — using defaults`);
    return DEFAULT_WEIGHTS;
  }
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export const WEIGHTS: ScorerWeights = loadCalibrated();

/** Bonus to apply for a strong-keyword hit, with optional per-keyword override. */
export function strongBonusFor(keyword: string): number {
  const override = WEIGHTS.KEYWORD_BONUS?.[keyword];
  return typeof override === "number" ? override : WEIGHTS.STRONG_BONUS;
}

/** Bonus to apply for a weak-keyword hit, with optional per-keyword override. */
export function weakBonusFor(keyword: string): number {
  const override = WEIGHTS.KEYWORD_BONUS?.[keyword];
  return typeof override === "number" ? override : WEIGHTS.WEAK_BONUS;
}
