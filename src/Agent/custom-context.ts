/**
 * src/Agent/custom-context.ts — per-niche free-text context that gets injected into the
 * proposal-generation prompt at run time. Lets the user add ad-hoc links + snippets ("for
 * SaaS jobs include https://example.com/saas-case-study; mention the Stripe migration we
 * did") without editing the main character.json.
 *
 * Stored as a plain JSON map: { "<niche>": "<free-text block>" }. The niche key matches what
 * pickNicheForJob produces (lowercased tag) plus a special "global" entry that's always added.
 * Persisted at src/Agent/characters/custom-context.json so it lives next to the character file
 * but doesn't pollute it.
 */
import fs from "fs";
import path from "path";
import logger from "../config/logger";

const CONTEXT_PATH = path.join(__dirname, "characters", "custom-context.json");

export type CustomContext = Record<string, string>;

let _cache: CustomContext | null = null;
let _cacheLoadedAt = 0;
const CACHE_TTL_MS = 30 * 1000;

export function getCustomContext(): CustomContext {
  if (_cache && Date.now() - _cacheLoadedAt < CACHE_TTL_MS) return _cache;
  try {
    if (!fs.existsSync(CONTEXT_PATH)) {
      _cache = {};
      _cacheLoadedAt = Date.now();
      return _cache;
    }
    const raw = fs.readFileSync(CONTEXT_PATH, "utf8");
    const parsed = JSON.parse(raw) as CustomContext;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      _cache = parsed;
      _cacheLoadedAt = Date.now();
      return _cache;
    }
    logger.warn(`[CustomContext] ${CONTEXT_PATH} is not an object — ignoring`);
    _cache = {};
    _cacheLoadedAt = Date.now();
    return _cache;
  } catch (e) {
    logger.warn(`[CustomContext] read failed: ${(e as Error).message}`);
    _cache = {};
    _cacheLoadedAt = Date.now();
    return _cache;
  }
}

export function saveCustomContext(next: CustomContext): { ok: boolean; error?: string } {
  if (!next || typeof next !== "object" || Array.isArray(next)) {
    return { ok: false, error: "custom context must be a flat object {niche: string}" };
  }
  for (const [k, v] of Object.entries(next)) {
    if (typeof v !== "string") return { ok: false, error: `value for "${k}" must be a string` };
    if (v.length > 4000) return { ok: false, error: `value for "${k}" too long (max 4000 chars)` };
  }
  try {
    fs.mkdirSync(path.dirname(CONTEXT_PATH), { recursive: true });
    fs.writeFileSync(CONTEXT_PATH, JSON.stringify(next, null, 2), "utf8");
    _cache = next;
    _cacheLoadedAt = Date.now();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Resolve which custom-context entries apply to a given job. Always includes the "global"
 * entry (if any). Then matches the tag list against context keys (case-insensitive).
 *
 * Returns an array of {key, text} so the prompt builder can join them with clear section
 * breaks. Empty array means no context applies.
 */
export function resolveCustomContextForTags(tags: string[] | undefined): Array<{ key: string; text: string }> {
  const ctx = getCustomContext();
  const out: Array<{ key: string; text: string }> = [];
  const seen = new Set<string>();

  if (ctx.global) { out.push({ key: "global", text: ctx.global }); seen.add("global"); }

  if (tags?.length) {
    const lowerTags = tags.map(t => t.toLowerCase());
    for (const [key, text] of Object.entries(ctx)) {
      if (key === "global" || seen.has(key)) continue;
      if (lowerTags.some(t => t.includes(key.toLowerCase()) || key.toLowerCase().includes(t))) {
        out.push({ key, text });
        seen.add(key);
      }
    }
  }
  return out;
}

/** Test helper — clears the cache so the next call re-reads disk. */
export function _invalidateCustomContextCache(): void {
  _cache = null;
  _cacheLoadedAt = 0;
}
