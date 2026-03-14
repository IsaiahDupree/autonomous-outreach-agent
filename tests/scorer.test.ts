/**
 * tests/scorer.test.ts — Unit tests for the deterministic pre-scorer
 * Tests hard excludes, budget floors, ICP matching, proposal limits, and scoring math.
 */
import { describe, it, expect } from "vitest";
import { preScoreJob } from "../src/Agent/scorer";

// ── Hard Excludes ──

describe("preScoreJob — hard excludes", () => {
  it("excludes WordPress jobs", () => {
    const r = preScoreJob({ title: "WordPress site migration", description: "Need help with WordPress" });
    expect(r.excluded).toBe(true);
    expect(r.excludeReason).toContain("wordpress");
  });

  it("excludes Shopify jobs", () => {
    const r = preScoreJob({ title: "Shopify store customization", description: "Custom Shopify theme" });
    expect(r.excluded).toBe(true);
    expect(r.excludeReason).toContain("shopify");
  });

  it("excludes data entry jobs", () => {
    const r = preScoreJob({ title: "Data entry specialist", description: "Simple data entry task" });
    expect(r.excluded).toBe(true);
    expect(r.excludeReason).toContain("data entry");
  });

  it("excludes GIS jobs (regex word boundary)", () => {
    const r = preScoreJob({ title: "GIS mapping developer", description: "Build a GIS dashboard" });
    expect(r.excluded).toBe(true);
    expect(r.excludeReason).toContain("gis");
  });

  it("does NOT exclude 'strategist' (gis false positive)", () => {
    const r = preScoreJob({ title: "AI automation strategist needed", description: "Build an ai automation workflow" });
    expect(r.excluded).toBe(false);
  });

  it("excludes SAP jobs (regex word boundary)", () => {
    const r = preScoreJob({ title: "SAP integration developer", description: "SAP HANA module" });
    expect(r.excluded).toBe(true);
    expect(r.excludeReason).toContain("sap");
  });
});

// ── Budget Floors ──

describe("preScoreJob — budget floors", () => {
  it("excludes hourly rate below $20/hr", () => {
    const r = preScoreJob({
      title: "Python automation script",
      description: "Need a python automation bot",
      budget: "$15/hr",
    });
    expect(r.excluded).toBe(true);
    expect(r.excludeReason).toContain("Budget floor");
  });

  it("allows hourly rate at $25/hr", () => {
    const r = preScoreJob({
      title: "Python automation script",
      description: "Need a python automation bot",
      budget: "$25/hr",
    });
    expect(r.excluded).toBe(false);
  });

  it("excludes fixed price below $200", () => {
    const r = preScoreJob({
      title: "Web scraping task",
      description: "Scrape data from a web scraping site",
      budget: "$100",
    });
    expect(r.excluded).toBe(true);
    expect(r.excludeReason).toContain("Budget floor");
  });

  it("allows fixed price at $500", () => {
    const r = preScoreJob({
      title: "Web scraping project",
      description: "Build a web scraping tool for data extraction",
      budget: "$500",
    });
    expect(r.excluded).toBe(false);
  });
});

// ── Proposal Count Ceiling ──

describe("preScoreJob — proposal count ceiling", () => {
  it("excludes jobs with 50+ proposals", () => {
    const r = preScoreJob({
      title: "AI automation project",
      description: "Build an ai automation workflow",
      proposals: "50 to 100 proposals",
    });
    expect(r.excluded).toBe(true);
    expect(r.excludeReason).toContain("Too many proposals");
  });

  it("allows jobs with 15 to 20 proposals", () => {
    const r = preScoreJob({
      title: "AI automation project",
      description: "Build an ai automation workflow",
      proposals: "15 to 20 proposals",
    });
    expect(r.excluded).toBe(false);
  });

  it("excludes jobs with 50+ format", () => {
    const r = preScoreJob({
      title: "Python automation needed",
      description: "Need python automation for data pipeline",
      proposals: "50+",
    });
    expect(r.excluded).toBe(true);
  });

  it("allows jobs with 20 proposals", () => {
    const r = preScoreJob({
      title: "AI automation developer",
      description: "Build ai automation tool",
      proposals: "20 proposals",
    });
    expect(r.excluded).toBe(false);
  });
});

// ── Client Hire Rate Filter ──

describe("preScoreJob — client hire rate filter", () => {
  it("excludes clients with very low hire rate (< 15%) and 3+ hires", () => {
    const r = preScoreJob({
      title: "AI automation project",
      description: "Build an ai automation workflow",
      clientHireRate: 5,
      clientHires: 10,
    });
    expect(r.excluded).toBe(true);
    expect(r.excludeReason).toContain("Low client hire rate");
  });

  it("allows clients with hire rate >= 15%", () => {
    const r = preScoreJob({
      title: "AI automation project",
      description: "Build an ai automation workflow",
      clientHireRate: 25,
      clientHires: 8,
    });
    expect(r.excluded).toBe(false);
  });

  it("allows new clients with low hire rate (< 3 hires)", () => {
    const r = preScoreJob({
      title: "AI automation project",
      description: "Build an ai automation workflow",
      clientHireRate: 0,
      clientHires: 1,
    });
    expect(r.excluded).toBe(false);
  });

  it("allows jobs without hire rate data", () => {
    const r = preScoreJob({
      title: "AI automation project",
      description: "Build an ai automation workflow",
    });
    expect(r.excluded).toBe(false);
  });
});

