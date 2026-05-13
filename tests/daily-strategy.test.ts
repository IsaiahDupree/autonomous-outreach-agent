/**
 * tests/daily-strategy.test.ts — Daily strategy service tests
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing
vi.mock("../src/services/cloud", () => ({
  getProposalsByFilter: vi.fn().mockResolvedValue([]),
}));
vi.mock("../src/services/telegram", () => ({
  notify: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/config/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { shouldFastApply, getDailyPlan } from "../src/services/daily-strategy";

describe("Fast-Apply Logic", () => {
  it("should fast-apply for score >= 7", () => {
    expect(shouldFastApply(7)).toBe(true);
    expect(shouldFastApply(8)).toBe(true);
    expect(shouldFastApply(9)).toBe(true);
  });

  it("should not fast-apply for score < 7", () => {
    expect(shouldFastApply(6)).toBe(false);
    expect(shouldFastApply(5)).toBe(false);
    expect(shouldFastApply(3)).toBe(false);
  });

  it("should not fast-apply to unverified clients", () => {
    expect(shouldFastApply(8, { paymentVerified: false })).toBe(false);
  });

  it("should not fast-apply to highly competitive jobs", () => {
    expect(shouldFastApply(8, { proposals: 60 })).toBe(false);
  });

  it("should fast-apply to great clients at score 7", () => {
    expect(shouldFastApply(7, { clientHireRate: 70, paymentVerified: true })).toBe(true);
  });

  it("should not fast-apply great clients at score 6", () => {
    expect(shouldFastApply(6, { clientHireRate: 80, paymentVerified: true })).toBe(false);
  });
});

describe("Daily Plan State", () => {
  it("should return null when no plan exists", () => {
    expect(getDailyPlan()).toBeNull();
  });
});
