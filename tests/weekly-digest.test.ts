/**
 * tests/weekly-digest.test.ts — message format + counting for weekly Telegram digest.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/secret", () => ({
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_KEY: "test-key",
  ANTHROPIC_API_KEY: "test-key",
  TELEGRAM_BOT_TOKEN: "test-bot",
  TELEGRAM_CHAT_ID: "1",
  CRMLITE_URL: "",
  CRMLITE_API_KEY: "",
}));

vi.mock("../src/config/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { computeDigestStats, formatDigestMessage, DigestRow } from "../src/services/weekly-digest";

const FIXTURE: DigestRow[] = [
  // 2 hires, 1 reply, 1 rejected, 2 sent unanswered, 1 still queued
  { status: "won",          score: 88, pre_score: 60, submitted_at: "2026-04-26T10:00:00Z", submitted_connects_cost: 16, created_at: "2026-04-26T09:00:00Z" },
  { status: "won",          score: 91, pre_score: 65, submitted_at: "2026-04-27T10:00:00Z", submitted_connects_cost: 14, created_at: "2026-04-27T09:00:00Z" },
  { status: "interviewed",  score: 82, pre_score: 58, submitted_at: "2026-04-28T10:00:00Z", submitted_connects_cost: 12, created_at: "2026-04-28T09:00:00Z" },
  { status: "rejected",     score: 70, pre_score: 50, submitted_at: "2026-04-29T10:00:00Z", submitted_connects_cost: 10, created_at: "2026-04-29T09:00:00Z" },
  { status: "sent",         score: 75, pre_score: 55, submitted_at: "2026-04-30T10:00:00Z", submitted_connects_cost: 12, created_at: "2026-04-30T09:00:00Z" },
  { status: "sent",         score: 72, pre_score: 52, submitted_at: "2026-05-01T10:00:00Z", submitted_connects_cost: 12, created_at: "2026-05-01T09:00:00Z" },
  { status: "queued",       score: 65, pre_score: 48, submitted_at: null,                    submitted_connects_cost: null, created_at: "2026-05-01T11:00:00Z" },
  // an excluded job that never got an AI score
  { status: "excluded",     score: 0,  pre_score: 30, submitted_at: null,                    submitted_connects_cost: null, created_at: "2026-04-26T08:00:00Z" },
];

describe("computeDigestStats", () => {
  const weekStart = new Date("2026-04-26T00:00:00Z");
  const weekEnd = new Date("2026-05-02T00:00:00Z");

  it("counts each pipeline stage from row data", () => {
    const s = computeDigestStats(FIXTURE, weekStart, weekEnd);
    expect(s.scanned).toBe(8);
    expect(s.scored).toBe(7);          // all but the excluded score=0 row
    expect(s.submitted).toBe(6);       // queued + excluded never went out
    expect(s.replies).toBe(1);         // interviewed
    expect(s.hires).toBe(2);           // won
    expect(s.connectsSpent).toBe(76);  // 16+14+12+10+12+12
    expect(s.weekStart).toBe("2026-04-26");
    expect(s.weekEnd).toBe("2026-05-02");
  });

  it("returns zeros for an empty week", () => {
    const s = computeDigestStats([], weekStart, weekEnd);
    expect(s).toEqual({
      scanned: 0, scored: 0, submitted: 0, replies: 0, hires: 0,
      connectsSpent: 0, weekStart: "2026-04-26", weekEnd: "2026-05-02",
    });
  });
});

describe("formatDigestMessage", () => {
  it("renders the expected Telegram digest format", () => {
    const stats = computeDigestStats(FIXTURE, new Date("2026-04-26T00:00:00Z"), new Date("2026-05-02T00:00:00Z"));
    const msg = formatDigestMessage(stats);
    expect(msg).toContain("📊 *Weekly Upwork digest* (2026-04-26 → 2026-05-02)");
    expect(msg).toContain("• Scanned: 8");
    expect(msg).toContain("• Scored (AI): 7");
    expect(msg).toContain("• Submitted: 6");
    expect(msg).toContain("• Replies: 1 (17%)");
    expect(msg).toContain("• Hires: 2 (33%)");
    expect(msg).toContain("• Connects spent: 76");
  });

  it("avoids divide-by-zero when nothing was submitted", () => {
    const empty = computeDigestStats([], new Date("2026-04-26T00:00:00Z"), new Date("2026-05-02T00:00:00Z"));
    const msg = formatDigestMessage(empty);
    expect(msg).toContain("• Replies: 0 (0%)");
    expect(msg).toContain("• Hires: 0 (0%)");
  });
});
