/**
 * tests/auto-send.integration.test.ts — gate AUTO_SEND before it touches Upwork.
 *
 * Exercises runProposalCycle end-to-end with every external boundary mocked:
 *   browser/upwork (Puppeteer)  · Telegram · Obsidian · Anthropic · Supabase fetch · scorer
 *
 * Verifies that with AUTO_SEND=true:
 *   1. A high-scoring job reaches upworkBrowser.submitProposal — the actual submission step.
 *   2. A low-scoring job stays in the manual-approval branch and never calls submitProposal.
 *   3. When connects drop below 16 right before submission, the auto-send is skipped and the
 *      proposal goes back to status="queued".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoisted mocks (vitest hoists vi.mock() above const declarations, so any fn the factories
// reference must live in vi.hoisted() to survive the hoist) ──────────
const h = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  submitProposalMock: vi.fn(),
  scanJobsMock: vi.fn(),
  getConnectsRemainingMock: vi.fn(),
  scoreJobMock: vi.fn(),
  aiCompleteMock: vi.fn(),
}));

global.fetch = h.mockFetch as unknown as typeof fetch;

// ─── Module mocks ────────────────────────────────────────────────────
vi.mock("../src/secret", () => ({
  ANTHROPIC_API_KEY: "test",
  ANTHROPIC_AUTH_TOKEN: "",
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_KEY: "test-key",
  TELEGRAM_BOT_TOKEN: "",
  TELEGRAM_CHAT_ID: "",
  CRMLITE_URL: "",
  CRMLITE_API_KEY: "",
  OBSIDIAN_VAULT: "",
  LINKEDIN_EMAIL: "",
  LINKEDIN_PASSWORD: "",
  SAFARI_UPWORK_PORT: 7070,
  SAFARI_LINKEDIN_PORT: 7070,
  SAFARI_SERVICE_URL: "http://localhost:7070",
  CHROME_CDP_PORT: 9222,
  PORT: 3500,
  BROWSER_MODE: "puppeteer",
  BROWSER_HEADLESS: true,
  AUTO_SEND: true,
  AUTO_SEND_MIN_SCORE: 7,
  AUTO_SEND_MIN_CONNECTS: 16,
  PERPLEXITY_API_KEY: "",
  GITHUB_TOKEN: "",
  OPENAI_API_KEY: "",
  TRACKING_BASE_URL: "https://outreach.test",
}));

vi.mock("../src/config/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/browser/upwork", () => ({
  scanJobs: h.scanJobsMock,
  scrapeBestMatches: vi.fn().mockResolvedValue([]),
  getJobDetails: vi.fn(),
  submitProposal: h.submitProposalMock,
  getConnectsRemaining: h.getConnectsRemainingMock,
  getLastSubmitConnectsCost: vi.fn(() => 16),
  resetLastSubmitConnectsCost: vi.fn(),
  getLastSubmitFailure: vi.fn(() => ({ reason: null, detail: null })),
  setSubmitFailure: vi.fn(),
  resetSubmitFailure: vi.fn(),
  getLastProposalsAtSubmit: vi.fn(() => null),
  resetLastProposalsAtSubmit: vi.fn(),
  ensureUpworkLoggedIn: vi.fn(async () => true),
  scrapeArchivedProposals: vi.fn().mockResolvedValue([]),
  getNotifications: vi.fn().mockResolvedValue([]),
}));

vi.mock("../src/services/telegram", () => ({
  notify: vi.fn().mockResolvedValue(undefined),
  sendForApproval: vi.fn().mockResolvedValue(undefined),
  waitForApproval: vi.fn().mockResolvedValue({ action: "skip" }),
}));

vi.mock("../src/services/obsidian", () => ({
  logProposal: vi.fn(),
  appendDailyNote: vi.fn(),
  logProspect: vi.fn(),
  createWonJobNote: vi.fn(),
}));

vi.mock("../src/services/research", () => ({
  researchJob: vi.fn().mockResolvedValue(null),
  formatResearchBrief: vi.fn().mockReturnValue(""),
}));

vi.mock("../src/Agent/scorer", () => ({
  scoreJob: h.scoreJobMock,
  invalidateNicheCache: vi.fn(),
}));

vi.mock("../src/services/ai-fallback", () => ({
  aiComplete: h.aiCompleteMock,
}));

// Import AFTER all mocks are in place.
import { runProposalCycle } from "../src/client/Upwork";

// ─── Fixtures ────────────────────────────────────────────────────────
const FAKE_JOB = {
  id: "test-job-001",
  title: "Build n8n + HubSpot integration",
  description: "We need an automation that syncs new Stripe payments into HubSpot deals. Currently spending 4 hours per day doing this manually.",
  url: "https://www.upwork.com/jobs/~test-job-001",
  budget: "$1,000-$2,000",
  source: "search" as const,
};

const WINNING_COVER_LETTER = `Hi there, I'd love to help with this n8n and HubSpot integration.

<problem>You're spending 4 hours per day moving Stripe payments into HubSpot manually — that's 20 hours per week your team isn't selling, and every missed sync risks a deal falling through the cracks.</problem>

<solution>I'll wire up an n8n workflow that listens to Stripe webhooks and pushes structured deal records into HubSpot via their API. Stack: n8n cloud, HubSpot CRM API v3, retry/dedupe logic with idempotency keys, and Slack alerts on failures.</solution>

<proof>Here's a similar n8n and Stripe pipeline I open-sourced: https://github.com/example/n8n-stripe-hubspot</proof>

<portfolio>I put together a tailored page showing exactly this kind of work for SaaS clients: https://example.com/portfolio</portfolio>

<prior_results>I built the same flow for a Shopify SaaS client — reduced their manual reconciliation time from 5 hours per day to zero, and the integration ran at 99.9 percent uptime over 6 months without intervention.</prior_results>

<cta>Want to hop on a 15-minute call to walk through your current Stripe and HubSpot setup? I can sketch the architecture live and quote a fixed-bid timeline.

Best,
Isaiah</cta>`;

beforeEach(() => {
  vi.clearAllMocks();
  h.mockFetch.mockReset();

  // Default fetch handler: every Supabase REST call returns ok with empty body. Tests that
  // care about specific responses (e.g. proposalExistsBatch) override with mockResolvedValueOnce.
  h.mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve([]),
    text: () => Promise.resolve(""),
  });

  h.aiCompleteMock.mockResolvedValue({
    provider: "anthropic",
    text: WINNING_COVER_LETTER,
  });

  h.scanJobsMock.mockResolvedValue([{ ...FAKE_JOB }]);
  h.getConnectsRemainingMock.mockReturnValue(100);
  h.submitProposalMock.mockResolvedValue(true);
});

// Helper: find the saveProposal POST that captured a given status, returning the parsed body.
function findSaveWithStatus(status: string): Record<string, unknown> | undefined {
  for (const [url, opts] of h.mockFetch.mock.calls as Array<[string, RequestInit]>) {
    if (typeof url !== "string" || !url.includes("/upwork_proposals")) continue;
    if (opts.method !== "POST" && opts.method !== "PATCH") continue;
    if (!opts.body) continue;
    try {
      const body = JSON.parse(opts.body as string);
      if (body.status === status) return body;
    } catch { /* not JSON, skip */ }
  }
  return undefined;
}

