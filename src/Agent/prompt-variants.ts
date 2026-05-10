/**
 * src/Agent/prompt-variants.ts — A/B prompt variants per niche.
 *
 * Each niche can have multiple alternative prompt fragments that get appended to the main
 * proposal prompt. The agent picks one per submission via weighted random so we can
 * actually compare which framing wins more jobs over time.
 *
 * Stored at src/Agent/characters/prompt-variants.json. Shape:
 *   {
 *     "<niche>": [
 *       { "name": "lead-with-portfolio", "fragment": "...", "weight": 1 },
 *       { "name": "lead-with-github",    "fragment": "...", "weight": 1 },
 *     ]
 *   }
 *
 * The chosen variant's name is recorded on the proposal row (via reasoning suffix) so the
 * niche-performance reinforcement loop can correlate variant → win rate later.
 */
import fs from "fs";
import path from "path";
import logger from "../config/logger";

const VARIANTS_PATH = path.join(__dirname, "characters", "prompt-variants.json");

export interface PromptVariant {
  name: string;
  fragment: string;
  weight?: number;   // default 1; relative weights within a niche
}

export type PromptVariants = Record<string, PromptVariant[]>;

let _cache: PromptVariants | null = null;
let _cacheLoadedAt = 0;
const CACHE_TTL_MS = 30 * 1000;

export function getPromptVariants(): PromptVariants {
  if (_cache && Date.now() - _cacheLoadedAt < CACHE_TTL_MS) return _cache;
  try {
    if (!fs.existsSync(VARIANTS_PATH)) { _cache = {}; _cacheLoadedAt = Date.now(); return _cache; }
    const raw = fs.readFileSync(VARIANTS_PATH, "utf8");
    const parsed = JSON.parse(raw) as PromptVariants;
    _cache = (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed : {};
    _cacheLoadedAt = Date.now();
    return _cache;
  } catch (e) {
    logger.warn(`[PromptVariants] read failed: ${(e as Error).message}`);
    _cache = {}; _cacheLoadedAt = Date.now();
    return _cache;
  }
}

export function savePromptVariants(next: PromptVariants): { ok: boolean; error?: string } {
  if (!next || typeof next !== "object" || Array.isArray(next)) {
    return { ok: false, error: "variants must be an object" };
  }
  for (const [niche, list] of Object.entries(next)) {
    if (!Array.isArray(list)) return { ok: false, error: `variants[${niche}] must be an array` };
    for (const v of list) {
      if (!v || typeof v.name !== "string" || typeof v.fragment !== "string") {
        return { ok: false, error: `each variant under "${niche}" needs string name + fragment` };
      }
      if (v.fragment.length > 6000) return { ok: false, error: `fragment for "${niche}/${v.name}" too long (max 6000)` };
      if (v.weight != null && (typeof v.weight !== "number" || v.weight < 0)) {
        return { ok: false, error: `weight for "${niche}/${v.name}" must be a non-negative number` };
      }
    }
  }
  try {
    fs.mkdirSync(path.dirname(VARIANTS_PATH), { recursive: true });
    fs.writeFileSync(VARIANTS_PATH, JSON.stringify(next, null, 2), "utf8");
    _cache = next; _cacheLoadedAt = Date.now();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Pick a variant for a job, given its tags. Returns null if no variants are defined for any
 * matching niche — caller should fall through to the default prompt.
 *
 * Selection: weighted random across the FIRST matching niche. If multiple niches match, the
 * first one with variants wins (so users can prioritize via niche order).
 */
export function pickVariantForTags(tags: string[] | undefined): { niche: string; variant: PromptVariant } | null {
  if (!tags?.length) return null;
  const all = getPromptVariants();
  const lowerTags = tags.map(t => t.toLowerCase());
  for (const [niche, list] of Object.entries(all)) {
    if (!list?.length) continue;
    const nicheLower = niche.toLowerCase();
    const matches = lowerTags.some(t => t.includes(nicheLower) || nicheLower.includes(t));
    if (!matches) continue;
    return { niche, variant: weightedPick(list) };
  }
  return null;
}

function weightedPick<T extends { weight?: number }>(items: T[]): T {
  const total = items.reduce((s, it) => s + (it.weight ?? 1), 0);
  if (total <= 0) return items[0];
  let r = Math.random() * total;
  for (const it of items) {
    r -= it.weight ?? 1;
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

export function _invalidatePromptVariantsCache(): void { _cache = null; _cacheLoadedAt = 0; }
