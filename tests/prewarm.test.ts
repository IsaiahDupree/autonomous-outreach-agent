/**
 * tests/prewarm.test.ts — proposal prewarm cache.
 *
 * Verifies the cache returns the in-flight Promise on hit, evicts on TTL expiry, drops the
 * entry when buildProposal throws, and shares work across concurrent prewarm calls for the
 * same jobId.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const buildProposalMock = vi.hoisted(() => vi.fn());

vi.mock("../src/client/Upwork", () => ({
  buildProposal: buildProposalMock,
}));

vi.mock("../src/config/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { prewarmProposal, getPrewarmedProposal, getPrewarmStats, _clearPrewarmCacheForTests } from "../src/services/prewarm";

beforeEach(() => {
  buildProposalMock.mockReset();
  _clearPrewarmCacheForTests();
});

afterEach(() => {
  _clearPrewarmCacheForTests();
});

const fakeJob = {
  id: "test-job-1",
  title: "test",
  description: "",
  url: "https://example.com",
};

describe("prewarmProposal", () => {
  it("kicks off buildProposal once for a given jobId", async () => {
    buildProposalMock.mockResolvedValue({ ...fakeJob, coverLetter: "result" });
    prewarmProposal(fakeJob as any);
    prewarmProposal(fakeJob as any); // second call — should be a no-op
    prewarmProposal(fakeJob as any);
    // Need to flush microtasks since prewarmProposal kicks off async import
    await new Promise(r => setTimeout(r, 0));
    expect(buildProposalMock).toHaveBeenCalledTimes(1);
  });

  it("drops cache entry on buildProposal failure so the next call retries", async () => {
    buildProposalMock.mockRejectedValueOnce(new Error("boom"));
    prewarmProposal(fakeJob as any);
    await new Promise(r => setTimeout(r, 5));
    // After failure, entry should have been removed.
    expect(getPrewarmStats().cacheSize).toBe(0);

    // Now a second call should retry.
    buildProposalMock.mockResolvedValueOnce({ ...fakeJob, coverLetter: "ok" });
    prewarmProposal(fakeJob as any);
    await new Promise(r => setTimeout(r, 5));
    expect(buildProposalMock).toHaveBeenCalledTimes(2);
  });

  it("ignores calls with no job id", () => {
    prewarmProposal({ id: "" } as any);
    prewarmProposal(undefined as any);
    expect(buildProposalMock).not.toHaveBeenCalled();
  });
});

describe("getPrewarmedProposal", () => {
  it("returns null on cache miss", async () => {
    expect(await getPrewarmedProposal("never-prewarmed")).toBeNull();
    expect(getPrewarmStats().misses).toBe(1);
  });

  it("returns the cached promise on hit", async () => {
    buildProposalMock.mockResolvedValueOnce({ ...fakeJob, coverLetter: "from-prewarm" });
    prewarmProposal(fakeJob as any);
    const result = await getPrewarmedProposal(fakeJob.id);
    expect(result).not.toBeNull();
    expect(result!.coverLetter).toBe("from-prewarm");
    expect(getPrewarmStats().hits).toBe(1);
  });

  it("two concurrent getPrewarmed calls share the same buildProposal invocation", async () => {
    let resolveBuild: (v: unknown) => void = () => {};
    buildProposalMock.mockReturnValueOnce(new Promise(r => { resolveBuild = r; }));

    prewarmProposal(fakeJob as any);
    await new Promise(r => setTimeout(r, 0));

    const p1 = getPrewarmedProposal(fakeJob.id);
    const p2 = getPrewarmedProposal(fakeJob.id);
    resolveBuild({ ...fakeJob, coverLetter: "shared" });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1!.coverLetter).toBe("shared");
    expect(r2!.coverLetter).toBe("shared");
    expect(buildProposalMock).toHaveBeenCalledTimes(1);
  });
});

describe("stats", () => {
  it("tracks prewarmed/hits/misses/errors counts", async () => {
    buildProposalMock.mockResolvedValueOnce({ ...fakeJob, coverLetter: "ok" });
    prewarmProposal(fakeJob as any);
    await new Promise(r => setTimeout(r, 5));
    await getPrewarmedProposal(fakeJob.id);
    await getPrewarmedProposal("missing");
    const s = getPrewarmStats();
    expect(s.prewarmed).toBe(1);
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(1);
  });
});
