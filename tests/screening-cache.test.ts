import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/config/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  getCachedScreeningAnswer,
  setCachedScreeningAnswer,
  _resetScreeningCacheForTests,
} from "../src/services/screening-cache";

beforeEach(() => {
  _resetScreeningCacheForTests();
});

describe("screening cache", () => {
  it("returns null on miss", () => {
    expect(getCachedScreeningAnswer("persona-a", "How much Python?")).toBeNull();
  });

  it("returns cached answer on hit, isolated per persona", () => {
    setCachedScreeningAnswer("persona-a", "How much Python?", "10 years.");
    expect(getCachedScreeningAnswer("persona-a", "How much Python?")).toBe("10 years.");
    expect(getCachedScreeningAnswer("persona-b", "How much Python?")).toBeNull();
  });

  it("normalizes whitespace + punctuation when keying", () => {
    setCachedScreeningAnswer("p", "Are you available 20+ hrs/week?", "Yes.");
    expect(getCachedScreeningAnswer("p", "are you  available  20+ hrs / week")).toBe("Yes.");
  });
});
