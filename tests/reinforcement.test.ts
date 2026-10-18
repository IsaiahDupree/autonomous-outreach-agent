/**
 * tests/reinforcement.test.ts — outcome → niche-stats reinforcement loop.
 *
 * Verifies grouping by tag, win-rate math, slot-frequency extraction, min-sample threshold,
 * and pickNicheForJob's tie-breaking.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

vi.mock("../src/secret", () => ({
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_KEY: "test-key",
  CRMLITE_URL: "",
  CRMLITE_API_KEY: "",
}));

vi.mock("../src/config/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import * as reinforcement from "../src/services/reinforcement";

beforeEach(() => {
  mockFetch.mockReset();
});

function mockOutcomes(rows: Array<{ status: string; tags: string[]; bid?: number; slots?: Record<string, string>; score?: number }>) {
  // The fetchOutcomedProposals helper makes 4 calls (won, rejected, no_response, interviewed)
  // — we serve them in that order.
  const buckets: Record<string, typeof rows> = { won: [], rejected: [], no_response: [], interviewed: [] };
  for (const r of rows) {
    if (buckets[r.status]) buckets[r.status].push(r);
  }
  for (const status of ["won", "rejected", "no_response", "interviewed"]) {
    const slice = buckets[status].map((r, i) => ({
      job_id: `${status}-${i}`,
      status: r.status,
      tags: r.tags,
      submitted_bid_amount: r.bid,
      proposal_slots_json: r.slots,
      score: r.score,
    }));
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(slice) });
  }
}

describe("computeNichePerformance", () => {
  it("skips niches below the minimum sample threshold (5)", async () => {
    mockOutcomes([
      { status: "won", tags: ["python"], bid: 1000 },
      { status: "rejected", tags: ["python"], bid: 800 },
    ]);

    const result = await reinforcement.computeNichePerformance();
    expect(result.updated).toBe(0);
    expect(result.skipped).toBeGreaterThan(0);
  });

  it("upserts a niche once it has enough samples and computes win_rate correctly", async () => {
    mockOutcomes([
      { status: "won", tags: ["ai automation"], bid: 1500, slots: { problem: "x".repeat(40), solution: "y".repeat(100), portfolio: "z".repeat(30), prior_results: "r".repeat(50), cta: "cta line here please" } },
      { status: "won", tags: ["ai automation"], bid: 2000, slots: { problem: "x".repeat(40), solution: "y".repeat(100), portfolio: "z".repeat(30), prior_results: "r".repeat(50), cta: "cta line here please" } },
      { status: "won", tags: ["ai automation"], bid: 1200, slots: { problem: "x".repeat(40), solution: "y".repeat(100), portfolio: "z".repeat(30), prior_results: "r".repeat(50), cta: "cta line here please" } },
      { status: "rejected", tags: ["ai automation"], bid: 800 },
      { status: "no_response", tags: ["ai automation"], bid: 500 },
    ]);
    // The upsert call (5th fetch overall) succeeds.
    mockFetch.mockResolvedValueOnce({ ok: true, status: 201, text: () => Promise.resolve("") });

    const result = await reinforcement.computeNichePerformance();
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(0);

    // Inspect the upsert body — the 5th call.
    const lastCall = mockFetch.mock.calls[4];
    const [, opts] = lastCall;
    const body = JSON.parse(opts.body as string);
    expect(body.niche).toBe("ai automation");
    expect(body.sample_count).toBe(5);
    expect(body.won_count).toBe(3);
    expect(body.lost_count).toBe(1);
    expect(body.no_response_count).toBe(1);
    expect(body.win_rate).toBeCloseTo(0.6, 2);
    expect(body.winning_slot_freq.solution).toBe(1);
    expect(body.winning_slot_freq.problem).toBe(1);
    expect(body.winning_patterns).toContain("Winners consistently include");
  });

  it("groups multi-tag proposals into every matching niche", async () => {
    mockOutcomes([
      { status: "won", tags: ["python", "scraping"] },
      { status: "won", tags: ["python", "scraping"] },
      { status: "won", tags: ["python", "scraping"] },
      { status: "rejected", tags: ["python", "scraping"] },
      { status: "rejected", tags: ["python", "scraping"] },
    ]);
    mockFetch.mockResolvedValue({ ok: true, status: 201, text: () => Promise.resolve("") });

    const result = await reinforcement.computeNichePerformance();
    // Both "python" and "scraping" should each hit threshold.
    expect(result.updated).toBe(2);
  });
});

describe("pickNicheForJob", () => {
  const stats = {
    "ai automation": { niche: "ai automation", win_rate: 0.6, response_rate: 0.7, sample_count: 20, won_count: 12, lost_count: 6, no_response_count: 2, interviewed_count: 0, winning_patterns: null, winning_slot_freq: null, avg_win_bid: 1500, avg_loss_bid: 800, updated_at: "" },
    "python": { niche: "python", win_rate: 0.3, response_rate: 0.4, sample_count: 5, won_count: 1, lost_count: 3, no_response_count: 1, interviewed_count: 0, winning_patterns: null, winning_slot_freq: null, avg_win_bid: null, avg_loss_bid: null, updated_at: "" },
  };

  it("returns the niche with the most outcome data when several tags match", () => {
    const picked = reinforcement.pickNicheForJob(["python", "ai automation"], stats);
    expect(picked?.niche).toBe("ai automation");
  });

  it("returns null when no tags match the cache", () => {
    const picked = reinforcement.pickNicheForJob(["unknown-niche"], stats);
    expect(picked).toBeNull();
  });

  it("is case-insensitive on tag lookup", () => {
    const picked = reinforcement.pickNicheForJob(["AI Automation"], stats);
    expect(picked?.niche).toBe("ai automation");
  });

  it("returns null for empty tags", () => {
    expect(reinforcement.pickNicheForJob(undefined, stats)).toBeNull();
    expect(reinforcement.pickNicheForJob([], stats)).toBeNull();
  });
});

describe("getNichePerformance", () => {
  it("returns the row for the requested niche", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{ niche: "ai automation", win_rate: 0.6, sample_count: 20 }]),
    });
    const row = await reinforcement.getNichePerformance("ai automation");
    expect(row?.niche).toBe("ai automation");
    expect(row?.win_rate).toBe(0.6);
  });

  it("returns null when the niche has no row", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) });
    const row = await reinforcement.getNichePerformance("missing");
    expect(row).toBeNull();
  });
});
