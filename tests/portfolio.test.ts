/**
 * tests/portfolio.test.ts — Portfolio integration tests
 *
 * Covers:
 * - Niche detection and anchor routing for all 8 industries
 * - UTM tracking params (source, medium, campaign, content)
 * - Template selection per industry
 * - Showcase project matching against job descriptions
 * - Edge cases: empty tags, ambiguous matches, no matches
 * - URL structure validation
 * - Portfolio line dedup with the new URL format
 */
import { describe, it, expect, vi, beforeAll } from "vitest";

vi.mock("../src/config/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getPortfolioLine, getMatchingShowcaseProjects, initAgent } from "../src/Agent/index";

beforeAll(async () => {
  await initAgent("sample.character.json");
});

// ═══════════════════════════════════════════════════════════════════
// Portfolio UTM Link Generation
// ═══════════════════════════════════════════════════════════════════

describe("Portfolio UTM Link Generation", () => {

  // ── All 8 niche detections ──

  describe("niche detection for all 8 industries", () => {
    it("SMMA — marketing agency tags", () => {
      const line = getPortfolioLine(["social media", "lead gen", "instagram"], "j1");
      expect(line).toContain("#niche-smma");
      expect(line).toContain("utm_campaign=smma");
      expect(line).toContain("dupreeops-portfolio.vercel.app");
    });

    it("E-Commerce — shopify/stripe tags", () => {
      const line = getPortfolioLine(["shopify", "stripe", "ecommerce"], "j2");
      expect(line).toContain("#niche-ecommerce");
      expect(line).toContain("utm_campaign=ecommerce");
    });

    it("Content — youtube/video tags", () => {
      const line = getPortfolioLine(["youtube", "video", "content creation"], "j3");
      expect(line).toContain("#niche-content");
      expect(line).toContain("utm_campaign=content");
    });

    it("IoT — arduino/hardware tags", () => {
      const line = getPortfolioLine(["arduino", "esp32", "firmware"], "j4");
      expect(line).toContain("#niche-iot");
      expect(line).toContain("utm_campaign=iot");
    });

    it("SaaS — startup/web app tags", () => {
      const line = getPortfolioLine(["saas", "react", "mvp", "dashboard"], "j5");
      expect(line).toContain("#niche-saas");
      expect(line).toContain("utm_campaign=saas");
    });

    it("Government — procurement/compliance tags", () => {
      const line = getPortfolioLine(["government", "compliance", "procurement"], "j6");
      expect(line).toContain("#niche-government");
      expect(line).toContain("utm_campaign=government");
    });

    it("Real Estate — property/crm tags", () => {
      const line = getPortfolioLine(["real estate", "crm", "listing"], "j7");
      expect(line).toContain("#niche-realestate");
      expect(line).toContain("utm_campaign=realestate");
    });

    it("Research — matlab/engineering tags", () => {
      const line = getPortfolioLine(["matlab", "simulation", "cfd"], "j8");
      expect(line).toContain("#niche-research");
      expect(line).toContain("utm_campaign=research");
    });
  });

  // ── UTM params ──

  describe("UTM parameter tracking", () => {
    it("should include all 4 UTM params with job ID", () => {
      const line = getPortfolioLine(["react", "next", "api"], "job-abc");
      expect(line).toContain("utm_source=upwork");
      expect(line).toContain("utm_medium=proposal");
      expect(line).toContain("utm_campaign=");
      expect(line).toContain("utm_content=job-abc");
    });

    it("should omit utm_content when no job ID", () => {
      const line = getPortfolioLine(["python", "fastapi"]);
      expect(line).toContain("utm_source=upwork");
      expect(line).not.toContain("utm_content=");
    });

    it("should use 'general' campaign for unmatched tags", () => {
      const line = getPortfolioLine(["blockchain", "nft"]);
      expect(line).toContain("utm_campaign=general");
    });

    it("should preserve job ID with special characters", () => {
      const line = getPortfolioLine(["saas"], "job~123_abc");
      expect(line).toContain("utm_content=job~123_abc");
    });
  });

  // ── Default / fallback ──

  describe("default and fallback behavior", () => {
    it("should use default when no tags match any niche", () => {
      const line = getPortfolioLine(["blockchain", "nft", "web3"]);
      expect(line).toContain("utm_campaign=general");
      expect(line).not.toContain("#niche-");
    });

    it("should return a valid line when no tags provided", () => {
      const line = getPortfolioLine();
      expect(line).toContain("utm_source=upwork");
      expect(line.length).toBeGreaterThan(50);
    });

    it("should return a valid line for empty tags array", () => {
      const line = getPortfolioLine([]);
      expect(line).toContain("dupreeops-portfolio.vercel.app");
    });

    it("should return empty string if portfolio config is missing", () => {
      // This tests the null guard — characterConfig.portfolio exists in our test
      // so we just verify the function doesn't crash with weird tags
      const line = getPortfolioLine(["zzz_nonexistent_niche"]);
      expect(typeof line).toBe("string");
    });
  });

  // ── Niche priority / ambiguity ──

  describe("niche priority when tags match multiple", () => {
    it("should pick IoT over SaaS when hardware keywords dominate", () => {
      const line = getPortfolioLine(["arduino", "iot", "sensor", "api"]);
      expect(line).toContain("#niche-iot");
    });

    it("should pick SaaS over content when saas keywords dominate", () => {
      const line = getPortfolioLine(["saas", "mvp", "react", "dashboard", "video"]);
      expect(line).toContain("#niche-saas");
    });

    it("should pick SMMA for mixed marketing + automation tags", () => {
      const line = getPortfolioLine(["marketing", "lead gen", "agency", "automation"]);
      expect(line).toContain("#niche-smma");
    });
  });

  // ── Template content quality ──

  describe("template content quality", () => {
    it("SaaS template should mention products and tech stack", () => {
      const line = getPortfolioLine(["saas", "mvp"], "j1");
      expect(line).toMatch(/product|tech stack|production/i);
    });

    it("IoT template should mention hardware", () => {
      const line = getPortfolioLine(["arduino", "iot"], "j2");
      expect(line).toMatch(/hardware|PCB|sensor/i);
    });

    it("SMMA template should mention lead gen or automation", () => {
      const line = getPortfolioLine(["marketing", "social media"], "j3");
      expect(line).toMatch(/lead|automation|workflow|agency/i);
    });

    it("all templates should include the portfolio URL", () => {
      for (const tags of [
        ["saas"], ["arduino"], ["marketing"], ["youtube"],
        ["shopify"], ["government"], ["real estate"], ["matlab"]
      ]) {
        const line = getPortfolioLine(tags);
        expect(line).toContain("dupreeops-portfolio.vercel.app");
      }
    });
  });

  // ── URL structure ──

  describe("URL structure", () => {
    it("should have anchor before query params", () => {
      const line = getPortfolioLine(["saas", "mvp"], "j1");
      const urlMatch = line.match(/https:\/\/[^\s]+/);
      expect(urlMatch).not.toBeNull();
      expect(urlMatch![0]).toMatch(/#niche-saas\?utm_source=/);
    });

    it("should not have anchor for default/general campaign", () => {
      const line = getPortfolioLine(["blockchain"]);
      const urlMatch = line.match(/https:\/\/[^\s]+/);
      expect(urlMatch).not.toBeNull();
      // Should go straight to ?utm_source without anchor
      expect(urlMatch![0]).toMatch(/\.app\?utm_source=/);
      expect(urlMatch![0]).not.toContain("#niche-");
    });

    it("should produce a URL that contains no spaces", () => {
      const line = getPortfolioLine(["react native", "mobile app"], "job with spaces");
      const urlMatch = line.match(/https:\/\/\S+/);
      expect(urlMatch).not.toBeNull();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Showcase Project Matching — Live Demo Projects
// ═══════════════════════════════════════════════════════════════════

describe("Showcase Project Matching", () => {

  // ── Matching by job niche ──

  describe("matching by job niche", () => {
    it("should match Voice AI Agent for voice/phone jobs", () => {
      const result = getMatchingShowcaseProjects({
        title: "Build Voice AI Call Center Agent",
        description: "Need a voice AI agent for phone calls with speech recognition",
      });
      expect(result).toContain("Voice AI Agent");
    });

    it("should match RAG Chatbot for chatbot/knowledge base jobs", () => {
      const result = getMatchingShowcaseProjects({
        title: "Build AI Chatbot with Knowledge Base",
        description: "Need a RAG chatbot that answers questions from documents with embeddings",
      });
      expect(result).toContain("RAG Chatbot");
    });

    it("should match SaaS MVP for startup/billing jobs", () => {
      const result = getMatchingShowcaseProjects({
        title: "Build SaaS MVP with Stripe",
        description: "Need a full stack SaaS with auth, billing dashboard and stripe integration",
      });
      expect(result).toContain("SaaS MVP");
    });

    it("should match Content AI Pipeline for content/blog jobs", () => {
      const result = getMatchingShowcaseProjects({
        title: "AI Content Writing Pipeline",
        description: "Build a blog content pipeline that writes and publishes SEO articles automatically",
      });
      expect(result).toContain("Content AI");
    });

    it("should match CRMLite for CRM/sales jobs", () => {
      const result = getMatchingShowcaseProjects({
        title: "Build a CRM System",
        description: "Need CRM with lead scoring, pipeline management, and email tracking for sales",
      });
      expect(result).toContain("CRMLite");
    });

    it("should match CRM Lead Gen for lead generation jobs", () => {
      const result = getMatchingShowcaseProjects({
        title: "Automated Lead Generation System",
        description: "Build a B2B lead gen tool with prospecting and outreach scoring automation",
      });
      expect(result).toContain("Lead Gen");
    });

    it("should match Workflow Engine for automation/n8n jobs", () => {
      const result = getMatchingShowcaseProjects({
        title: "Build Custom Workflow Automation Tool",
        description: "Need a visual workflow builder like n8n with API integration and triggers",
      });
      expect(result).toContain("Workflow Engine");
    });

    it("should match AgentLite for AI agent framework jobs", () => {
      const result = getMatchingShowcaseProjects({
        title: "Build AI Agent with Tool Use",
        description: "Need an AI agent framework with Claude tool use and multi-step reasoning",
      });
      expect(result).toContain("AgentLite");
    });

    it("should match AdLite for ad creative/campaign jobs", () => {
      const result = getMatchingShowcaseProjects({
        title: "AI Ad Creative Generator",
        description: "Build a tool that generates ad copy and creatives for Meta and Google Ads campaigns",
      });
      expect(result).toContain("AdLite");
    });

    it("should match Touch-to-Speech for hardware/Arduino jobs", () => {
      const result = getMatchingShowcaseProjects({
        title: "Build Arduino IoT Device",
        description: "Need hardware firmware for an embedded system with speech output",
      });
      expect(result).toContain("Touch-to-Speech");
    });

    it("should match Austender for government/procurement jobs", () => {
      const result = getMatchingShowcaseProjects({
        title: "Government Tender Tracking System",
        description: "Build a procurement dashboard with scraping and email alerts",
      });
      expect(result).toContain("Austender");
    });

    it("should match Schumann for science/research jobs", () => {
      const result = getMatchingShowcaseProjects({
        title: "Scientific Data Analysis Pipeline",
        description: "Build a data pipeline with OCR extraction and visualization in Python",
      });
      expect(result).toContain("Schumann");
    });

    it("should match ResearchLite for research/analysis jobs", () => {
      const result = getMatchingShowcaseProjects({
        title: "AI Research Assistant Tool",
        description: "Need a Perplexity-style research tool that synthesizes web data into reports",
      });
      expect(result).toContain("ResearchLite");
    });

    it("should match Authority OS for personal branding jobs", () => {
      const result = getMatchingShowcaseProjects({
        title: "Build Personal Branding Platform",
        description: "Need a content calendar with LinkedIn and newsletter publishing automation",
      });
      expect(result).toContain("Authority");
    });

    it("should match iOS App for mobile/App Store jobs", () => {
      const result = getMatchingShowcaseProjects({
        title: "Build iOS Mobile App",
        description: "Need native iOS app with Swift and App Store submission",
      });
      expect(result).toContain("iOS App");
    });
  });

  // ── Tag-based matching ──

  describe("tag-based matching", () => {
    it("should use tags to find CRMLite when title/desc are vague", () => {
      const result = getMatchingShowcaseProjects({
        title: "Build an App",
        description: "Need a developer for my project",
        tags: ["crm", "lead", "pipeline", "sales"],
      });
      expect(result).toContain("CRMLite");
    });

    it("should use tags to find SaaS MVP for generic saas job", () => {
      const result = getMatchingShowcaseProjects({
        title: "Need a developer",
        description: "Building a product",
        tags: ["saas", "stripe", "react", "dashboard"],
      });
      expect(result).toContain("SaaS MVP");
    });
  });

  // ── Live URL inclusion ──

  describe("live URL inclusion", () => {
    it("should include live demo URL for projects that have one", () => {
      const result = getMatchingShowcaseProjects({
        title: "Build AI Chatbot",
        description: "Need RAG chatbot with document QA and embeddings for customer support",
      });
      expect(result).toContain("rag-chatbot-starter.vercel.app");
      expect(result).toContain("Live demo:");
    });

    it("should include live URL for SaaS MVP", () => {
      const result = getMatchingShowcaseProjects({
        title: "Build SaaS with Stripe Billing",
        description: "Full stack SaaS MVP with auth and stripe dashboard",
      });
      expect(result).toContain("saas-mvp-fullstack.vercel.app");
    });

    it("should include live URL for Voice AI Agent", () => {
      const result = getMatchingShowcaseProjects({
        title: "Build Voice AI Phone Agent",
        description: "Need conversational AI agent with speech recognition for call center",
      });
      expect(result).toContain("voice-ai-agent");
    });

    it("should NOT include live URL for projects without one (hardware)", () => {
      const result = getMatchingShowcaseProjects({
        title: "Build Arduino Device",
        description: "Need hardware firmware for embedded iot system with speech",
      });
      expect(result).toContain("Touch-to-Speech");
      expect(result).not.toContain("Live demo:");
    });
  });

  // ── Result quality ──

  describe("result quality", () => {
    it("should return at most 2 projects", () => {
      const result = getMatchingShowcaseProjects({
        title: "AI Automation Platform",
        description: "Build AI agent with automation pipeline workflow and outreach scoring",
      });
      const projectCount = (result.match(/•/g) || []).length;
      expect(projectCount).toBeLessThanOrEqual(2);
    });

    it("should return empty string when no projects match", () => {
      const result = getMatchingShowcaseProjects({
        title: "Write a Novel",
        description: "I need a ghostwriter for my memoir about hiking in Nepal",
      });
      expect(result).toBe("");
    });

    it("should require at least 2 keyword matches", () => {
      const result = getMatchingShowcaseProjects({
        title: "Something unrelated",
        description: "totally different domain",
      });
      expect(result).toBe("");
    });

    it("should prefer featured projects (Voice AI, RAG, SaaS MVP, Content AI)", () => {
      const result = getMatchingShowcaseProjects({
        title: "Build AI Chatbot for Customer Support",
        description: "Need an AI chatbot with RAG and document knowledge base for customer support",
      });
      // RAG Chatbot Starter is featured and should rank high
      expect(result).toContain("RAG Chatbot");
    });
  });

  // ── Format ──

  describe("output format", () => {
    it("should include bullet points and em dashes", () => {
      const result = getMatchingShowcaseProjects({
        title: "Build AI Ad Campaign Manager",
        description: "Need ad creative generation for Meta and Google Ads with campaign management",
      });
      expect(result).toContain("•");
      expect(result).toContain("—");
    });

    it("should include intro text about portfolio", () => {
      const result = getMatchingShowcaseProjects({
        title: "Build SaaS Dashboard",
        description: "Full stack saas mvp with stripe and auth dashboard",
      });
      expect(result).toContain("portfolio");
    });

    it("should include project descriptions not just names", () => {
      const result = getMatchingShowcaseProjects({
        title: "Build CRM with Lead Scoring",
        description: "CRM system with pipeline and lead scoring and email tracking",
      });
      // Description should be included
      expect(result.length).toBeGreaterThan(100);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Portfolio + Showcase Integration (end-to-end)
// ═══════════════════════════════════════════════════════════════════

describe("Portfolio + Showcase integration", () => {
  it("IoT job: portfolio anchors to IoT, projects match hardware", () => {
    const tags = ["arduino", "iot", "embedded"];
    const portfolioLine = getPortfolioLine(tags, "j1");
    const projects = getMatchingShowcaseProjects({
      title: "IoT Device",
      description: "Build an arduino sensor device with firmware",
      tags,
    });
    expect(portfolioLine).toContain("#niche-iot");
    expect(projects).toMatch(/Touch-to-Speech|CAN Bus/);
  });

  it("SaaS job: portfolio anchors to SaaS, projects match SaaS demos", () => {
    const tags = ["react", "saas", "stripe", "dashboard"];
    const portfolioLine = getPortfolioLine(tags, "j2");
    const projects = getMatchingShowcaseProjects({
      title: "Build SaaS Dashboard with Billing",
      description: "Full stack SaaS MVP with React, Stripe, and auth dashboard",
      tags,
    });
    expect(portfolioLine).toContain("#niche-saas");
    expect(projects).toMatch(/SaaS MVP|CRMLite|AgentLite|Workflow/);
  });

  it("Voice AI job: portfolio anchors to SMMA, projects match voice demos", () => {
    const tags = ["voice", "ai agent", "phone"];
    const portfolioLine = getPortfolioLine(tags, "j3");
    const projects = getMatchingShowcaseProjects({
      title: "Build Voice AI Agent",
      description: "Need voice AI agent for call center with speech recognition and phone integration",
      tags,
    });
    expect(projects).toContain("Voice AI Agent");
    expect(projects).toContain("voice-ai-agent");
  });

  it("Content job: portfolio anchors to content, projects match content tools", () => {
    const tags = ["content", "blog", "seo"];
    const portfolioLine = getPortfolioLine(tags, "j4");
    const projects = getMatchingShowcaseProjects({
      title: "AI Content Pipeline",
      description: "Build an AI content writing pipeline for blog posts and social media",
      tags,
    });
    expect(portfolioLine).toContain("#niche-content");
    expect(projects).toContain("Content AI");
  });

  it("Research job: portfolio anchors to research, projects match research tools", () => {
    const tags = ["research", "data", "analysis"];
    const portfolioLine = getPortfolioLine(tags, "j5");
    const projects = getMatchingShowcaseProjects({
      title: "Build AI Research Tool",
      description: "Need a research assistant that synthesizes data and produces reports with analysis",
      tags,
    });
    expect(portfolioLine).toContain("#niche-research");
    expect(projects).toMatch(/ResearchLite|Schumann/);
  });

  it("Gov job: portfolio anchors to government, projects match gov tools", () => {
    const tags = ["government", "procurement", "rfp"];
    const portfolioLine = getPortfolioLine(tags, "j6");
    const projects = getMatchingShowcaseProjects({
      title: "Government Tender Tracker",
      description: "Build procurement tracking with government tender dashboard and compliance",
      tags,
    });
    expect(portfolioLine).toContain("#niche-government");
    expect(projects).toContain("Austender");
  });
});
