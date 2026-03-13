/**
 * tests/agent.test.ts — Unit tests for the Agent module
 * Tests portfolio line matching and character config loading.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Anthropic SDK
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: vi.fn().mockResolvedValue({
        content: [{ text: "This is a test cover letter." }],
      }),
    };
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
