/**
 * tests/cloud.test.ts — Unit tests for cloud service helpers
 * Tests filter building, status counting, and data transformations.
 * Does NOT hit real Supabase — uses mocked fetch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fetch globally before importing the module
const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

// Mock the secret module to avoid env dependency
vi.mock("../src/secret", () => ({
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_KEY: "test-key",
  CRMLITE_URL: "",
  CRMLITE_API_KEY: "",
}));

// Mock logger
vi.mock("../src/config/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import * as cloud from "../src/services/cloud";

beforeEach(() => {
  mockFetch.mockReset();
});

describe("saveProposal", () => {
  it("sends POST with correct body structure", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 201 });

    const ok = await cloud.saveProposal({
      jobId: "abc123",
      title: "AI Bot Builder",
      url: "https://upwork.com/jobs/abc123",
      score: 8,
      bid: 1500,
      coverLetter: "I can build this.",
      status: "queued",
    });

    expect(ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("/rest/v1/upwork_proposals");
    expect(opts.method).toBe("POST");

    const body = JSON.parse(opts.body);
    expect(body.job_id).toBe("abc123");
    expect(body.job_title).toBe("AI Bot Builder");
    expect(body.score).toBe(8);
    expect(body.submitted_bid_amount).toBe(1500);
    expect(body.proposal_text).toBe("I can build this.");
    expect(body.status).toBe("queued");
  });

  it("falls back to PATCH on 409 conflict", async () => {
    // First call returns 409, second is the PATCH
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 409 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const ok = await cloud.saveProposal({
      jobId: "dup123",
      title: "Duplicate Job",
      url: "https://upwork.com/jobs/dup123",
      score: 7,
    });

    expect(ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const [patchUrl, patchOpts] = mockFetch.mock.calls[1];
    expect(patchUrl).toContain("job_id=eq.dup123");
    expect(patchOpts.method).toBe("PATCH");
  });

  it("returns false on network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const ok = await cloud.saveProposal({
      jobId: "fail123",
      title: "Failing Job",
      url: "https://upwork.com/jobs/fail123",
      score: 5,
    });

    expect(ok).toBe(false);
  });
});

describe("proposalExists", () => {
  it("returns true when rows found", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ id: 1 }],
    });

    const exists = await cloud.proposalExists("abc123");
    expect(exists).toBe(true);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("job_id=eq.abc123");
    expect(url).toContain("select=id");
    expect(url).toContain("limit=1");
  });

  it("returns false when no rows", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    const exists = await cloud.proposalExists("missing123");
    expect(exists).toBe(false);
  });

  it("returns false on error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("timeout"));
    const exists = await cloud.proposalExists("error123");
    expect(exists).toBe(false);
  });
});

describe("getProposalsByFilter", () => {
  it("builds correct query params for single status", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ job_id: "j1", score: 8 }],
    });

    await cloud.getProposalsByFilter({ status: "queued", minScore: 7 });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("status=eq.queued");
    expect(url).toContain("score=gte.7");
    expect(url).toContain("order=score.desc");
  });

  it("builds correct query params for multiple statuses", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    await cloud.getProposalsByFilter({ status: ["queued", "error"], limit: 10 });

    const [url] = mockFetch.mock.calls[0];
    // URLSearchParams encodes parens: ( → %28, ) → %29, , → %2C
    expect(url).toContain("status=in.");
    expect(url).toContain("queued");
    expect(url).toContain("error");
    expect(url).toContain("limit=10");
  });

  it("builds correct query for jobId filter", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ job_id: "specific123" }],
    });

    await cloud.getProposalsByFilter({ jobId: "specific123" });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("job_id=eq.specific123");
  });

  it("returns empty array on error", async () => {
    // safeFetch retries on 500, so mock all attempts
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    const results = await cloud.getProposalsByFilter({ status: "queued" });
    expect(results).toEqual([]);
  });
});

describe("getStatusCounts", () => {
  it("correctly counts statuses", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { status: "queued" },
        { status: "queued" },
        { status: "submitted" },
        { status: "error" },
        { status: "submitted" },
        { status: "submitted" },
      ],
    });

    const counts = await cloud.getStatusCounts();
    expect(counts.queued).toBe(2);
    expect(counts.submitted).toBe(3);
    expect(counts.error).toBe(1);
  });

  it("returns empty object on error", async () => {
    // safeFetch retries on 500, so mock all attempts
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    const counts = await cloud.getStatusCounts();
    expect(counts).toEqual({});
  });
});

describe("getProposalMetrics", () => {
  it("correctly computes metrics", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { status: "submitted", score: 8 },
        { status: "won", score: 9 },
        { status: "rejected", score: 6 },
        { status: "no_response", score: 7 },
        { status: "submitted", score: 8 },
      ],
    });

    const metrics = await cloud.getProposalMetrics();
    expect(metrics.submitted).toBe(5);
    expect(metrics.won).toBe(1);
    expect(metrics.rejected).toBe(1);
    expect(metrics.noResponse).toBe(1);
    expect(metrics.avgScore).toBe(7.6);
  });

  it("handles zero submissions", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    const metrics = await cloud.getProposalMetrics();
    expect(metrics.submitted).toBe(0);
    expect(metrics.avgScore).toBe(0);
  });
});
