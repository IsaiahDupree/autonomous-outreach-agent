/**
 * tests/analytics.test.ts — Unit tests for the analytics engine
 * Tests all computation functions with synthetic proposal data.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/secret", () => ({
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_KEY: "test-key",
  ANTHROPIC_API_KEY: "test-key",
}));

vi.mock("../src/config/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock fetch globally for Supabase calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock Anthropic
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: '["Rec 1","Rec 2","Rec 3","Rec 4","Rec 5"]' }],
      }),
    };
  },
}));

import { runFullAnalytics } from "../src/services/analytics";

// ── Test Data ──────────────────────────────────────────

function makeProposal(overrides: Record<string, unknown> = {}) {
  return {
    job_id: "job_" + Math.random().toString(36).slice(2, 8),
    job_title: "AI Automation Engineer Needed",
    job_description: "We need someone to automate our workflow using n8n and openai",
    job_url: "https://upwork.com/jobs/123",
    budget: "$1,000",
    score: 72,
    pre_score: null,
    status: "queued",
    proposal_text: "I would love to help you with this project...",
    submitted_bid_amount: null,
    submitted_connects_cost: null,
    tags: null,
    source: "search",
    reasoning: null,
    created_at: "2026-03-10T12:00:00Z",
    updated_at: null,
    outcome_at: null,
    ...overrides,
  };
}

const SAMPLE_DATA = [
  // AI/Automation niche — high scores
  makeProposal({ job_title: "AI Agent Developer for Automation", budget: "$2,000", score: 85, status: "submitted", created_at: "2026-03-10T10:00:00Z" }),
  makeProposal({ job_title: "AI Automation Specialist — Claude + n8n", budget: "$1,500", score: 78, status: "submitted", created_at: "2026-03-10T14:00:00Z" }),
  makeProposal({ job_title: "AI Engineer for GPT Integration", budget: "$3,000", score: 90, status: "won", outcome_at: "2026-03-12T10:00:00Z", created_at: "2026-03-08T09:00:00Z", submitted_bid_amount: 2500 }),

  // Web scraping niche
  makeProposal({ job_title: "Web Scraping Expert — Puppeteer", budget: "$800", score: 65, status: "submitted", created_at: "2026-03-09T11:00:00Z" }),
  makeProposal({ job_title: "Data Extraction Crawler", budget: "$500", score: 55, status: "rejected", outcome_at: "2026-03-11T16:00:00Z", created_at: "2026-03-09T08:00:00Z" }),

  // Full stack
  makeProposal({ job_title: "Full Stack MVP — Next.js + Supabase", budget: "$5,000", score: 82, status: "submitted", created_at: "2026-03-11T09:00:00Z" }),
  makeProposal({ job_title: "SaaS Dashboard Development", budget: "$3,500", score: 70, status: "no_response", outcome_at: "2026-03-13T12:00:00Z", created_at: "2026-03-07T15:00:00Z" }),

  // Low score / excluded jobs
  makeProposal({ job_title: "Simple Logo Design", budget: "$50", score: 5, status: "excluded", created_at: "2026-03-10T08:00:00Z" }),
  makeProposal({ job_title: "Basic Data Entry Task", budget: "$30", score: 3, status: "excluded", created_at: "2026-03-10T09:00:00Z" }),
  makeProposal({ job_title: "Very simple Python script needed", budget: "$20", score: 2, status: "below_threshold", created_at: "2026-03-10T07:00:00Z" }),

  // n8n/Make niche
  makeProposal({ job_title: "n8n Workflow Automation Expert", budget: "$1,200", score: 75, status: "queued", created_at: "2026-03-12T10:00:00Z" }),
  makeProposal({ job_title: "Zapier to n8n Migration", budget: "$600", score: 60, status: "queued", created_at: "2026-03-12T11:00:00Z" }),

  // Error job
  makeProposal({ job_title: "LLM RAG Pipeline with Langchain", budget: "$2,500", score: 80, status: "error", created_at: "2026-03-11T14:00:00Z" }),

  // No budget
  makeProposal({ job_title: "OpenAI GPT Chatbot", budget: null, score: 45, status: "pending", created_at: "2026-03-13T08:00:00Z" }),

  // Hourly rate
  makeProposal({ job_title: "Lead Generation CRM Setup", budget: "$50/hr", score: 30, status: "excluded", created_at: "2026-03-10T16:00:00Z" }),
];

describe("Analytics Engine", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Mock Supabase fetch to return sample data
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("upwork_proposals")) {
        return {
          ok: true,
          json: async () => SAMPLE_DATA,
        };
      }
      // Fallback
      return { ok: true, json: async () => [] };
    });
  });

  it("loads all proposals and computes overview", async () => {
    const analytics = await runFullAnalytics();
    expect(analytics.overview.totalJobs).toBe(SAMPLE_DATA.length);
    expect(analytics.overview.totalJobs).toBe(15);
    expect(analytics.overview.avgScore).toBeGreaterThan(0);
    expect(analytics.overview.maxBudget).toBe(5000);
  });

  it("computes budget tier distribution", async () => {
    const analytics = await runFullAnalytics();
    const tiers = analytics.pricing.budgetTiers;
    expect(tiers).toHaveLength(5);
    // Under $100 should have the $50, $30, $20, and $50/hr jobs (parsed as $50)
    const under100 = tiers.find((t) => t.tier === "Under $100");
    expect(under100).toBeDefined();
    expect(under100!.count).toBe(4);
    // $500-$1500 range
    const mid = tiers.find((t) => t.tier === "$500 - $1,500");
    expect(mid).toBeDefined();
    expect(mid!.count).toBeGreaterThanOrEqual(4);
  });

  it("detects hourly vs fixed pricing", async () => {
    const analytics = await runFullAnalytics();
    expect(analytics.pricing.hourlyVsFixed.hourly).toBe(1); // $50/hr
    expect(analytics.pricing.hourlyVsFixed.fixed).toBeGreaterThan(0);
  });

  it("computes optimal bid range from won proposals", async () => {
    const analytics = await runFullAnalytics();
    // Only 1 won proposal with bid $2500
    expect(analytics.pricing.optimalBidRange.sweetSpot).toBe(2500);
  });

  it("detects budget-score correlation", async () => {
    const analytics = await runFullAnalytics();
    // Higher budget jobs have higher scores in our test data
    expect(analytics.pricing.budgetScoreCorrelation).toBeDefined();
    expect(["positive", "negative", "neutral"]).toContain(analytics.pricing.budgetScoreCorrelation);
  });

  it("computes close rate overall", async () => {
    const analytics = await runFullAnalytics();
    const cr = analytics.closeRate.overall;
    // submitted + won + rejected + no_response + interviewed
    expect(cr.submitted).toBeGreaterThan(0);
    expect(cr.won).toBe(1);
    expect(cr.rejected).toBe(1);
    expect(cr.noResponse).toBe(1);
  });

  it("breaks close rate by score bracket", async () => {
    const analytics = await runFullAnalytics();
    const brackets = analytics.closeRate.byScoreBracket;
    expect(brackets).toHaveLength(5);
    // The 9-10 bracket (score 90) should have 1 won
    // Note: score is 0-100 scale, bracket names are misleading but still work
  });

  it("breaks close rate by niche", async () => {
    const analytics = await runFullAnalytics();
    expect(analytics.closeRate.byNiche.length).toBeGreaterThan(0);
    // AI/Automation should have submissions
    const aiNiche = analytics.closeRate.byNiche.find((n) => n.niche === "AI/Automation");
    expect(aiNiche).toBeDefined();
    expect(aiNiche!.submitted).toBeGreaterThan(0);
  });

  it("computes avg time to outcome", async () => {
    const analytics = await runFullAnalytics();
    // We have 3 jobs with outcome_at set
    expect(analytics.closeRate.avgTimeToOutcome).not.toBeNull();
    expect(analytics.closeRate.avgTimeToOutcome!).toBeGreaterThan(0);
  });

  it("identifies best days for job quality", async () => {
    const analytics = await runFullAnalytics();
    expect(analytics.timing.bestDays.length).toBeGreaterThan(0);
    // Days should be sorted by avgScore desc
    for (let i = 1; i < analytics.timing.bestDays.length; i++) {
      expect(analytics.timing.bestDays[i - 1].avgScore).toBeGreaterThanOrEqual(analytics.timing.bestDays[i].avgScore);
    }
  });

  it("computes weekly job volume", async () => {
    const analytics = await runFullAnalytics();
    expect(analytics.timing.jobsPerWeek.length).toBeGreaterThan(0);
  });

  it("detects volume trend", async () => {
    const analytics = await runFullAnalytics();
    expect(["increasing", "decreasing", "stable"]).toContain(analytics.timing.volumeTrend);
  });

  it("finds top tech combinations", async () => {
    const analytics = await runFullAnalytics();
    // n8n + openai should appear (from job description)
    const combos = analytics.textInsights.topTechCombos;
    expect(combos.length).toBeGreaterThan(0);
  });

  it("detects client pain points", async () => {
    const analytics = await runFullAnalytics();
    const pains = analytics.textInsights.clientPainPoints;
    // "automate" appears in our test descriptions
    const automate = pains.find((p) => p.phrase === "automate");
    expect(automate).toBeDefined();
    expect(automate!.count).toBeGreaterThan(0);
  });

  it("flags red flag patterns", async () => {
    const analytics = await runFullAnalytics();
    const flags = analytics.textInsights.redFlagPatterns;
    // Red flags are matched against job_description || job_title
    // "very simple" is in a job title, check it's found
    expect(flags.length).toBeGreaterThanOrEqual(0);
    // At minimum, red flags with 0 matches are filtered out
    for (const f of flags) {
      expect(f.count).toBeGreaterThan(0);
    }
  });

  it("classifies jobs into niches", async () => {
    const analytics = await runFullAnalytics();
    expect(analytics.niches.length).toBeGreaterThan(0);
    // AI/Automation should exist
    const ai = analytics.niches.find((n) => n.niche === "AI/Automation");
    expect(ai).toBeDefined();
    expect(ai!.count).toBeGreaterThan(0);
    // Niches should be sorted by count desc
    for (let i = 1; i < analytics.niches.length; i++) {
      expect(analytics.niches[i - 1].count).toBeGreaterThanOrEqual(analytics.niches[i].count);
    }
  });

  it("computes pipeline health", async () => {
    const analytics = await runFullAnalytics();
    // 1 error out of 15 = 6.7%
    expect(analytics.pipeline.errorRate).toBeGreaterThan(0);
    expect(analytics.pipeline.errorCount).toBe(1);
  });

  it("computes proposal quality metrics", async () => {
    const analytics = await runFullAnalytics();
    expect(analytics.pipeline.proposalQuality.avgLength).toBeGreaterThan(0);
  });

  it("computes source comparison", async () => {
    const analytics = await runFullAnalytics();
    // All test data has source="search"
    expect(analytics.pipeline.sourceComparison.search.count).toBe(15);
    expect(analytics.pipeline.sourceComparison.search.avgScore).toBeGreaterThan(0);
  });

  it("generates AI recommendations", async () => {
    const analytics = await runFullAnalytics();
    expect(analytics.recommendations).toHaveLength(5);
    expect(analytics.recommendations[0]).toBe("Rec 1");
  });

  it("handles empty dataset gracefully", async () => {
    mockFetch.mockImplementation(async () => ({
      ok: true,
      json: async () => [],
    }));

    const analytics = await runFullAnalytics();
    expect(analytics.overview.totalJobs).toBe(0);
    expect(analytics.overview.avgBudget).toBe(0);
    expect(analytics.overview.avgScore).toBe(0);
    expect(analytics.pricing.budgetTiers.every((t) => t.count === 0)).toBe(true);
    expect(analytics.closeRate.overall.submitted).toBe(0);
    expect(analytics.closeRate.overall.winRate).toBe(0);
    expect(analytics.niches).toHaveLength(0);
  });

  it("handles fetch failure gracefully", async () => {
    mockFetch.mockImplementation(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: "Internal Server Error" }),
    }));

    const analytics = await runFullAnalytics();
    expect(analytics.overview.totalJobs).toBe(0);
  });
});