// ── ICP Keyword Matching ──

describe("preScoreJob — ICP keyword matching", () => {
  it("excludes jobs with no strong ICP match", () => {
    const r = preScoreJob({
      title: "Accounting software setup",
      description: "Need help configuring QuickBooks for my business",
    });
    expect(r.excluded).toBe(true);
    expect(r.excludeReason).toContain("No ICP strong keyword match");
  });

  it("matches 'ai automation' as strong keyword", () => {
    const r = preScoreJob({
      title: "AI automation engineer",
      description: "Build an ai automation system for our workflow",
    });
    expect(r.excluded).toBe(false);
    expect(r.strongHits).toContain("ai automation");
  });

  it("matches 'web scraping' as strong keyword", () => {
    const r = preScoreJob({
      title: "Web scraping specialist",
      description: "Build a web scraping tool for lead generation",
    });
    expect(r.excluded).toBe(false);
    expect(r.strongHits).toContain("web scraping");
  });

  it("matches 'n8n' as strong keyword", () => {
    const r = preScoreJob({
      title: "n8n workflow builder needed",
      description: "Set up n8n automation workflows for our CRM",
    });
    expect(r.excluded).toBe(false);
    expect(r.strongHits).toContain("n8n");
  });

  it("matches multiple strong keywords and scores higher", () => {
    const r = preScoreJob({
      title: "AI automation + web scraping project",
      description: "Build an ai automation pipeline with web scraping and data extraction",
    });
    expect(r.strongHits.length).toBeGreaterThanOrEqual(2);
    expect(r.score).toBeGreaterThan(20);
  });
});

// ── Scoring Math ──

describe("preScoreJob — scoring math", () => {
  it("caps strong keyword bonus at 60", () => {
    const r = preScoreJob({
      title: "AI automation workflow automation web scraping data extraction n8n zapier",
      description: "Build ai automation with web scraping, data extraction, n8n, zapier, chatbot, llm, gpt, openai integration. Also need api integration, email automation, and lead generation pipeline with data pipeline etl",
    });
    // Even with many strong hits, capped at 60
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.strongHits.length).toBeGreaterThan(3);
  });

  it("adds budget bonus for $1000+", () => {
    const r = preScoreJob({
      title: "Python automation project",
      description: "Build a python automation system for our workflow",
      budget: "$2,000",
    });
    expect(r.budgetBonus).toBeGreaterThanOrEqual(20);
  });

  it("adds budget bonus for $500+", () => {
    const r = preScoreJob({
      title: "AI automation task",
      description: "Need ai automation for our chatbot",
      budget: "$750",
    });
    expect(r.budgetBonus).toBeGreaterThanOrEqual(10);
  });

  it("adds recency bonus for fresh posts", () => {
    const r = preScoreJob({
      title: "Web scraping specialist needed",
      description: "Build a web scraping tool for data extraction",
      posted: "2 hours ago",
    });
    expect(r.recencyBonus).toBe(15);
  });

  it("adds recency bonus for yesterday", () => {
    const r = preScoreJob({
      title: "AI automation developer",
      description: "Build an ai automation system",
      posted: "yesterday",
    });
    expect(r.recencyBonus).toBe(5);
  });

  it("no recency bonus for old posts", () => {
    const r = preScoreJob({
      title: "Python automation engineer",
      description: "Need python automation for data pipeline",
      posted: "3 days ago",
    });
    expect(r.recencyBonus).toBe(0);
  });

  it("score never exceeds 100", () => {
    const r = preScoreJob({
      title: "AI automation n8n zapier web scraping data extraction chatbot llm",
      description: "Full stack ai automation with api integration, email automation, lead generation, data pipeline, etl, web crawler, python automation, workflow automation, browser automation, bot development, process automation, rpa, webhook, api development, backend developer, mobile app, react native, saas, mvp, prototype, web app",
      budget: "$5,000",
      posted: "just now",
    });
    expect(r.score).toBeLessThanOrEqual(100);
  });
});

// ── Edge Cases ──

describe("preScoreJob — edge cases", () => {
  it("handles empty description", () => {
    const r = preScoreJob({ title: "AI automation", description: "" });
    expect(r.excluded).toBe(false);
    expect(r.strongHits).toContain("ai automation");
  });

  it("handles no budget", () => {
    const r = preScoreJob({
      title: "Web scraping developer",
      description: "Build a web scraping tool",
    });
    expect(r.excluded).toBe(false);
    expect(r.budgetBonus).toBe(0);
  });

  it("handles no posted time", () => {
    const r = preScoreJob({
      title: "Python automation script",
      description: "Need python automation for web scraping",
    });
    expect(r.recencyBonus).toBe(0);
  });

  it("case insensitive matching", () => {
    const r = preScoreJob({
      title: "WORDPRESS Site",
      description: "Need WordPress help",
    });
    expect(r.excluded).toBe(true);
  });

  it("budget with comma formatting", () => {
    const r = preScoreJob({
      title: "AI automation project",
      description: "Build an ai automation system",
      budget: "$1,500",
    });
    expect(r.budgetBonus).toBeGreaterThanOrEqual(20);
  });
});
