/**
 * tests/ranking.test.ts — Composite scoring and daily ranking tests
 */
import { describe, it, expect } from "vitest";
import { computeCompositeScore, selectDailyTop5 } from "../src/services/ranking";
import type { RankedJob } from "../src/services/ranking";

describe("Composite Scoring", () => {
  it("should score a high-quality job highly", () => {
    const row = {
      score: 9,
      created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h old
      client_hire_rate: 85,
      payment_verified: true,
      client_hires: 25,
      proposals: 3,
      budget: "Fixed $3,000",
      submitted_connects_cost: 4,
    };
    const score = computeCompositeScore(row);
    expect(score).toBeGreaterThan(70);
  });

  it("should score a low-quality job poorly", () => {
    const row = {
      score: 3,
      created_at: new Date(Date.now() - 60 * 60 * 60 * 1000).toISOString(), // 60h old
      client_hire_rate: 5,
      payment_verified: false,
      client_hires: 0,
      proposals: 80,
      budget: "Fixed $100",
      submitted_connects_cost: 16,
    };
    const score = computeCompositeScore(row);
    expect(score).toBeLessThan(30);
  });

  it("should handle missing fields gracefully", () => {
    const row = { score: 7 };
    const score = computeCompositeScore(row);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("should give recency bonus to fresh jobs", () => {
    const fresh = { score: 7, created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString() };
    const stale = { score: 7, created_at: new Date(Date.now() - 40 * 60 * 60 * 1000).toISOString() };
    expect(computeCompositeScore(fresh)).toBeGreaterThan(computeCompositeScore(stale));
  });

  it("should value verified clients higher", () => {
    const verified = { score: 7, payment_verified: true, client_hire_rate: 50, client_hires: 10 };
    const unverified = { score: 7, payment_verified: false, client_hire_rate: 50, client_hires: 10 };
    expect(computeCompositeScore(verified)).toBeGreaterThan(computeCompositeScore(unverified));
  });

  it("should parse budget strings correctly", () => {
    const highBudget = { score: 7, budget: "Fixed $5,000-10,000" };
    const lowBudget = { score: 7, budget: "Fixed $150" };
    expect(computeCompositeScore(highBudget)).toBeGreaterThan(computeCompositeScore(lowBudget));
  });
});

describe("Daily Top-5 Selection", () => {
  function makeJob(id: string, composite: number, tags: string[] = []): RankedJob {
    return {
      jobId: id,
      title: `Job ${id}`,
      url: `https://upwork.com/jobs/${id}`,
      description: "Test job",
      aiScore: composite / 10,
      compositeScore: composite,
      scheduledSlot: "morning",
      proofEligible: composite >= 80,
      tags,
      raw: {},
    };
  }

  it("should select top 5 from a larger list", () => {
    const ranked = Array.from({ length: 10 }, (_, i) =>
      makeJob(`j${i}`, 90 - i * 5)
    );
    const selected = selectDailyTop5(ranked);
    expect(selected.length).toBe(5);
    expect(selected[0].compositeScore).toBeGreaterThanOrEqual(selected[4].compositeScore);
  });

  it("should return all jobs if fewer than 5", () => {
    const ranked = [makeJob("j1", 80), makeJob("j2", 70)];
    const selected = selectDailyTop5(ranked);
    expect(selected.length).toBe(2);
  });

  it("should assign correct time slots", () => {
    const ranked = Array.from({ length: 5 }, (_, i) =>
      makeJob(`j${i}`, 90 - i * 5)
    );
    const selected = selectDailyTop5(ranked);
    const slots = selected.map(j => j.scheduledSlot);
    expect(slots.filter(s => s === "morning").length).toBe(2);
    expect(slots.filter(s => s === "midday").length).toBe(2);
    expect(slots.filter(s => s === "evening").length).toBe(1);
  });

  it("should enforce niche diversity (max 2 per niche)", () => {
    const ranked = [
      makeJob("j1", 95, ["ai", "llm"]),
      makeJob("j2", 90, ["ai", "gpt"]),
      makeJob("j3", 85, ["ai", "claude"]),
      makeJob("j4", 80, ["python", "django"]),
      makeJob("j5", 75, ["react", "frontend"]),
      makeJob("j6", 70, ["mobile", "flutter"]),
    ];
    const selected = selectDailyTop5(ranked);
    const aiJobs = selected.filter(j => (j.tags || []).some(t => /ai|llm|gpt|claude/.test(t)));
    expect(aiJobs.length).toBeLessThanOrEqual(2);
    expect(selected.length).toBe(5);
  });

  it("should mark high-scoring jobs as proof-eligible", () => {
    const ranked = [
      makeJob("j1", 90, []),
      makeJob("j2", 60, []),
    ];
    const selected = selectDailyTop5(ranked);
    expect(selected[0].proofEligible).toBe(true);
    expect(selected[1].proofEligible).toBe(false);
  });
});
