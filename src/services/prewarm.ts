/**
 * src/services/prewarm.ts — proposal pre-generation cache.
 *
 * When a job is scored above the threshold we don't need to wait until submit time to generate
 * the cover letter — we can kick off generation in the background. By the time someone calls
 * buildProposal for that jobId again, the result is already cached and returned instantly.
 *
 * Why this matters for "first to apply":
 *   - Cover-letter generation takes 4-10 seconds (Claude Sonnet round-trip + slot quality gate).
 *   - That's 4-10s of latency between "this job is good" and "we hit Submit".
 *   - With pre-warm, generation runs concurrently with the rest of the scan loop / human approval
 *     window, so the actual submit click happens immediately.
 *
 * Cache semantics:
 *   - Keyed by jobId. Stores the in-flight Promise so concurrent callers share the same work.
 *   - 5-minute TTL — past that, the cover letter goes stale (job may have changed) and we regen.
 *   - On error, the entry is dropped immediately so the next caller retries cleanly.
 */
import logger from "../config/logger";
import type { UpworkJob } from "../client/Upwork";

interface CacheEntry {
  promise: Promise<UpworkJob>;
  startedAt: number;
}

const _cache = new Map<string, CacheEntry>();
const TTL_MS = 5 * 60 * 1000;
let _stats = { prewarmed: 0, hits: 0, misses: 0, errors: 0 };

export function getPrewarmStats() {
  return { ..._stats, cacheSize: _cache.size };
}

function evictIfStale(jobId: string): void {
  const entry = _cache.get(jobId);
  if (entry && Date.now() - entry.startedAt > TTL_MS) _cache.delete(jobId);
}

/**
 * Fire-and-forget: kick off cover letter generation for this job in the background.
 * Safe to call multiple times — only one generation runs per jobId.
 */
export function prewarmProposal(job: UpworkJob): void {
  if (!job?.id) return;
  evictIfStale(job.id);
  if (_cache.has(job.id)) return;

  // Lazy-import to dodge a circular dependency: prewarm.ts → Upwork.ts → prewarm.ts.
  const promise = (async () => {
    const { buildProposal } = await import("../client/Upwork");
    return buildProposal(job);
  })();

  _cache.set(job.id, { promise, startedAt: Date.now() });
  _stats.prewarmed++;
  logger.info(`[Prewarm] Started for ${job.id.slice(0, 8)} — cache size ${_cache.size}`);

  promise.catch(e => {
    _stats.errors++;
    logger.warn(`[Prewarm] ${job.id.slice(0, 8)} failed: ${(e as Error).message}`);
    _cache.delete(job.id);
  });
}

/**
 * Returns the prewarmed proposal if available. Otherwise null — caller should fall back to
 * inline buildProposal. Awaiting the returned promise gives the same {coverLetter, slots, ...}
 * shape buildProposal would have returned.
 */
export async function getPrewarmedProposal(jobId: string): Promise<UpworkJob | null> {
  if (!jobId) return null;
  evictIfStale(jobId);
  const entry = _cache.get(jobId);
  if (!entry) {
    _stats.misses++;
    return null;
  }
  _stats.hits++;
  logger.info(`[Prewarm] Cache HIT for ${jobId.slice(0, 8)}`);
  return entry.promise;
}

/** Test helper — clears all in-flight prewarms. Not used in production code paths. */
export function _clearPrewarmCacheForTests(): void {
  _cache.clear();
  _stats = { prewarmed: 0, hits: 0, misses: 0, errors: 0 };
}
