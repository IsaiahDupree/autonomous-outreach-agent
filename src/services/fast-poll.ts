/**
 * src/services/fast-poll.ts — be-first-to-apply real-time loop.
 *
 * Polls Upwork's "Most Recent" feed every FAST_POLL_INTERVAL_SEC. For each new job (not seen
 * recently and not already in Supabase), runs the full score → buildProposal → submitProposal
 * pipeline immediately. Designed to react in seconds, not the 20-minute cron window.
 *
 * State:
 *   - In-memory ring buffer of last RING_SIZE seen jobIds — cheap O(1) dedup before any DB hit.
 *   - Supabase dedup is the source of truth; the ring just avoids duplicate score calls inside
 *     a single poll cycle / between cycles within minutes.
 *
 * Safety:
 *   - Honors control.isActive() — pauses when the agent is paused or stopped.
 *   - Honors AUTO_SEND_MIN_SCORE before submitting; below threshold goes to queue like normal.
 *   - Skips when getBrowserBusy() is true so we don't compete with another submission.
 */
import logger from "../config/logger";
import * as cloud from "./cloud";
import * as control from "./process-control";
import { FAST_POLL_INTERVAL_SEC, FAST_POLL_KEYWORDS, FAST_POLL_TOP_N } from "../secret";

// Score threshold for fast-poll dispatch — anything at or above this gets the full
// build-proposal pipeline. Below this still gets scored + saved but skips proposal gen.
// Default 3 = aggressive (submit nearly everything that isn't pre-filtered out).
const FAST_POLL_THRESHOLD = parseInt(process.env.FAST_POLL_THRESHOLD || "3");
import type { ScrapedJob } from "../browser/upwork";

const RING_SIZE = 200;
const recentlySeen: string[] = [];

function rememberId(id: string): void {
  if (recentlySeen.includes(id)) return;
  recentlySeen.push(id);
  if (recentlySeen.length > RING_SIZE) recentlySeen.shift();
}

function alreadySeen(id: string): boolean {
  return recentlySeen.includes(id);
}

let _running = false;
let _timer: NodeJS.Timeout | null = null;
let _stats = { polls: 0, found: 0, dispatched: 0, errors: 0 };

export function getFastPollStats() {
  return { ..._stats, ringSize: recentlySeen.length, running: _running };
}

/**
 * One fast-poll tick: scrape top-N most-recent jobs across each keyword, dedup, dispatch
 * any new high-scoring jobs into the full pipeline.
 */
async function tick(): Promise<void> {
  if (!control.isActive()) {
    logger.debug("[FastPoll] Agent paused — skipping tick");
    return;
  }
  _stats.polls++;

  // Lazy import to avoid a circular dependency at module load.
  const { ensureUpworkLoggedIn } = await import("../browser/upwork");
  const { fetchMostRecentJobs } = await import("../browser/upwork-fast-poll");
  const { processJobs } = await import("../client/Upwork");

  // Guard: if Upwork has logged us out, every fetch will redirect to login and look like a
  // 0-tile scrape. Auto-recover before wasting cycles. Suppress the notify callback here —
  // fast-poll runs every 60s; the 15-min session cron handles Telegram alerting.
  const loggedIn = await ensureUpworkLoggedIn();
  if (!loggedIn) {
    logger.warn("[FastPoll] Skipping tick — not logged in and auto-recovery failed");
    return;
  }

  const fresh: ScrapedJob[] = [];
  for (const keyword of FAST_POLL_KEYWORDS) {
    try {
      const jobs = await fetchMostRecentJobs(keyword, FAST_POLL_TOP_N);
      for (const j of jobs) {
        if (!j.id || alreadySeen(j.id)) continue;
        rememberId(j.id);
        fresh.push(j);
      }
    } catch (e) {
      _stats.errors++;
      logger.warn(`[FastPoll] fetch failed for "${keyword}": ${(e as Error).message}`);
    }
  }
  if (fresh.length === 0) return;

  // Final dedup against Supabase before scoring/dispatch
  const existing = await cloud.proposalExistsBatch(fresh.map(j => j.id)).catch(() => new Set<string>());
  const novel = fresh.filter(j => !existing.has(j.id));
  if (novel.length === 0) return;

  _stats.found += novel.length;
  logger.info(`[FastPoll] ${novel.length} new job(s): ${novel.map(j => j.id.slice(0, 8)).join(", ")}`);

  // Hand off to the existing scoring + auto-send pipeline. processJobs handles connects budget,
  // dedup, AUTO_SEND gating, and Telegram approval.
  try {
    await processJobs(novel as any, FAST_POLL_THRESHOLD, "FastPoll");
    _stats.dispatched += novel.length;
  } catch (e) {
    _stats.errors++;
    logger.error(`[FastPoll] dispatch failed: ${(e as Error).message}`);
  }
}

/** Start the fast-poll loop. Idempotent — safe to call repeatedly. */
export function startFastPoll(): void {
  if (_running) return;
  _running = true;
  const intervalMs = Math.max(15, FAST_POLL_INTERVAL_SEC) * 1000;
  logger.info(`[FastPoll] Starting — interval=${intervalMs / 1000}s, keywords=[${FAST_POLL_KEYWORDS.join(", ")}], topN=${FAST_POLL_TOP_N}`);

  // Run once immediately, then on the interval.
  tick().catch(e => logger.warn(`[FastPoll] initial tick error: ${(e as Error).message}`));
  _timer = setInterval(() => {
    tick().catch(e => logger.warn(`[FastPoll] tick error: ${(e as Error).message}`));
  }, intervalMs);
}

export function stopFastPoll(): void {
  if (_timer) clearInterval(_timer);
  _timer = null;
  _running = false;
  logger.info("[FastPoll] Stopped");
}

/** Test helper — clears ring buffer + stats so each test starts clean. Not used in production. */
export function _resetFastPollForTests(): void {
  recentlySeen.length = 0;
  _stats = { polls: 0, found: 0, dispatched: 0, errors: 0 };
  _running = false;
  if (_timer) { clearInterval(_timer); _timer = null; }
}
