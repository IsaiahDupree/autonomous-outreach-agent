/**
 * tests/api.test.ts — Integration tests for REST API routes
 * Tests endpoint responses with mocked cloud layer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all external dependencies
vi.mock("../src/secret", () => ({
  SAFARI_UPWORK_PORT: 3001,
  SAFARI_LINKEDIN_PORT: 3002,
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_KEY: "test-key",
  CRMLITE_URL: "",
  CRMLITE_API_KEY: "",
  PORT: 3000,
  BROWSER_MODE: "puppeteer",
  ANTHROPIC_API_KEY: "test-key",
  AUTO_SEND: false,
  AUTO_SEND_MIN_SCORE: 8,
  TELEGRAM_BOT_TOKEN: "",
  TELEGRAM_CHAT_ID: "",
}));

vi.mock("../src/config/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/services/cloud", () => ({
  checkService: vi.fn().mockResolvedValue(false),
  getPendingProposals: vi.fn().mockResolvedValue([]),
  getProposalsByFilter: vi.fn().mockResolvedValue([]),
  getStatusCounts: vi.fn().mockResolvedValue({ queued: 5, submitted: 3 }),
  saveProposal: vi.fn().mockResolvedValue(true),
  updateProposalStatus: vi.fn().mockResolvedValue(undefined),
  recordOutcome: vi.fn().mockResolvedValue(undefined),
  getProposalMetrics: vi.fn().mockResolvedValue({
    submitted: 10, won: 2, rejected: 3, noResponse: 5, avgScore: 7.5,
  }),
}));

vi.mock("../src/client/Chrome", () => ({
  checkCDP: vi.fn().mockResolvedValue(true),
}));

vi.mock("../src/browser/upwork", () => ({
  getConnectsRemaining: vi.fn().mockReturnValue(84),
}));

vi.mock("../src/client/Upwork", () => ({
  submitProposal: vi.fn().mockResolvedValue(true),
  buildProposal: vi.fn().mockResolvedValue({ coverLetter: "test" }),
  getCloseRateMetrics: vi.fn().mockResolvedValue({
    submitted: 10, won: 2, rejected: 3, noResponse: 5, closeRate: 20, avgScore: 7.5,
  }),
}));

vi.mock("../src/services/youtube-ideas", () => ({
  analyzeNiches: vi.fn().mockResolvedValue([
    { category: "ai_agent", label: "AI Agent", jobCount: 24, avgBudget: 800, maxBudget: 5000, budgetRange: "$200 - $5,000", avgScore: 7.5, exampleJobs: [{ jobId: "j1", title: "AI Agent Dev", budget: "$800", score: 8, url: "https://upwork.com/j1" }] },
  ]),
  generateMarketReport: vi.fn().mockResolvedValue("Welcome to What People Want from AI..."),
  runContentIdeaPipeline: vi.fn().mockResolvedValue({ analyzed: 3, generated: 3, saved: 3, ideas: [{ title: "Build an AI Agent", category: "AI Agent", score: 8.5, jobCount: 24 }] }),
}));

vi.mock("../src/services/analytics", () => ({
  runFullAnalytics: vi.fn().mockResolvedValue({
    overview: { totalJobs: 100, totalBudget: 150000, avgBudget: 1500, maxBudget: 10000, avgScore: 6.8, scoreDistribution: { "9-10": 10, "7-8": 20 }, statusBreakdown: { submitted: 15, queued: 30 }, dateRange: { first: "2026-03-01", last: "2026-03-13" } },
    pricing: { budgetTiers: [], hourlyVsFixed: { hourly: 5, fixed: 80, unclear: 15 }, optimalBidRange: { min: 500, max: 3000, sweetSpot: 1500 }, budgetScoreCorrelation: "positive" },
    closeRate: { overall: { submitted: 15, won: 3, rejected: 4, noResponse: 8, interviewed: 1, winRate: 19 }, byScoreBracket: [], byNiche: [], avgTimeToOutcome: 4.5 },
    timing: { bestDays: [{ day: "Monday", avgScore: 7.2, count: 20 }], jobsPerWeek: [], volumeTrend: "increasing" },
    textInsights: { topTechCombos: [], clientPainPoints: [], redFlagPatterns: [], topSkillTags: [] },
    pipeline: { errorRate: 2.1, errorCount: 3, sourceComparison: { search: { count: 80, avgScore: 6.5 }, bestMatches: { count: 20, avgScore: 7.8 } }, avgScoreTrend: [], proposalQuality: { avgLength: 1200, avgLengthWon: 1500, avgLengthLost: 1000 } },
    niches: [{ niche: "AI/Automation", count: 30, avgScore: 7.5, avgBudget: 1800, winRate: 25, submitted: 8, won: 2 }],
    recommendations: ["Focus on AI/Automation niche", "Bid on Mondays", "Raise rates to $2K+", "Add portfolio demos", "Track outcomes weekly"],
  }),
  generateAnalyticsReport: vi.fn().mockResolvedValue("Welcome to What People Want from AI, episode 2..."),
}));

import router from "../src/routes/api";
import express from "express";
import { getConnectsRemaining } from "../src/browser/upwork";
import * as cloud from "../src/services/cloud";

// Create a mini express app for testing
function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  return app;
}

// Simple request helper (no supertest dependency needed)
async function request(app: express.Express, method: string, path: string, body?: unknown) {
  return new Promise<{ status: number; body: unknown }>((resolve) => {
    const server = app.listen(0, async () => {
      const addr = server.address() as { port: number };
      const url = `http://127.0.0.1:${addr.port}${path}`;
      try {
        const res = await fetch(url, {
          method,
          headers: body ? { "Content-Type": "application/json" } : {},
          body: body ? JSON.stringify(body) : undefined,
        });
        const json = await res.json().catch(() => null);
        resolve({ status: res.status, body: json });
      } finally {
        server.close();
      }
    });
  });
}

describe("GET /api/connects", () => {
  it("returns current connects balance", async () => {
    const app = createApp();
    const res = await request(app, "GET", "/api/connects");
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).connects).toBe(84);
    expect((res.body as Record<string, unknown>).warning).toBeNull();
  });
});

describe("GET /api/metrics", () => {
  it("returns close rate metrics", async () => {
    const app = createApp();
    const res = await request(app, "GET", "/api/metrics");
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.submitted).toBe(10);
    expect(body.won).toBe(2);
    expect(body.closeRate).toBe(20);
  });
});

describe("GET /api/upwork/proposals", () => {
  it("returns pending proposals", async () => {
    const app = createApp();
    const res = await request(app, "GET", "/api/upwork/proposals");
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.count).toBe(0);
    expect(body.proposals).toEqual([]);
  });
});

describe("POST /api/upwork/outcome", () => {
  it("rejects missing jobId", async () => {
    const app = createApp();
    const res = await request(app, "POST", "/api/upwork/outcome", { outcome: "won" });
    expect(res.status).toBe(400);
  });

  it("rejects invalid outcome", async () => {
    const app = createApp();
    const res = await request(app, "POST", "/api/upwork/outcome", { jobId: "abc", outcome: "invalid" });
    expect(res.status).toBe(400);
  });

  it("records valid outcome", async () => {
    const app = createApp();
    const res = await request(app, "POST", "/api/upwork/outcome", { jobId: "abc123", outcome: "won" });
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).ok).toBe(true);
    expect(cloud.recordOutcome).toHaveBeenCalledWith("abc123", "won");
  });
});

describe("POST /api/upwork/dry-run", () => {
  it("rejects missing jobId", async () => {
    const app = createApp();
    const res = await request(app, "POST", "/api/upwork/dry-run", {});
    expect(res.status).toBe(400);
  });
});

describe("GET /api/upwork/status", () => {
  it("returns status dashboard", async () => {
    const app = createApp();
    const res = await request(app, "GET", "/api/upwork/status");
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.counts).toEqual({ queued: 5, submitted: 3 });
    expect(body.total).toBe(8);
  });
});

// ── Health endpoint ──

describe("GET /api/health", () => {
  it("returns service status", async () => {
    const app = createApp();
    const res = await request(app, "GET", "/api/health");
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.services).toBeDefined();
    expect(body.timestamp).toBeDefined();
  });
});

// ── Manual triggers ──

describe("POST /api/upwork/scan", () => {
  it("acknowledges scan trigger", async () => {
    const app = createApp();
    const res = await request(app, "POST", "/api/upwork/scan");
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).ok).toBe(true);
  });
});

describe("POST /api/chrome/discover", () => {
  it("acknowledges chrome discovery trigger", async () => {
    const app = createApp();
    const res = await request(app, "POST", "/api/chrome/discover");
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).ok).toBe(true);
  });
});

// ── Submit endpoints ──

describe("POST /api/upwork/submit", () => {
  it("rejects missing jobId", async () => {
    const app = createApp();
    const res = await request(app, "POST", "/api/upwork/submit", {});
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown job", async () => {
    const app = createApp();
    const res = await request(app, "POST", "/api/upwork/submit", { jobId: "nonexistent" });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/upwork/submit-batch", () => {
  it("returns empty when no jobs match", async () => {
    const app = createApp();
    const res = await request(app, "POST", "/api/upwork/submit-batch", { minScore: 9 });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.count).toBe(0);
  });
});

// ── Dry-run batch ──

describe("POST /api/upwork/dry-run-batch", () => {
  it("returns empty when no jobs match", async () => {
    const app = createApp();
    const res = await request(app, "POST", "/api/upwork/dry-run-batch", { minScore: 10 });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.results).toEqual([]);
  });
});

// ── YouTube endpoints ──

describe("GET /api/youtube/ideas", () => {
  it("returns niche analysis", async () => {
    const app = createApp();
    const res = await request(app, "GET", "/api/youtube/ideas");
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.niches).toBe(1);
    expect((body.data as unknown[]).length).toBe(1);
  });
});

describe("GET /api/youtube/report", () => {
  it("returns market analysis report", async () => {
    const app = createApp();
    const res = await request(app, "GET", "/api/youtube/report");
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.report).toContain("What People Want from AI");
    expect(body.totalJobs).toBe(24);
  });
});

describe("POST /api/youtube/generate", () => {
  it("runs content idea pipeline", async () => {
    const app = createApp();
    const res = await request(app, "POST", "/api/youtube/generate");
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.analyzed).toBe(3);
    expect(body.generated).toBe(3);
    expect(body.saved).toBe(3);
    expect((body.ideas as unknown[]).length).toBe(1);
  });
});

// ── Analytics endpoints ──

describe("GET /api/analytics", () => {
  it("returns full analytics dashboard", async () => {
    const app = createApp();
    const res = await request(app, "GET", "/api/analytics");
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect((body.overview as Record<string, unknown>).totalJobs).toBe(100);
    expect((body.pricing as Record<string, unknown>).budgetScoreCorrelation).toBe("positive");
    expect(((body.closeRate as Record<string, unknown>).overall as Record<string, unknown>).winRate).toBe(19);
    expect((body.niches as unknown[]).length).toBe(1);
    expect((body.recommendations as string[]).length).toBe(5);
  });
});

describe("GET /api/analytics/report", () => {
  it("returns analytics with narrated report", async () => {
    const app = createApp();
    const res = await request(app, "GET", "/api/analytics/report");
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.report).toContain("What People Want from AI");
    expect((body.overview as Record<string, unknown>).totalJobs).toBe(100);
  });
});
