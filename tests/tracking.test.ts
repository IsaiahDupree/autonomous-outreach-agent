/**
 * tests/tracking.test.ts — unit tests for short-link tracking service.
 * Mocks Supabase fetch; verifies createTrackedLink / resolveSlug / recordClick / getClickStats.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

vi.mock("../src/secret", () => ({
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_KEY: "test-key",
  TRACKING_BASE_URL: "https://outreach.test",
}));

vi.mock("../src/config/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import * as tracking from "../src/services/tracking";

beforeEach(() => {
  mockFetch.mockReset();
});

describe("createTrackedLink", () => {
  it("returns a /r/<slug> URL with the configured base", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 201 });

    const result = await tracking.createTrackedLink(
      "https://example.com/portfolio?utm_campaign=ai",
      { jobId: "job-1", niche: "ai", label: "portfolio" },
      "portfolio"
    );

    expect(result).toMatch(/^https:\/\/outreach\.test\/r\/[A-Za-z0-9_-]{8}$/);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("/rest/v1/tracked_links");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body as string);
    expect(body.target_url).toBe("https://example.com/portfolio?utm_campaign=ai");
    expect(body.link_type).toBe("portfolio");
    expect(body.job_id).toBe("job-1");
    expect(body.niche).toBe("ai");
    expect(body.label).toBe("portfolio");
    expect(body.slug).toMatch(/^[A-Za-z0-9_-]{8}$/);
  });

  it("falls back to the raw URL when Supabase rejects the insert", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const result = await tracking.createTrackedLink(
      "https://example.com/portfolio",
      { jobId: "job-1" },
      "portfolio"
    );

    expect(result).toBe("https://example.com/portfolio");
  });

  it("falls back to the raw URL when fetch throws", async () => {
    mockFetch.mockRejectedValue(new Error("network down"));

    const result = await tracking.createTrackedLink(
      "https://example.com/portfolio",
      {},
      "portfolio"
    );

    expect(result).toBe("https://example.com/portfolio");
  });

  it("returns the raw URL unchanged when target is empty", async () => {
    const result = await tracking.createTrackedLink("", { jobId: "job-1" }, "portfolio");
    expect(result).toBe("");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("resolveSlug", () => {
  it("returns the target_url for a valid slug", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{ target_url: "https://example.com/portfolio" }]),
    });

    const target = await tracking.resolveSlug("abc12xyz");
    expect(target).toBe("https://example.com/portfolio");
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("slug=eq.abc12xyz");
  });

  it("returns null when the slug is unknown", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    });
    const target = await tracking.resolveSlug("missing");
    expect(target).toBeNull();
  });

  it("returns null on fetch error", async () => {
    mockFetch.mockRejectedValue(new Error("timeout"));
    const target = await tracking.resolveSlug("abc12xyz");
    expect(target).toBeNull();
  });
});

describe("recordClick", () => {
  it("posts a click row with ip / user_agent / referer", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 201 });

    await tracking.recordClick("abc12xyz", {
      ip: "127.0.0.1",
      userAgent: "test-agent",
      referer: "https://upwork.com/job/x",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("/rest/v1/link_clicks");
    const body = JSON.parse(opts.body as string);
    expect(body.slug).toBe("abc12xyz");
    expect(body.ip).toBe("127.0.0.1");
    expect(body.user_agent).toBe("test-agent");
    expect(body.referer).toBe("https://upwork.com/job/x");
  });

  it("never throws on fetch failure", async () => {
    mockFetch.mockRejectedValue(new Error("supabase down"));
    await expect(tracking.recordClick("abc", {})).resolves.toBeUndefined();
  });
});

describe("getClickStats", () => {
  it("returns rows from the tracked_links_with_clicks view", async () => {
    const rows = [
      { slug: "a", target_url: "https://x", link_type: "portfolio", job_id: "j1", niche: "ai", label: null, created_at: "2026-04-25", click_count: 3, last_clicked_at: "2026-04-25" },
    ];
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(rows) });

    const result = await tracking.getClickStats("j1");
    expect(result).toEqual(rows);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("tracked_links_with_clicks");
    expect(url).toContain("job_id=eq.j1");
  });

  it("returns an empty array on fetch failure", async () => {
    mockFetch.mockRejectedValue(new Error("down"));
    const result = await tracking.getClickStats();
    expect(result).toEqual([]);
  });
});
