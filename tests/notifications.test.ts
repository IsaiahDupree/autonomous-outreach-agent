/**
 * tests/notifications.test.ts — Tests for notification classification, dedup,
 * and checkAndProcessNotifications orchestration.
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
  AUTO_SEND: true,
  AUTO_SEND_MIN_SCORE: 7,
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_CHAT_ID: "test-chat",
}));

vi.mock("../src/config/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/services/telegram", () => ({
  notify: vi.fn().mockResolvedValue(undefined),
  notifyWithActions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/services/cloud", () => ({
  checkService: vi.fn().mockResolvedValue(false),
  getPendingProposals: vi.fn().mockResolvedValue([]),
  getProposalsByFilter: vi.fn().mockResolvedValue([]),
  saveProposal: vi.fn().mockResolvedValue(true),
  updateProposalStatus: vi.fn().mockResolvedValue(undefined),
  recordOutcome: vi.fn().mockResolvedValue(undefined),
  proposalExists: vi.fn().mockResolvedValue(false),
  getProposalMetrics: vi.fn().mockResolvedValue({
    submitted: 10, won: 2, rejected: 3, noResponse: 5, avgScore: 7.5,
  }),
}));

vi.mock("../src/browser/upwork", () => ({
  checkNotifications: vi.fn().mockResolvedValue([]),
  getJobDetails: vi.fn().mockResolvedValue(null),
  getConnectsRemaining: vi.fn().mockReturnValue(84),
  scrapeArchivedProposals: vi.fn().mockResolvedValue([]),
}));

vi.mock("../src/Agent/scorer", () => ({
  scoreJob: vi.fn().mockResolvedValue({ score: 8, preScore: 7, tags: ["ai"], reasoning: "Good fit", excluded: false }),
}));

vi.mock("../src/browser/engine", () => ({
  newPage: vi.fn(),
  close: vi.fn(),
}));

import type { UpworkNotification } from "../src/browser/upwork";
import * as upworkBrowser from "../src/browser/upwork";
import * as cloud from "../src/services/cloud";
import * as tg from "../src/services/telegram";
import { checkAndProcessNotifications, syncArchivedProposals, analyzeLessonsLearned } from "../src/client/Upwork";

// ── Helper: build a notification ──

function makeNotif(overrides: Partial<UpworkNotification>): UpworkNotification {
  return {
    id: "notif-1",
    type: "other",
    title: "Test notification",
    body: "",
    time: "2:00 PM",
    isUnread: false,
    raw: "Test notification",
    ...overrides,
  };
}

// ── Classification tests ──

describe("Notification classification", () => {
  // These test the classifier logic indirectly via checkAndProcessNotifications
  // by mocking checkNotifications to return pre-classified data

  it("identifies job_alert notifications as non-actionable", async () => {
    vi.mocked(upworkBrowser.checkNotifications).mockResolvedValue([
      makeNotif({ type: "job_alert", title: "New job: AI Developer", jobTitle: "AI Developer" }),
      makeNotif({ type: "job_alert", title: "New job: Python Automation", jobTitle: "Python Automation" }),
    ]);

    const result = await checkAndProcessNotifications();
    expect(result.total).toBe(2);
    expect(result.actionable).toBe(0);
    // Should NOT notify Telegram for job alerts
    expect(tg.notify).not.toHaveBeenCalled();
  });

  it("identifies proposal_viewed as non-actionable", async () => {
    vi.mocked(upworkBrowser.checkNotifications).mockResolvedValue([
      makeNotif({ type: "proposal_viewed", title: "Your proposal was viewed", jobTitle: "AI Chatbot" }),
    ]);

    const result = await checkAndProcessNotifications();
    expect(result.total).toBe(1);
    expect(result.actionable).toBe(0);
    expect(tg.notify).not.toHaveBeenCalled();
  });

  it("identifies interview_invite as actionable", async () => {
    vi.mocked(upworkBrowser.checkNotifications).mockResolvedValue([
      makeNotif({
        type: "interview_invite",
        title: "You've been invited to interview",
        jobTitle: "AI Agent Builder",
        url: "https://www.upwork.com/jobs/~0abc123",
        isUnread: true,
      }),
    ]);
    // Mock getJobDetails to return null so auto-apply doesn't run
    vi.mocked(upworkBrowser.getJobDetails).mockResolvedValue(null);

    const result = await checkAndProcessNotifications();
    expect(result.actionable).toBe(1);
    expect(tg.notify).toHaveBeenCalled();
  });

  it("identifies offer as actionable", async () => {
    vi.mocked(upworkBrowser.checkNotifications).mockResolvedValue([
      makeNotif({ type: "offer", title: "You received an offer", isUnread: true }),
    ]);

    const result = await checkAndProcessNotifications();
    expect(result.actionable).toBe(1);
    expect(tg.notify).toHaveBeenCalled();
  });

  it("identifies hire as actionable", async () => {
    vi.mocked(upworkBrowser.checkNotifications).mockResolvedValue([
      makeNotif({ type: "hire", title: "You've been hired", jobTitle: "AI Bot", isUnread: true }),
    ]);

    const result = await checkAndProcessNotifications();
    expect(result.actionable).toBe(1);
  });

  it("identifies message as actionable", async () => {
    vi.mocked(upworkBrowser.checkNotifications).mockResolvedValue([
      makeNotif({ type: "message", title: "New message from client", isUnread: true }),
    ]);

    const result = await checkAndProcessNotifications();
    expect(result.actionable).toBe(1);
  });

  it("identifies proposal_declined as actionable", async () => {
    vi.mocked(upworkBrowser.checkNotifications).mockResolvedValue([
      makeNotif({ type: "proposal_declined", title: "Your proposal was declined", jobTitle: "Web App", isUnread: true }),
    ]);

    const result = await checkAndProcessNotifications();
    expect(result.actionable).toBe(1);
  });

  it("returns empty when no notifications found", async () => {
    vi.mocked(upworkBrowser.checkNotifications).mockResolvedValue([]);

    const result = await checkAndProcessNotifications();
    expect(result.total).toBe(0);
    expect(result.unread).toBe(0);
    expect(result.actionable).toBe(0);
    expect(result.notifications).toEqual([]);
  });
});

// ── Unread counting ──

describe("Unread counting", () => {
  it("counts unread notifications correctly", async () => {
    vi.mocked(upworkBrowser.checkNotifications).mockResolvedValue([
      makeNotif({ type: "job_alert", isUnread: true }),
      makeNotif({ id: "n2", type: "job_alert", isUnread: true }),
      makeNotif({ id: "n3", type: "job_alert", isUnread: false }),
      makeNotif({ id: "n4", type: "proposal_viewed", isUnread: true }),
    ]);

    const result = await checkAndProcessNotifications();
    expect(result.total).toBe(4);
    expect(result.unread).toBe(3);
  });
});

// ── Auto-record outcomes ──

describe("Auto-record outcomes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("auto-records win from hire notification", async () => {
    vi.mocked(upworkBrowser.checkNotifications).mockResolvedValue([
      makeNotif({ type: "hire", title: "You've been hired", jobTitle: "AI Chatbot Project", isUnread: true }),
    ]);
    vi.mocked(cloud.getProposalsByFilter).mockResolvedValue([
      { job_id: "abc123", job_title: "AI Chatbot Project Development", status: "submitted" } as any,
    ]);

    await checkAndProcessNotifications();
    expect(cloud.recordOutcome).toHaveBeenCalledWith("abc123", "won");
  });

  it("auto-records rejected from proposal_declined notification", async () => {
    vi.mocked(upworkBrowser.checkNotifications).mockResolvedValue([
      makeNotif({ type: "proposal_declined", title: "Not selected", jobTitle: "Web Scraping Tool", isUnread: true }),
    ]);
    vi.mocked(cloud.getProposalsByFilter).mockResolvedValue([
      { job_id: "def456", job_title: "Web Scraping Tool for Real Estate", status: "submitted" } as any,
    ]);

    await checkAndProcessNotifications();
    expect(cloud.recordOutcome).toHaveBeenCalledWith("def456", "rejected");
  });

  it("auto-records interviewed from interview_invite notification", async () => {
    vi.mocked(upworkBrowser.checkNotifications).mockResolvedValue([
      makeNotif({
        type: "interview_invite",
        title: "Interview invite",
        jobTitle: "Python Automation",
        url: "https://www.upwork.com/jobs/~0abc999",
        isUnread: true,
      }),
    ]);
    vi.mocked(upworkBrowser.getJobDetails).mockResolvedValue(null);
    vi.mocked(cloud.getProposalsByFilter).mockResolvedValue([
      { job_id: "ghi789", job_title: "Python Automation for Data Pipeline", status: "submitted" } as any,
    ]);

    await checkAndProcessNotifications();
    expect(cloud.recordOutcome).toHaveBeenCalledWith("ghi789", "interviewed");
  });

  it("does not record outcome when no matching proposal found", async () => {
    vi.mocked(upworkBrowser.checkNotifications).mockResolvedValue([
      makeNotif({ type: "hire", title: "You've been hired", jobTitle: "Unknown Project", isUnread: true }),
    ]);
    vi.mocked(cloud.getProposalsByFilter).mockResolvedValue([]);

    await checkAndProcessNotifications();
    expect(cloud.recordOutcome).not.toHaveBeenCalled();
  });
});

// ── Telegram forwarding ──

describe("Telegram notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards actionable notifications to Telegram", async () => {
    vi.mocked(upworkBrowser.checkNotifications).mockResolvedValue([
      makeNotif({ type: "offer", title: "You received an offer for AI Bot", clientName: "John Smith", isUnread: true }),
      makeNotif({ id: "n2", type: "message", title: "New message from client", isUnread: true }),
    ]);

    await checkAndProcessNotifications();
    expect(tg.notify).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(tg.notify).mock.calls[0][0];
    expect(msg).toContain("2 Upwork notifications");
    expect(msg).toContain("OFFER");
    expect(msg).toContain("MESSAGE");
  });

  it("does not send Telegram when only non-actionable notifications", async () => {
    vi.mocked(upworkBrowser.checkNotifications).mockResolvedValue([
      makeNotif({ type: "job_alert", title: "New job: Something" }),
      makeNotif({ id: "n2", type: "proposal_viewed", title: "Proposal viewed" }),
    ]);

    await checkAndProcessNotifications();
    expect(tg.notify).not.toHaveBeenCalled();
  });

  it("includes client name and job title in Telegram message", async () => {
    vi.mocked(upworkBrowser.checkNotifications).mockResolvedValue([
      makeNotif({
        type: "hire", title: "You've been hired",
        clientName: "Jane Doe", jobTitle: "AI Dashboard",
        url: "https://www.upwork.com/jobs/~0xyz",
        isUnread: true,
      }),
    ]);
    vi.mocked(cloud.getProposalsByFilter).mockResolvedValue([]);

    await checkAndProcessNotifications();
    expect(tg.notify).toHaveBeenCalled();
    const msg = vi.mocked(tg.notify).mock.calls[0][0];
    expect(msg).toContain("Jane Doe");
    expect(msg).toContain("AI Dashboard");
  });
});

// ── Mixed notification batch ──

describe("Mixed notification batches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles a realistic mix of notification types", async () => {
    vi.mocked(upworkBrowser.checkNotifications).mockResolvedValue([
      makeNotif({ id: "n1", type: "job_alert", title: "New job: AI Dev", isUnread: true }),
      makeNotif({ id: "n2", type: "job_alert", title: "New job: Python Script", isUnread: true }),
      makeNotif({ id: "n3", type: "proposal_viewed", title: "Proposal viewed", jobTitle: "CRM Tool", isUnread: true }),
      makeNotif({ id: "n4", type: "hire", title: "Hired!", jobTitle: "AI Agent", isUnread: true }),
      makeNotif({ id: "n5", type: "message", title: "New message", isUnread: true }),
      makeNotif({ id: "n6", type: "job_alert", title: "New job: Web Scraper", isUnread: false }),
    ]);
    vi.mocked(cloud.getProposalsByFilter).mockResolvedValue([
      { job_id: "agent1", job_title: "AI Agent Development", status: "submitted" } as any,
    ]);

    const result = await checkAndProcessNotifications();
    expect(result.total).toBe(6);
    expect(result.unread).toBe(5);
    expect(result.actionable).toBe(2); // hire + message
    expect(tg.notify).toHaveBeenCalled();
    expect(cloud.recordOutcome).toHaveBeenCalledWith("agent1", "won");
  });
});

// ── Invite auto-apply skip (already processed) ──

describe("Invite dedup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips invite auto-apply when job already exists in Supabase", async () => {
    vi.mocked(upworkBrowser.checkNotifications).mockResolvedValue([
      makeNotif({
        type: "interview_invite",
        title: "Invited to interview",
        url: "https://www.upwork.com/jobs/~0abc123def456",
        isUnread: true,
      }),
    ]);
    vi.mocked(cloud.proposalExists).mockResolvedValue(true);

    await checkAndProcessNotifications();
    // Should NOT call getJobDetails since proposal already exists
    expect(upworkBrowser.getJobDetails).not.toHaveBeenCalled();
  });
});

// ── Sync Archived Proposals ──

describe("syncArchivedProposals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty when no archived proposals found", async () => {
    vi.mocked(upworkBrowser.scrapeArchivedProposals).mockResolvedValue([]);

    const result = await syncArchivedProposals();
    expect(result.total).toBe(0);
    expect(result.synced).toBe(0);
    expect(result.hired).toEqual([]);
    expect(result.lost).toEqual([]);
  });

  it("syncs hired proposals as won by title match", async () => {
    vi.mocked(upworkBrowser.scrapeArchivedProposals).mockResolvedValue([
      { jobTitle: "AI Agent Builder", jobUrl: "https://upwork.com/nx/proposals/123", jobId: "123", status: "hired", raw: "hired" },
    ]);
    // Bulk query returns all tracked proposals — title matching finds it
    vi.mocked(cloud.getProposalsByFilter).mockResolvedValue([
      { job_id: "~0abc", job_title: "AI Agent Builder", status: "submitted" } as any,
    ]);

    const result = await syncArchivedProposals();
    expect(result.hired.length).toBe(1);
    expect(cloud.recordOutcome).toHaveBeenCalledWith("~0abc", "won");
  });

  it("syncs declined proposals as rejected by title match", async () => {
    vi.mocked(upworkBrowser.scrapeArchivedProposals).mockResolvedValue([
      { jobTitle: "Web App Development", jobUrl: "https://upwork.com/nx/proposals/456", jobId: "456", status: "declined", raw: "declined" },
    ]);
    vi.mocked(cloud.getProposalsByFilter).mockResolvedValue([
      { job_id: "~0def", job_title: "Web App Development", status: "submitted" } as any,
    ]);

    const result = await syncArchivedProposals();
    expect(result.lost.length).toBe(1);
    expect(cloud.recordOutcome).toHaveBeenCalledWith("~0def", "rejected");
  });

  it("creates new record for untracked archived proposals", async () => {
    vi.mocked(upworkBrowser.scrapeArchivedProposals).mockResolvedValue([
      { jobTitle: "New Job Title", jobUrl: "https://upwork.com/nx/proposals/789", jobId: "xyz789", status: "closed", raw: "closed" },
    ]);
    vi.mocked(cloud.getProposalsByFilter).mockResolvedValue([]);

    const result = await syncArchivedProposals();
    expect(result.synced).toBe(1);
    expect(cloud.saveProposal).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "xyz789",
      title: "New Job Title",
      status: "no_response",
    }));
  });

  it("skips proposals already marked as won", async () => {
    vi.mocked(upworkBrowser.scrapeArchivedProposals).mockResolvedValue([
      { jobTitle: "Done Job", jobUrl: "https://upwork.com/nx/proposals/111", jobId: "aaa111", status: "hired", raw: "hired" },
    ]);
    vi.mocked(cloud.getProposalsByFilter).mockResolvedValue([
      { job_id: "~0aaa", job_title: "Done Job", status: "won" } as any,
    ]);

    const result = await syncArchivedProposals();
    expect(result.synced).toBe(0);
    expect(cloud.recordOutcome).not.toHaveBeenCalled();
  });

  it("skips withdrawn proposals (freelancer cancelled)", async () => {
    vi.mocked(upworkBrowser.scrapeArchivedProposals).mockResolvedValue([
      { jobTitle: "Withdrawn Job", jobUrl: "u", jobId: "w1", status: "withdrawn", raw: "" },
    ]);
    vi.mocked(cloud.getProposalsByFilter).mockResolvedValue([]);

    const result = await syncArchivedProposals();
    expect(result.synced).toBe(0);
    expect(cloud.saveProposal).not.toHaveBeenCalled();
    expect(cloud.recordOutcome).not.toHaveBeenCalled();
  });

  it("separates hired and lost proposals correctly", async () => {
    vi.mocked(upworkBrowser.scrapeArchivedProposals).mockResolvedValue([
      { jobTitle: "Won Job", jobUrl: "u", jobId: "w1", status: "hired", raw: "" },
      { jobTitle: "Lost 1", jobUrl: "u", jobId: "l1", status: "declined", raw: "" },
      { jobTitle: "Lost 2", jobUrl: "u", jobId: "l2", status: "closed", raw: "" },
      { jobTitle: "Lost 3", jobUrl: "u", jobId: "l3", status: "withdrawn", raw: "" },
    ]);
    vi.mocked(cloud.getProposalsByFilter).mockResolvedValue([]);

    const result = await syncArchivedProposals();
    expect(result.total).toBe(4);
    expect(result.hired.length).toBe(1);
    expect(result.lost.length).toBe(3);
  });
});

// ── Lessons Learned Analysis ──

describe("analyzeLessonsLearned", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty results when no proposals with outcomes", async () => {
    vi.mocked(cloud.getProposalsByFilter).mockResolvedValue([]);

    const result = await analyzeLessonsLearned();
    expect(result.totalAnalyzed).toBe(0);
    expect(result.won).toBe(0);
    expect(result.lost).toBe(0);
    expect(result.lessons.winPatterns).toEqual([]);
  });

  it("calculates bid analysis from won vs lost", async () => {
    vi.mocked(cloud.getProposalsByFilter).mockImplementation(async (filter) => {
      const status = (filter as any).status;
      if (status === "won") return [
        { job_id: "w1", job_title: "Won", score: 8, submitted_bid_amount: 500, tags: ["ai"], client_hire_rate: 60 } as any,
        { job_id: "w2", job_title: "Won2", score: 9, submitted_bid_amount: 700, tags: ["ai"], client_hire_rate: 80 } as any,
      ];
      if (status === "rejected") return [
        { job_id: "l1", job_title: "Lost", score: 6, submitted_bid_amount: 300, tags: ["web"], client_hire_rate: 30 } as any,
      ];
      return []; // no_response
    });

    const result = await analyzeLessonsLearned();
    expect(result.won).toBe(2);
    expect(result.lost).toBe(1);
    expect(result.lessons.bidAnalysis.avgWinBid).toBe(600);
    expect(result.lessons.bidAnalysis.avgLossBid).toBe(300);
    expect(result.lessons.clientProfile.avgHireRateWon).toBe(70);
    expect(result.lessons.clientProfile.avgHireRateLost).toBe(30);
  });

  it("computes niche performance from tags", async () => {
    vi.mocked(cloud.getProposalsByFilter).mockImplementation(async (filter) => {
      const status = (filter as any).status;
      if (status === "won") return [
        { job_id: "w1", score: 8, tags: ["ai", "python"], submitted_bid_amount: null, client_hire_rate: null } as any,
        { job_id: "w2", score: 7, tags: ["ai"], submitted_bid_amount: null, client_hire_rate: null } as any,
      ];
      if (status === "rejected") return [
        { job_id: "l1", score: 5, tags: ["web"], submitted_bid_amount: null, client_hire_rate: null } as any,
        { job_id: "l2", score: 6, tags: ["ai"], submitted_bid_amount: null, client_hire_rate: null } as any,
      ];
      return [];
    });

    const result = await analyzeLessonsLearned();
    const aiNiche = result.lessons.nichePerformance.find(n => n.niche === "ai");
    expect(aiNiche).toBeDefined();
    expect(aiNiche!.won).toBe(2);
    expect(aiNiche!.lost).toBe(1);
    expect(aiNiche!.winRate).toBe(67);
  });

  it("generates recommendations from data", async () => {
    vi.mocked(cloud.getProposalsByFilter).mockImplementation(async (filter) => {
      const status = (filter as any).status;
      if (status === "won") return [
        { job_id: "w1", score: 9, tags: ["automation"], submitted_bid_amount: 1000, client_hire_rate: 75 } as any,
      ];
      if (status === "rejected") return [
        { job_id: "l1", score: 5, tags: ["web"], submitted_bid_amount: 400, client_hire_rate: 20 } as any,
      ];
      return [];
    });

    const result = await analyzeLessonsLearned();
    expect(result.lessons.recommendations.length).toBeGreaterThan(0);
    expect(result.lessons.recommendations.some(r => r.includes("$1000"))).toBe(true);
  });
});
