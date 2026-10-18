/**
 * tests/my-proposals-sync.test.ts — outcome-tracking-001 sync logic.
 *
 * Exercises the row → outcome mapping and the safety rules in
 * syncMyProposalOutcomes (don't downgrade terminal states, skip rows we
 * can't match by title, no-op when nothing to do).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { classifyMyProposalStatus } from "../src/browser/upwork";

const h = vi.hoisted(() => ({
  getProposalsByFilterMock: vi.fn(),
  recordOutcomeMock: vi.fn(),
}));

vi.mock("../src/services/cloud", () => ({
  getProposalsByFilter: h.getProposalsByFilterMock,
  recordOutcome: h.recordOutcomeMock,
}));

vi.mock("../src/config/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  vi.resetAllMocks();
  h.getProposalsByFilterMock.mockResolvedValue([]);
  h.recordOutcomeMock.mockResolvedValue(undefined);
});

describe("classifyMyProposalStatus", () => {
  it("maps row text to status", () => {
    expect(classifyMyProposalStatus("Submitted Apr 1 — Viewed by client")).toBe("viewed");
    expect(classifyMyProposalStatus("Client messaged you")).toBe("messaged");
    expect(classifyMyProposalStatus("You were hired")).toBe("hired");
    expect(classifyMyProposalStatus("Not selected for this job")).toBe("declined");
    expect(classifyMyProposalStatus("active proposal")).toBe("submitted");
    expect(classifyMyProposalStatus("nothing useful here")).toBe("unknown");
  });

  it("prioritizes messaged over a stray 'viewed' mention", () => {
    expect(classifyMyProposalStatus("Viewed by client. Client messaged you.")).toBe("messaged");
  });
});

describe("syncMyProposalOutcomes", () => {
  it("writes outcomes for matched rows and skips non-terminal statuses", async () => {
    const { syncMyProposalOutcomes } = await import("../src/services/my-proposals-sync");
    h.getProposalsByFilterMock.mockResolvedValueOnce([
      { job_id: "job-A-id-1", job_title: "Build me an automation pipeline", status: "submitted" },
      { job_id: "job-B-id-2", job_title: "AI chatbot for crm", status: "submitted" },
      { job_id: "job-C-id-3", job_title: "Existing won job", status: "won" },
    ]);

    const result = await syncMyProposalOutcomes([
      { proposalId: "1", jobTitle: "Build me an automation pipeline", jobUrl: "u", status: "messaged", raw: "messaged" },
      { proposalId: "2", jobTitle: "AI chatbot for crm", jobUrl: "u", status: "viewed", raw: "viewed by client" },
      { proposalId: "3", jobTitle: "Existing won job", jobUrl: "u", status: "messaged", raw: "messaged" },
      { proposalId: "4", jobTitle: "Title we don't track", jobUrl: "u", status: "hired", raw: "hired" },
    ]);

    expect(result.scanned).toBe(4);
    expect(result.updated).toBe(1);   // only job-A
    expect(result.unmatched).toBe(1); // job-D
    expect(h.recordOutcomeMock).toHaveBeenCalledTimes(1);
    expect(h.recordOutcomeMock).toHaveBeenCalledWith("job-A-id-1", "interviewed");
  });

  it("returns empty result when there are no rows", async () => {
    const { syncMyProposalOutcomes } = await import("../src/services/my-proposals-sync");
    const result = await syncMyProposalOutcomes([]);
    expect(result).toEqual({ scanned: 0, updated: 0, skipped: 0, unmatched: 0 });
    expect(h.recordOutcomeMock).not.toHaveBeenCalled();
  });

  it("does not re-record when current status already matches the new outcome", async () => {
    const { syncMyProposalOutcomes } = await import("../src/services/my-proposals-sync");
    h.getProposalsByFilterMock.mockResolvedValueOnce([
      { job_id: "j1", job_title: "Already interviewed", status: "interviewed" },
    ]);
    const result = await syncMyProposalOutcomes([
      { proposalId: "1", jobTitle: "Already interviewed", jobUrl: "u", status: "messaged", raw: "messaged" },
    ]);
    expect(result.updated).toBe(0);
    expect(h.recordOutcomeMock).not.toHaveBeenCalled();
  });
});
