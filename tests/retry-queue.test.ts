import { describe, it, expect, vi } from "vitest";

vi.mock("../src/config/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { RetryQueue } from "../src/services/retry-queue";

function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe("RetryQueue", () => {
  it("processes a successful item once and removes it", async () => {
    const clock = fakeClock();
    const proc = vi.fn().mockResolvedValue(true);
    const q = new RetryQueue<string>(proc, { now: clock.now, sleep: clock.sleep, jitter: false });
    q.enqueue("a", "payload-a");
    const res = await q.drain();
    expect(res.succeeded).toEqual(["a"]);
    expect(q.size()).toBe(0);
    expect(proc).toHaveBeenCalledTimes(1);
  });

  it("retries with exponential backoff and eventually succeeds", async () => {
    const clock = fakeClock();
    let calls = 0;
    const proc = vi.fn(async () => ++calls >= 3); // fail, fail, succeed
    const q = new RetryQueue<string>(proc, {
      now: clock.now,
      sleep: clock.sleep,
      baseDelayMs: 100,
      factor: 2,
      jitter: false,
      maxAttempts: 5,
    });
    q.enqueue("job-1", "x");
    const res = await q.drain();
    expect(res.succeeded).toEqual(["job-1"]);
    expect(res.exhausted).toEqual([]);
    expect(proc).toHaveBeenCalledTimes(3);
  });

  it("gives up after maxAttempts and reports exhaustion", async () => {
    const clock = fakeClock();
    const proc = vi.fn().mockResolvedValue(false);
    const q = new RetryQueue<string>(proc, {
      now: clock.now,
      sleep: clock.sleep,
      baseDelayMs: 10,
      factor: 2,
      jitter: false,
      maxAttempts: 3,
    });
    q.enqueue("doomed", "x");
    const res = await q.drain();
    expect(res.succeeded).toEqual([]);
    expect(res.exhausted).toHaveLength(1);
    expect(res.exhausted[0].id).toBe("doomed");
    expect(res.exhausted[0].attempts).toBe(3);
    expect(proc).toHaveBeenCalledTimes(3);
  });

  it("treats thrown errors as failures and records lastError", async () => {
    const clock = fakeClock();
    const proc = vi.fn().mockRejectedValue(new Error("boom"));
    const q = new RetryQueue<string>(proc, {
      now: clock.now,
      sleep: clock.sleep,
      baseDelayMs: 1,
      jitter: false,
      maxAttempts: 2,
    });
    q.enqueue("err", "x");
    const res = await q.drain();
    expect(res.exhausted).toHaveLength(1);
    expect(res.exhausted[0].lastError).toBe("boom");
  });

  it("dedupes by id on enqueue", () => {
    const q = new RetryQueue<string>(async () => true);
    q.enqueue("same", "first");
    q.enqueue("same", "second");
    expect(q.size()).toBe(1);
    expect(q.pending()[0].payload).toBe("first");
  });

  it("backoffFor caps at maxDelayMs and respects factor", () => {
    const q = new RetryQueue<string>(async () => true, {
      baseDelayMs: 100,
      factor: 10,
      maxDelayMs: 5000,
      jitter: false,
    });
    expect(q.backoffFor(1)).toBe(100);
    expect(q.backoffFor(2)).toBe(1000);
    expect(q.backoffFor(3)).toBe(5000); // capped
    expect(q.backoffFor(10)).toBe(5000);
  });

  it("tick only processes due items", async () => {
    const clock = fakeClock(0);
    const proc = vi.fn().mockResolvedValue(false);
    const q = new RetryQueue<string>(proc, {
      now: clock.now,
      sleep: clock.sleep,
      baseDelayMs: 1000,
      factor: 1,
      jitter: false,
      maxAttempts: 5,
    });
    q.enqueue("a", "x");
    await q.tick(); // attempt 1, requeued at t=1000
    expect(proc).toHaveBeenCalledTimes(1);
    // not yet due
    await q.tick();
    expect(proc).toHaveBeenCalledTimes(1);
    clock.advance(1000);
    await q.tick();
    expect(proc).toHaveBeenCalledTimes(2);
  });
});
