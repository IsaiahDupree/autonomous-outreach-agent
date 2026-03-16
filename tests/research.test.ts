/**
 * tests/research.test.ts — Unit tests for Perplexity research service
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/config/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/secret", () => ({
  PERPLEXITY_API_KEY: "test-pplx-key",
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("researchJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns parsed research from Perplexity API", async () => {
    const mockResponse = {
      choices: [{
        message: {
          content: JSON.stringify({
            summary: "This job needs a FastAPI backend with MongoDB",
            techInsights: ["Use Motor for async MongoDB", "FastAPI 0.100+ recommended"],
            implementation: ["Set up Docker container", "Configure MongoDB Atlas"],
            pitfalls: ["Watch out for connection pooling"],
            context: "FastAPI is the most popular Python async framework",
          }),
        },
      }],
      citations: ["https://fastapi.tiangolo.com", "https://motor.readthedocs.io"],
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const { researchJob } = await import("../src/services/research");
    const result = await researchJob({
      title: "Build FastAPI + MongoDB Backend",
      description: "Need a REST API with MongoDB Atlas Search",
      budget: "$1,500",
      skills: ["Python", "FastAPI", "MongoDB"],
    });

    expect(result).not.toBeNull();
    expect(result!.summary).toContain("FastAPI");
    expect(result!.techInsights).toHaveLength(2);
    expect(result!.citations).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("returns null on API error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
    });

    const { researchJob } = await import("../src/services/research");
    const result = await researchJob({
      title: "Test Job",
      description: "Test description",
    });

    expect(result).toBeNull();
  });

  it("handles non-JSON response gracefully", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: "Here are some tips about FastAPI..." } }],
        citations: [],
      }),
    });

    const { researchJob } = await import("../src/services/research");
    const result = await researchJob({
      title: "FastAPI Project",
      description: "Build an API",
    });

    // Should return partial result with summary from raw text
    expect(result).not.toBeNull();
    expect(result!.summary).toBeTruthy();
    expect(result!.techInsights).toEqual([]);
  });

  it("returns null when PERPLEXITY_API_KEY is empty", async () => {
    // Re-mock with empty key
    vi.doMock("../src/secret", () => ({
      PERPLEXITY_API_KEY: "",
    }));

    // Force reimport
    vi.resetModules();
    vi.mock("../src/config/logger", () => ({
      default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    const { researchJob } = await import("../src/services/research");
    const result = await researchJob({
      title: "Test",
      description: "Test",
    });

    expect(result).toBeNull();
  });
});

describe("formatResearchBrief", () => {
  it("formats research into concise brief", async () => {
    const { formatResearchBrief } = await import("../src/services/research");
    const brief = formatResearchBrief({
      summary: "Build a FastAPI backend",
      techInsights: ["Use Motor for async MongoDB", "FastAPI 0.100+"],
      implementation: ["Docker setup", "Atlas config"],
      pitfalls: ["Connection pooling issues"],
      context: "FastAPI growing 200% YoY",
      citations: ["https://example.com"],
    });

    expect(brief).toContain("Overview: Build a FastAPI backend");
    expect(brief).toContain("Key tech:");
    expect(brief).toContain("Approach:");
    expect(brief).toContain("Watch out for:");
    expect(brief).toContain("Context:");
  });

  it("handles empty fields", async () => {
    const { formatResearchBrief } = await import("../src/services/research");
    const brief = formatResearchBrief({
      summary: "",
      techInsights: [],
      implementation: [],
      pitfalls: [],
      context: "",
      citations: [],
    });

    expect(brief).toBe("");
  });
});
