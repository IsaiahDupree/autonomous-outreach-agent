/**
 * tests/supabase.live.test.ts — REAL Supabase round-trip.
 *
 * No fetch mocks. Hits the live project pointed at by SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.
 * Inserts a synthetic row, reads it back, asserts on the schema, then deletes it.
 *
 * Skipped automatically when:
 *   - LIVE_TESTS env var is not "1" (default — keeps `npm test` fast and offline-safe), OR
 *   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are unset.
 *
 * Run with:
 *   LIVE_TESTS=1 npx vitest run tests/supabase.live.test.ts
 */
import { describe, it, expect, beforeAll } from "vitest";

const LIVE = process.env.LIVE_TESTS === "1";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

const describeLive = LIVE && SUPABASE_URL && SUPABASE_KEY ? describe : describe.skip;

const headers = () => ({
  apikey: SUPABASE_KEY!,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
});

const TEST_PREFIX = "live-test-";
const TEST_JOB_ID = `${TEST_PREFIX}${Date.now()}`;

async function deleteIfExists(jobId: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/upwork_proposals?job_id=eq.${encodeURIComponent(jobId)}`, {
    method: "DELETE",
    headers: headers(),
  }).catch(() => {});
}

async function deleteTrackedLink(slug: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/tracked_links?slug=eq.${encodeURIComponent(slug)}`, {
    method: "DELETE",
    headers: headers(),
  }).catch(() => {});
}

describeLive("LIVE Supabase round-trip @ enduxcidzlsjbknxidmx", () => {
  beforeAll(async () => {
    // Cleanup leftovers from previous failed runs.
    await deleteIfExists(TEST_JOB_ID);
  });

  it("inserts a proposal with slots, reads it back, deletes it", async () => {
    // ── Insert ──
    const slots = {
      problem: "Live test problem statement that's long enough to count as present.",
      solution: "Live test solution that exceeds the 80-char floor for the solution slot in qualityCheckSlots.",
      proof: "https://github.com/example/live-test",
      portfolio: "https://example.com/portfolio?live=test",
      prior_results: "Live test prior result reference, also long enough to satisfy minChars.",
      cta: "Live test CTA — Best, Isaiah",
    };

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/upwork_proposals`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        job_id: TEST_JOB_ID,
        job_title: "Live test proposal — safe to delete",
        job_url: `https://www.upwork.com/jobs/~${TEST_JOB_ID}`,
        score: 8,
        proposal_text: "live test cover letter",
        proposal_slots_json: slots,
        status: "queued",
        tags: ["live-test", "automated"],
      }),
    });
    expect(insertRes.ok, `insert failed (${insertRes.status})`).toBe(true);

    // ── Read back ──
    const readRes = await fetch(
      `${SUPABASE_URL}/rest/v1/upwork_proposals?job_id=eq.${encodeURIComponent(TEST_JOB_ID)}&select=*`,
      { headers: headers() }
    );
    expect(readRes.ok, `read failed (${readRes.status})`).toBe(true);
    const rows = await readRes.json() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row.job_id).toBe(TEST_JOB_ID);
    expect(row.score).toBe(8);
    expect(row.tags).toEqual(["live-test", "automated"]);

    // Most important: the slots survived the JSON round-trip.
    expect(row.proposal_slots_json).toEqual(slots);

    // ── Delete ──
    const delRes = await fetch(
      `${SUPABASE_URL}/rest/v1/upwork_proposals?job_id=eq.${encodeURIComponent(TEST_JOB_ID)}`,
      { method: "DELETE", headers: headers() }
    );
    expect(delRes.ok, `delete failed (${delRes.status})`).toBe(true);

    // ── Confirm gone ──
    const verifyRes = await fetch(
      `${SUPABASE_URL}/rest/v1/upwork_proposals?job_id=eq.${encodeURIComponent(TEST_JOB_ID)}&select=job_id`,
      { headers: headers() }
    );
    const verifyRows = await verifyRes.json();
    expect(verifyRows).toHaveLength(0);
  });

  it("tracked_links + link_clicks foreign-key + click_count view all work", async () => {
    const slug = `t${Date.now().toString(36)}`;

    try {
      // Insert tracked link
      const linkRes = await fetch(`${SUPABASE_URL}/rest/v1/tracked_links`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          slug,
          target_url: "https://example.com/live-test",
          link_type: "portfolio",
          job_id: TEST_JOB_ID,
          niche: "live-test",
          label: "round-trip",
        }),
      });
      expect(linkRes.ok, `tracked_links insert failed (${linkRes.status})`).toBe(true);

      // Insert two clicks
      for (let i = 0; i < 2; i++) {
        const clickRes = await fetch(`${SUPABASE_URL}/rest/v1/link_clicks`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ slug, ip: "127.0.0.1", user_agent: "vitest-live", referer: "test" }),
        });
        expect(clickRes.ok, `link_clicks insert failed (${clickRes.status})`).toBe(true);
      }

      // Read the view
      const viewRes = await fetch(
        `${SUPABASE_URL}/rest/v1/tracked_links_with_clicks?slug=eq.${encodeURIComponent(slug)}&select=*`,
        { headers: headers() }
      );
      expect(viewRes.ok, `view read failed (${viewRes.status})`).toBe(true);
      const viewRows = await viewRes.json() as Array<Record<string, unknown>>;
      expect(viewRows).toHaveLength(1);
      expect(viewRows[0].click_count).toBe(2);
      expect(viewRows[0].last_clicked_at).toBeTruthy();
      expect(viewRows[0].niche).toBe("live-test");
    } finally {
      // Cleanup link (cascades to clicks)
      await deleteTrackedLink(slug);
    }
  });
});
