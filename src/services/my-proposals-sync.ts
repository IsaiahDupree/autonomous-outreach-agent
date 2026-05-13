/**
 * src/services/my-proposals-sync.ts — outcome-tracking-001.
 *
 * Weekly job that scrapes Upwork's active "My Proposals" page, maps each
 * row's status (viewed / messaged / hired / declined) onto our outcome
 * vocabulary, and pushes updates back through cloud.recordOutcome — the
 * same code path that backs POST /api/upwork/outcome.
 *
 * Live broker state moves slower than the dashboard cron (15m), so a once-
 * a-week sweep is enough to catch tail-end status flips that the
 * notification stream missed (e.g. silent declines).
 */
import logger from "../config/logger";
import * as cloud from "./cloud";
import type { MyProposalRow } from "../browser/upwork";

type Outcome = "won" | "rejected" | "no_response" | "interviewed";

/**
 * Translate a row-level status to the outcome vocabulary the DB tracks.
 * `viewed` and `submitted`/`unknown` produce no DB write — they aren't
 * terminal and the existing "viewed_at" telemetry handles read receipts.
 */
export function rowStatusToOutcome(status: MyProposalRow["status"]): Outcome | null {
  switch (status) {
    case "hired":    return "won";
    case "declined": return "rejected";
    case "messaged": return "interviewed";
    default:         return null;
  }
}

export interface MyProposalsSyncResult {
  scanned: number;
  updated: number;
  skipped: number;
  unmatched: number;
}

/**
 * Reconcile scraped row statuses against tracked proposals. Only writes
 * updates for rows with a terminal-ish outcome (hired/declined/messaged)
 * and where the existing DB status hasn't already been set to a terminal
 * value — never downgrade a "won" back to "interviewed".
 */
export async function syncMyProposalOutcomes(rows: MyProposalRow[]): Promise<MyProposalsSyncResult> {
  if (rows.length === 0) return { scanned: 0, updated: 0, skipped: 0, unmatched: 0 };

  const tracked = await cloud.getProposalsByFilter({ limit: 500 });
  const TERMINAL = new Set(["won", "rejected", "no_response"]);

  let updated = 0;
  let skipped = 0;
  let unmatched = 0;

  for (const row of rows) {
    const outcome = rowStatusToOutcome(row.status);
    if (!outcome) { skipped++; continue; }

    const titleLower = row.jobTitle.toLowerCase();
    const match = tracked.find((r) => {
      const dbTitle = ((r.job_title as string) || "").toLowerCase();
      if (!dbTitle) return false;
      return dbTitle.includes(titleLower.slice(0, 40)) || titleLower.includes(dbTitle.slice(0, 40));
    });
    if (!match) { unmatched++; continue; }

    const current = (match.status as string) || "";
    // Don't overwrite a binary terminal state with a softer one (e.g. don't
    // flip "won" → "interviewed"). Allow upgrades into terminal states.
    if (TERMINAL.has(current) && !TERMINAL.has(outcome)) { skipped++; continue; }
    if (current === outcome) { skipped++; continue; }

    try {
      await cloud.recordOutcome(match.job_id as string, outcome);
      updated++;
      logger.info(`[MyProposalsSync] ${(match.job_id as string).slice(0, 10)} ${current || "—"} → ${outcome} (${row.status})`);
    } catch (e) {
      logger.warn(`[MyProposalsSync] recordOutcome failed for ${match.job_id}: ${(e as Error).message}`);
    }
  }

  logger.info(`[MyProposalsSync] scanned=${rows.length} updated=${updated} skipped=${skipped} unmatched=${unmatched}`);
  return { scanned: rows.length, updated, skipped, unmatched };
}

/** Top-level entry used by the weekly cron — handles the scrape + sync end-to-end. */
export async function runWeeklyMyProposalsSync(): Promise<MyProposalsSyncResult> {
  const { scrapeMyProposals } = await import("../browser/upwork");
  const rows = await scrapeMyProposals();
  return syncMyProposalOutcomes(rows);
}
