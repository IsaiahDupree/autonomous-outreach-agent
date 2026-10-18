/**
 * services/weekly-digest.ts — Weekly Telegram digest of Upwork pipeline activity.
 *
 * Pulls the last 7 days of upwork_proposals rows and summarizes:
 * jobs scanned, scored (Stage-2 AI rated), submitted, replies (interviewed),
 * hires (won), connects spent.
 */
import logger from "../config/logger";
import * as cloud from "./cloud";
import { notify } from "./telegram";

export interface DigestRow {
  status: string;
  score: number | null;
  pre_score: number | null;
  submitted_at: string | null;
  submitted_connects_cost: number | null;
  created_at: string;
}

export interface DigestStats {
  scanned: number;
  scored: number;
  submitted: number;
  replies: number;
  hires: number;
  connectsSpent: number;
  weekStart: string;
  weekEnd: string;
}

const SUBMITTED_STATUSES = new Set(["sent", "won", "rejected", "no_response", "interviewed"]);

export function computeDigestStats(rows: DigestRow[], weekStart: Date, weekEnd: Date): DigestStats {
  let scanned = 0;
  let scored = 0;
  let submitted = 0;
  let replies = 0;
  let hires = 0;
  let connectsSpent = 0;

  for (const r of rows) {
    scanned++;
    if (typeof r.score === "number" && r.score > 0) scored++;
    if (r.submitted_at || SUBMITTED_STATUSES.has(r.status)) {
      submitted++;
      connectsSpent += r.submitted_connects_cost || 0;
    }
    if (r.status === "interviewed") replies++;
    if (r.status === "won") hires++;
  }

  return {
    scanned,
    scored,
    submitted,
    replies,
    hires,
    connectsSpent,
    weekStart: weekStart.toISOString().slice(0, 10),
    weekEnd: weekEnd.toISOString().slice(0, 10),
  };
}

export function formatDigestMessage(s: DigestStats): string {
  const replyRate = s.submitted > 0 ? Math.round((s.replies / s.submitted) * 100) : 0;
  const winRate = s.submitted > 0 ? Math.round((s.hires / s.submitted) * 100) : 0;
  return [
    `📊 *Weekly Upwork digest* (${s.weekStart} → ${s.weekEnd})`,
    ``,
    `• Scanned: ${s.scanned}`,
    `• Scored (AI): ${s.scored}`,
    `• Submitted: ${s.submitted}`,
    `• Replies: ${s.replies} (${replyRate}%)`,
    `• Hires: ${s.hires} (${winRate}%)`,
    `• Connects spent: ${s.connectsSpent}`,
  ].join("\n");
}

export async function sendWeeklyDigest(): Promise<DigestStats> {
  const weekEnd = new Date();
  const weekStart = new Date(weekEnd.getTime() - 7 * 24 * 60 * 60 * 1000);
  const rows = await cloud.fetchProposalsSince(weekStart.toISOString());
  const stats = computeDigestStats(rows as DigestRow[], weekStart, weekEnd);
  await notify(formatDigestMessage(stats));
  logger.info(`[weekly-digest] Sent: ${stats.scanned} scanned, ${stats.submitted} submitted, ${stats.hires} hires`);
  return stats;
}
