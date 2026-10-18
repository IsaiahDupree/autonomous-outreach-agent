/**
 * tests/proof-of-work.test.ts — Proof-of-work service tests
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/Agent", () => ({
  getClientAsync: vi.fn().mockResolvedValue({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{
          type: "text",
          text: JSON.stringify({
            analysis: "This project requires a FastAPI backend with React frontend. The key challenge is integrating real-time data processing.",
            architectureDiagram: "┌──────────┐    ┌──────────┐\n│  React   │───▶│ FastAPI  │\n└──────────┘    └──────────┘",
            codeSnippets: [{
              filename: "main.py",
              language: "python",
              code: "from fastapi import FastAPI\napp = FastAPI()\n\n@app.get('/health')\ndef health():\n    return {'status': 'ok'}",
            }],
            implementationPlan: "Phase 1 (Week 1): Setup and architecture\nPhase 2 (Week 2-3): Core features\nPhase 3 (Week 4): Testing and deployment",
          }),
        }],
      }),
    },
  }),
}));
vi.mock("../src/services/research", () => ({
  researchJob: vi.fn().mockResolvedValue(null),
  formatResearchBrief: vi.fn().mockReturnValue(""),
}));
vi.mock("../src/services/cloud", () => ({
  saveProofArtifact: vi.fn().mockResolvedValue(true),
  getProofArtifact: vi.fn().mockResolvedValue(null),
}));
vi.mock("../src/services/telegram", () => ({
  notify: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/config/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { generateProofArtifact, formatProofForCoverLetter, enrichWithProofs } from "../src/services/proof-of-work";
import type { ProofArtifact } from "../src/services/proof-of-work";

describe("Proof-of-Work Generation", () => {
  it("should generate a proof artifact with technical brief", async () => {
    const artifact = await generateProofArtifact({
      jobId: "test-123",
      title: "Build a FastAPI + React Dashboard",
      description: "Need a full-stack developer to build a real-time analytics dashboard",
      tags: ["python", "fastapi", "react"],
    });

    expect(artifact).not.toBeNull();
    expect(artifact!.brief.analysis).toContain("FastAPI");
    expect(artifact!.brief.codeSnippets.length).toBeGreaterThan(0);
    expect(artifact!.brief.architectureDiagram).toBeTruthy();
    expect(artifact!.brief.implementationPlan).toContain("Phase");
    // No GITHUB_TOKEN set, so type should be inline
    expect(artifact!.type).toBe("inline");
  });

  it("should handle enrichment of multiple jobs", async () => {
    const jobs = [
      { jobId: "j1", title: "Job 1", description: "Build something", tags: ["python"] },
      { jobId: "j2", title: "Job 2", description: "Build something else", tags: ["react"] },
    ];
    const results = await enrichWithProofs(jobs);
    expect(results.size).toBe(2);
  });

  it("should return empty map for no jobs", async () => {
    const results = await enrichWithProofs([]);
    expect(results.size).toBe(0);
  });
});

describe("Cover Letter Formatting", () => {
  it("should format artifact with URL", () => {
    const artifact: ProofArtifact = {
      type: "gist",
      url: "https://gist.github.com/user/abc123",
      brief: {
        analysis: "This is a great project. I would approach it this way.",
        architectureDiagram: "diagram",
        codeSnippets: [],
        implementationPlan: "plan",
      },
      generatedAt: new Date().toISOString(),
    };
    const text = formatProofForCoverLetter(artifact);
    expect(text).toContain("gist.github.com");
    expect(text).toContain("technical brief");
  });

  it("should format artifact without URL (inline)", () => {
    const artifact: ProofArtifact = {
      type: "inline",
      brief: {
        analysis: "This is a great project. I would approach it this way.",
        architectureDiagram: "diagram",
        codeSnippets: [],
        implementationPlan: "plan",
      },
      generatedAt: new Date().toISOString(),
    };
    const text = formatProofForCoverLetter(artifact);
    expect(text).toContain("initial take");
    expect(text).not.toContain("gist.github.com");
  });
});
