/**
 * Real-fetch tests for the typed API client. We stub global.fetch and assert that each helper
 * builds the right URL, method, and body — exactly what the agent's Express routes expect.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api, ApiError, scoreClass, SLOT_ORDER } from "../lib/api";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function ok<T>(body: T) {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  };
}

describe("api.listProposals", () => {
  it("requests /api/upwork/proposals with status + limit query params", async () => {
    mockFetch.mockResolvedValueOnce(ok({ count: 0, proposals: [] }));
    await api.listProposals({ status: "queued", limit: 50 });
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/upwork/proposals?status=queued&limit=50");
  });

  it("omits empty params", async () => {
    mockFetch.mockResolvedValueOnce(ok({ count: 0, proposals: [] }));
    await api.listProposals({});
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/upwork/proposals?");
  });
});

describe("api.recordOutcome", () => {
  it("POSTs jobId + outcome as JSON", async () => {
    mockFetch.mockResolvedValueOnce(ok({ ok: true }));
    await api.recordOutcome("job-42", "won");
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/upwork/outcome");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ jobId: "job-42", outcome: "won" });
  });
});

describe("api.dryRun", () => {
  it("POSTs jobId to /api/upwork/dry-run", async () => {
    mockFetch.mockResolvedValueOnce(ok({ ok: true }));
    await api.dryRun("job-77");
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/upwork/dry-run");
    expect(JSON.parse(opts.body)).toEqual({ jobId: "job-77" });
  });
});

describe("api.refreshReinforcement", () => {
  it("POSTs to /api/reinforcement/refresh and returns the parsed body", async () => {
    mockFetch.mockResolvedValueOnce(ok({ ok: true, updated: 3, skipped: 2 }));
    const result = await api.refreshReinforcement();
    expect(result).toEqual({ ok: true, updated: 3, skipped: 2 });
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/reinforcement/refresh");
    expect(opts.method).toBe("POST");
  });
});

describe("error handling", () => {
  it("extracts JSON {error} field as the thrown message", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve(JSON.stringify({ error: "Supabase unreachable" })),
    });
    await expect(api.agentState()).rejects.toThrow(/Supabase unreachable/);
  });

  it("falls back to raw text when body is not JSON", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: () => Promise.resolve("Bad Gateway"),
    });
    await expect(api.agentState()).rejects.toThrow(/Bad Gateway/);
  });

  it("uses HTTP status when body is empty", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: () => Promise.resolve(""),
    });
    await expect(api.agentState()).rejects.toThrow(/HTTP 503/);
  });

  it("ApiError exposes the status code", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: () => Promise.resolve(""),
    });
    try {
      await api.agentState();
      throw new Error("expected ApiError");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(404);
    }
  });
});

describe("scoreClass", () => {
  it("buckets scores into the correct CSS class", () => {
    expect(scoreClass(10)).toBe("s10");
    expect(scoreClass(9)).toBe("s9");
    expect(scoreClass(7)).toBe("s7");
    expect(scoreClass(5)).toBe("s5");
    expect(scoreClass(0)).toBe("s0");
    expect(scoreClass(undefined)).toBe("s0");
  });

  it("clamps out-of-range values", () => {
    expect(scoreClass(15)).toBe("s10");
    expect(scoreClass(-3)).toBe("s0");
    expect(scoreClass(7.4)).toBe("s7");
    expect(scoreClass(7.5)).toBe("s8");
  });
});

describe("SLOT_ORDER", () => {
  it("matches the server-side canonical order", () => {
    expect(SLOT_ORDER).toEqual(["problem", "solution", "proof", "portfolio", "prior_results", "cta"]);
  });
});