describe("AUTO_SEND integration: high-scoring job reaches submitProposal", () => {
  it("calls upworkBrowser.submitProposal exactly once with the generated cover letter", async () => {
    h.scoreJobMock.mockResolvedValueOnce({
      score: 8, preScore: 75,
      bidRange: "$800-$1200",
      reasoning: "Strong AI/automation fit",
      tags: ["ai", "n8n", "automation"],
    });

    await runProposalCycle(["AI automation"], {}, 6);

    expect(h.submitProposalMock).toHaveBeenCalledTimes(1);
    const [url, coverLetter, opts] = h.submitProposalMock.mock.calls[0];
    expect(url).toBe(FAKE_JOB.url);
    expect(typeof coverLetter).toBe("string");
    expect(coverLetter.length).toBeGreaterThan(100);
    expect(coverLetter).toContain("Isaiah");
    expect(opts).toBeDefined();
  });

  it("persists the proposal with status=auto_sending before submission and updates to submitted after", async () => {
    h.scoreJobMock.mockResolvedValueOnce({
      score: 9, preScore: 85, bidRange: "$1500", reasoning: "Perfect fit", tags: ["n8n", "ai"],
    });

    await runProposalCycle(["n8n automation"], {}, 6);

    const autoSendingSave = findSaveWithStatus("auto_sending");
    expect(autoSendingSave, "expected a saveProposal call with status=auto_sending").toBeDefined();
    expect(autoSendingSave!.job_id).toBe(FAKE_JOB.id);

    const submittedUpdate = findSaveWithStatus("submitted");
    expect(submittedUpdate, "expected a status update to 'submitted' after submitProposal succeeded").toBeDefined();
  });

  it("attaches parsed proposal slots to the saved row", async () => {
    h.scoreJobMock.mockResolvedValueOnce({
      score: 8, preScore: 80, bidRange: "$1000", reasoning: "Good fit", tags: ["ai", "automation"],
    });

    await runProposalCycle(["AI automation"], {}, 6);

    const autoSendingSave = findSaveWithStatus("auto_sending");
    expect(autoSendingSave?.proposal_slots_json).toBeDefined();
    const slots = autoSendingSave?.proposal_slots_json as Record<string, string>;
    expect(slots.problem).toMatch(/4 hours/);
    expect(slots.solution).toMatch(/n8n/i);
    expect(slots.cta).toMatch(/Isaiah/);
  });
});

