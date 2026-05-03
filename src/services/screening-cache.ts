/**
 * src/services/screening-cache.ts — answer cache for repeat Upwork screening questions.
 *
 * Same character + same question (fuzzy-normalized) reuses the previous Claude answer for
 * SCREENING_CACHE_TTL_DAYS, skipping the API call. Persisted to data/screening-cache.json
 * so restarts don't lose the warm cache. Single-process; safe for the agent's single-writer
 * model. If the file is corrupt or unreadable, falls back to memory-only.
 */
import fs from "fs";
import path from "path";
import logger from "../config/logger";

const CACHE_PATH = path.resolve(process.cwd(), "data", "screening-cache.json");
const TTL_MS = (Number(process.env.SCREENING_CACHE_TTL_DAYS) || 7) * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;

interface Entry { answer: string; created_at: number; }
type Store = Record<string, Entry>;

let mem: Store | null = null;

function load(): Store {
  if (mem) return mem;
  try {
    if (fs.existsSync(CACHE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
      if (raw && typeof raw === "object") { mem = raw as Store; return mem; }
    }
  } catch (e) {
    logger.warn(`[ScreeningCache] load failed: ${(e as Error).message}`);
  }
  mem = {};
  return mem;
}

function save(store: Store): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(store, null, 2), "utf8");
  } catch (e) {
    logger.warn(`[ScreeningCache] save failed: ${(e as Error).message}`);
  }
}

/**
 * Lowercase, collapse whitespace, strip punctuation that doesn't change meaning.
 * "Are you available 20+ hrs/week?" and "are you  available 20+ hrs / week" hash to the same key.
 */
function normalize(question: string): string {
  return question
    .toLowerCase()
    .replace(/[?!.,;:"'`]/g, "")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

function key(persona: string, question: string): string {
  return `${persona.slice(0, 80).trim().toLowerCase()}::${normalize(question)}`;
}

export function getCachedScreeningAnswer(persona: string, question: string): string | null {
  const store = load();
  const k = key(persona, question);
  const hit = store[k];
  if (!hit) return null;
  if (Date.now() - hit.created_at > TTL_MS) {
    delete store[k];
    save(store);
    return null;
  }
  logger.info(`[ScreeningCache] hit — skipping Claude call for "${question.slice(0, 60)}"`);
  return hit.answer;
}

export function setCachedScreeningAnswer(persona: string, question: string, answer: string): void {
  const store = load();
  const k = key(persona, question);
  store[k] = { answer, created_at: Date.now() };

  const keys = Object.keys(store);
  if (keys.length > MAX_ENTRIES) {
    keys
      .map(kk => ({ kk, t: store[kk].created_at }))
      .sort((a, b) => a.t - b.t)
      .slice(0, keys.length - MAX_ENTRIES)
      .forEach(({ kk }) => delete store[kk]);
  }
  save(store);
}

/** Test-only: drop the in-memory cache + delete the on-disk file. */
export function _resetScreeningCacheForTests(): void {
  mem = null;
  try { if (fs.existsSync(CACHE_PATH)) fs.unlinkSync(CACHE_PATH); } catch { /* ignore */ }
}
