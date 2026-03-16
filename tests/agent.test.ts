/**
 * tests/agent.test.ts — Unit tests for the Agent module
 * Tests portfolio line matching, character config loading,
 * quality gate, YouTube matching, and proposal generation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Track Claude API calls for proposal generation tests
const mockCreate = vi.fn().mockResolvedValue({
  content: [{ text: "This is a test cover letter." }],
});

// Mock the Anthropic SDK
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: mockCreate };
  },
}));

vi.mock("../src/secret", () => ({
  ANTHROPIC_API_KEY: "test-key",
}));

vi.mock("../src/config/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock fs to control character config
vi.mock("fs", async () => {
  const actual = await vi.importActual("fs");
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
  };
});

describe("getPortfolioLine", () => {
  // We need to test the function after manually setting character config
  // Since initAgent reads from filesystem, we test the exported getPortfolioLine
  // by calling initAgent with mocked fs

  it("returns empty string when no character loaded", async () => {
    const { getPortfolioLine } = await import("../src/Agent/index");
    const line = getPortfolioLine(["ai", "automation"]);
    expect(line).toBe("");
  });
});

describe("generateCoverLetter", () => {
  it("returns text from Claude API response", async () => {
    const { generateCoverLetter } = await import("../src/Agent/index");
    const letter = await generateCoverLetter({
      title: "AI Automation Project",
      description: "Build an automated workflow using Claude API",
      budget: "$2,000",
    });
    expect(letter).toBe("This is a test cover letter.");
  });
});

describe("answerScreeningQuestion", () => {
  it("returns answer text from Claude API", async () => {
    const { answerScreeningQuestion } = await import("../src/Agent/index");
    const answer = await answerScreeningQuestion(
      "How much experience do you have?",
      { title: "AI Bot", description: "Build AI chatbot" },
    );
    expect(answer).toBe("This is a test cover letter.");
  });
});

describe("qualityCheckCoverLetter", () => {
  const job = {
    title: "Build n8n Automation with OpenAI Integration",
    description: "Need someone to build automated workflows using n8n and OpenAI API for content generation pipeline",
    skills: ["n8n", "openai", "automation"],
  };

  it("passes a high-quality proposal matching winning patterns", async () => {
    const { qualityCheckCoverLetter } = await import("../src/Agent/index");
    const goodProposal = `Hi there, I'd love to help with your n8n automation project.

I've built exactly this type of pipeline before — here's my working implementation:
🔗 https://github.com/IsaiahDupree/n8n-video-processing

✅ Why I'm a strong fit:
I've already built and deployed n8n + OpenAI workflows handling 50,000+ records monthly. My stack includes:
• n8n self-hosted with custom nodes for OpenAI API calls
• Python middleware for data transformation
• Supabase for persistence and real-time triggers

Here's my approach:
1. Audit your current workflow and identify automation opportunities
2. Build n8n workflows with OpenAI integration for content generation
3. Add error handling, retry logic, and monitoring dashboards
4. Deploy and document the full pipeline

I can have a working prototype within 5 days.

Best,
Isaiah`;

    const result = qualityCheckCoverLetter(goodProposal, job);
    expect(result.score).toBeGreaterThanOrEqual(60);
    expect(result.passed).toBe(true);
    expect(result.checks.find(c => c.name === "warm_opening")?.passed).toBe(true);
    expect(result.checks.find(c => c.name === "specific_tech")?.passed).toBe(true);
    expect(result.checks.find(c => c.name === "proof_element")?.passed).toBe(true);
    expect(result.checks.find(c => c.name === "structured_deliverables")?.passed).toBe(true);
  });

  it("fails a generic low-quality proposal", async () => {
    const { qualityCheckCoverLetter } = await import("../src/Agent/index");
    const badProposal = `I am writing to express my interest in your project. I am confident I am the right person for the job. I have experience with automation and can help you. Please consider my application. Thank you for the opportunity.`;

    const result = qualityCheckCoverLetter(badProposal, job);
    expect(result.passed).toBe(false);
    expect(result.score).toBeLessThan(60);
    expect(result.suggestions.length).toBeGreaterThan(0);
    // Should flag generic filler
    expect(result.checks.find(c => c.name === "no_filler")?.passed).toBe(false);
    // Should flag no structure
    expect(result.checks.find(c => c.name === "structured_deliverables")?.passed).toBe(false);
  });

  it("flags missing proof elements", async () => {
    const { qualityCheckCoverLetter } = await import("../src/Agent/index");
    const noProof = `Hi there, I'd love to help with your n8n automation project.

I know n8n and OpenAI very well. I can build the workflow you need.

Here's my plan:
1. Set up n8n with OpenAI nodes
2. Build the content pipeline
3. Deploy and test

Best,
Isaiah`;

    const result = qualityCheckCoverLetter(noProof, job);
    expect(result.checks.find(c => c.name === "proof_element")?.passed).toBe(false);
    expect(result.suggestions.some(s => s.includes("proof"))).toBe(true);
  });

  it("flags too-short proposals", async () => {
    const { qualityCheckCoverLetter } = await import("../src/Agent/index");
    const tooShort = `Hi there, I can help with n8n and OpenAI. Let me know.

Best,
Isaiah`;

    const result = qualityCheckCoverLetter(tooShort, job);
    expect(result.checks.find(c => c.name === "word_count")?.passed).toBe(false);
  });

  it("requires job-specific keyword references", async () => {
    const { qualityCheckCoverLetter } = await import("../src/Agent/index");
    const offTopic = `Hi there, I'd love to help with your project.

I've built many React and mobile apps using Swift and Kotlin. I recently shipped a social media app with 10,000 users.

Here's my plan:
1. Design the database schema
2. Build the frontend with React
3. Deploy to AWS

Best,
Isaiah`;

    const result = qualityCheckCoverLetter(offTopic, job);
    // Should flag that n8n/openai/automation aren't mentioned
    expect(result.checks.find(c => c.name === "job_relevance")?.passed).toBe(false);
  });

  it("detects GitHub links as proof", async () => {
    const { qualityCheckCoverLetter } = await import("../src/Agent/index");
    const withGithub = `Hi there, I'd love to help build your n8n automation.

🔗 Here's my relevant repo: https://github.com/IsaiahDupree/n8n-video-processing

I use n8n and OpenAI daily for automation pipelines. Here's my approach:
1. Audit current workflows
2. Build n8n + OpenAI integration
3. Test and deploy

Best,
Isaiah`;

    const result = qualityCheckCoverLetter(withGithub, job);
    expect(result.checks.find(c => c.name === "proof_element")?.passed).toBe(true);
    expect(result.checks.find(c => c.name === "proof_element")?.detail).toContain("GitHub");
  });

  it("detects YouTube links as proof", async () => {
    const { qualityCheckCoverLetter } = await import("../src/Agent/index");
    const withYouTube = `Hi there, I'd love to help build your n8n automation.

I've built exactly this — here's a video walkthrough:
🎥 https://youtube.com/watch?v=k6jQXjQ2_EU

I use n8n and OpenAI daily for automation pipelines. Here's my approach:
1. Audit current workflows
2. Build n8n + OpenAI integration
3. Test and deploy

Best,
Isaiah`;

    const result = qualityCheckCoverLetter(withYouTube, job);
    expect(result.checks.find(c => c.name === "proof_element")?.passed).toBe(true);
    expect(result.checks.find(c => c.name === "proof_element")?.detail).toContain("YouTube");
  });

  it("passes with both GitHub and YouTube proof", async () => {
    const { qualityCheckCoverLetter } = await import("../src/Agent/index");
    const bothProof = `Hi there, I'd love to help with your n8n automation project.

I've built exactly this type of pipeline:
🔗 GitHub: https://github.com/IsaiahDupree/n8n-video-processing
🎥 Video walkthrough: https://youtube.com/watch?v=k6jQXjQ2_EU

I use n8n and OpenAI daily. Here's my approach:
1. Audit your current workflow
2. Build n8n + OpenAI integration
3. Deploy and monitor

Best,
Isaiah`;

    const result = qualityCheckCoverLetter(bothProof, job);
    expect(result.checks.find(c => c.name === "proof_element")?.passed).toBe(true);
    const detail = result.checks.find(c => c.name === "proof_element")?.detail || "";
    expect(detail).toContain("GitHub");
    expect(detail).toContain("YouTube");
  });
});

describe("getMatchingYouTubeVideos", () => {
  it("returns empty when no character loaded", async () => {
    const { getMatchingYouTubeVideos } = await import("../src/Agent/index");
    const result = getMatchingYouTubeVideos({ title: "AI bot", description: "Build an AI agent" });
    expect(result).toBe("");
  });
});

describe("proposal generation (e2e with quality gate)", () => {
  beforeEach(() => {
    mockCreate.mockClear();
  });

  it("generates a cover letter and passes it through Claude API", async () => {
    const { generateCoverLetter } = await import("../src/Agent/index");
    const letter = await generateCoverLetter({
      title: "Build n8n Workflow with Claude API",
      description: "Need an automated workflow using n8n and Claude for document processing",
      budget: "$2,000",
    });

    expect(letter).toBeTruthy();
    expect(typeof letter).toBe("string");
    expect(mockCreate).toHaveBeenCalledOnce();

    // Verify prompt includes key elements
    const prompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain("n8n Workflow");
    expect(prompt).toContain("$2,000");
    expect(prompt).toContain("RULES:");
    expect(prompt).toContain("YouTube");
  });

  it("includes research brief in prompt when provided", async () => {
    const { generateCoverLetter } = await import("../src/Agent/index");
    await generateCoverLetter({
      title: "FastAPI Backend",
      description: "Build a REST API with FastAPI and MongoDB",
      budget: "$1,500",
      researchBrief: "Overview: FastAPI 0.135 with Pydantic v2\nKey tech: Motor for async MongoDB; UV for deployment",
    });

    const prompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain("TECHNICAL RESEARCH");
    expect(prompt).toContain("FastAPI 0.135");
    expect(prompt).toContain("Motor for async MongoDB");
  });

  it("quality gate passes a well-structured AI proposal", async () => {
    // Simulate a high-quality Claude response
    mockCreate.mockResolvedValueOnce({
      content: [{
        text: `Hi there, I'd love to help with your n8n automation project.

I've built exactly this — here's a 30-minute walkthrough I recorded:
🎥 How I Built an AI Automation Workflow with n8n and Claude: https://youtube.com/watch?v=k6jQXjQ2_EU
🔗 GitHub repo: https://github.com/IsaiahDupree/n8n-video-processing

I've deployed n8n + OpenAI pipelines processing 50,000+ records monthly for 3 clients. My stack:
• n8n self-hosted with custom webhook triggers
• Claude API for intelligent document classification
• Supabase for real-time data persistence

Here's my approach for your project:
1. Audit your current manual workflow and map automation points
2. Build n8n workflows with OpenAI/Claude nodes for content generation
3. Add error handling, retry logic, and Slack/email notifications
4. Deploy, document, and hand off with a recorded walkthrough

I can deliver a working prototype within 5 business days.

Best,
Isaiah Dupree`,
      }],
    });

    const { generateCoverLetter, qualityCheckCoverLetter } = await import("../src/Agent/index");
    const letter = await generateCoverLetter({
      title: "Build n8n Automation with OpenAI",
      description: "Need automated workflows using n8n and OpenAI API for content pipeline",
    });

    const result = qualityCheckCoverLetter(letter, {
      title: "Build n8n Automation with OpenAI",
      description: "Need automated workflows using n8n and OpenAI API for content pipeline",
      skills: ["n8n", "openai"],
    });

    expect(result.passed).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.checks.find(c => c.name === "proof_element")?.detail).toContain("YouTube");
    expect(result.checks.find(c => c.name === "proof_element")?.detail).toContain("GitHub");
    expect(result.checks.find(c => c.name === "structured_deliverables")?.passed).toBe(true);
    expect(result.checks.find(c => c.name === "warm_opening")?.passed).toBe(true);
  });

  it("quality gate fails a generic proposal and refinement is called", async () => {
    // First call: generic low-quality response
    mockCreate.mockResolvedValueOnce({
      content: [{
        text: `I am writing to express my interest in your project. I am confident I can help. I have many years of experience. Please consider my application. Thank you for the opportunity to apply.`,
      }],
    });
    // Second call: refined version (from refineCoverLetter)
    mockCreate.mockResolvedValueOnce({
      content: [{
        text: `Hi there, I'd love to help automate your n8n workflows with OpenAI.

I've built similar automation pipelines — check out my walkthrough:
🎥 https://youtube.com/watch?v=k6jQXjQ2_EU

Here's my plan:
1. Map your current workflow bottlenecks
2. Build n8n nodes with OpenAI integration
3. Deploy with monitoring and error alerts

I can start this week.

Best,
Isaiah Dupree`,
      }],
    });

    const { generateCoverLetter, qualityCheckCoverLetter, refineCoverLetter } = await import("../src/Agent/index");

    // Generate (gets the bad response)
    const badLetter = await generateCoverLetter({
      title: "n8n OpenAI Automation",
      description: "Automate content with n8n and OpenAI",
    });

    // Quality check should fail
    const check1 = qualityCheckCoverLetter(badLetter, {
      title: "n8n OpenAI Automation",
      description: "Automate content with n8n and OpenAI",
      skills: ["n8n", "openai"],
    });
    expect(check1.passed).toBe(false);
    expect(check1.suggestions.length).toBeGreaterThan(0);

    // Refine should produce better output
    const refined = await refineCoverLetter(badLetter, {
      title: "n8n OpenAI Automation",
      description: "Automate content with n8n and OpenAI",
      skills: ["n8n", "openai"],
    }, check1);

    expect(refined).not.toBe(badLetter);
    expect(mockCreate).toHaveBeenCalledTimes(2);

    // Verify the refinement prompt includes failed checks
    const refinePrompt = mockCreate.mock.calls[1][0].messages[0].content;
    expect(refinePrompt).toContain("FAILED QUALITY CHECKS");
    expect(refinePrompt).toContain("REQUIRED FIXES");
  });
});