describe("AUTO_SEND integration: low-scoring job stays manual", () => {
  it("does NOT call submitProposal when score is below AUTO_SEND_MIN_SCORE", async () => {
    h.scoreJobMock.mockResolvedValueOnce({
      score: 6, preScore: 50, bidRange: "$500", reasoning: "Borderline fit", tags: ["python"],
    });

    await runProposalCycle(["python"], {}, 6);

    expect(h.submitProposalMock).not.toHaveBeenCalled();
    // Should still save with status=pending so it shows up in the approval queue.
    expect(findSaveWithStatus("pending")).toBeDefined();
  });
});

describe("AUTO_SEND integration: connects guard", () => {
  it("aborts the auto-send branch when connects drop below 16 between scoring and submission", async () => {
    h.scoreJobMock.mockResolvedValueOnce({
      score: 9, preScore: 90, bidRange: "$2000", reasoning: "Top-tier fit", tags: ["ai", "n8n"],
    });

    // The pre-loop check sees plenty of connects, but the right-before-submit check sees a
    // critically low number — auto-send should bail and revert status to queued.
    let calls = 0;
    h.getConnectsRemainingMock.mockImplementation(() => (++calls === 1 ? 100 : 10));

    await runProposalCycle(["AI automation"], {}, 6);

    expect(h.submitProposalMock).not.toHaveBeenCalled();
    // Status should have been written as auto_sending then patched back to queued.
    const queuedPatch = findSaveWithStatus("queued");
    expect(queuedPatch, "expected a status PATCH back to 'queued' after the connects guard").toBeDefined();
  });

  it("aborts before even building the proposal when connects start critically low", async () => {
    h.scoreJobMock.mockResolvedValueOnce({
      score: 9, preScore: 90, bidRange: "$2000", reasoning: "Top fit", tags: ["ai"],
    });
    h.getConnectsRemainingMock.mockReturnValue(10);

    await runProposalCycle(["AI automation"], {}, 6);

    expect(h.submitProposalMock).not.toHaveBeenCalled();
  });
});
