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
