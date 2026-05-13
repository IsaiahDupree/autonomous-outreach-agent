/**
 * tests/posted-at.test.ts — covers the relative-time parser used to populate posted_at on
 * upwork_proposals. The parser is deterministic and pure; tests use a fixed `now` so the
 * deltas line up regardless of clock skew.
 */
import { describe, it, expect } from "vitest";
import { parseRelativePosted } from "../src/services/posted-at";

const NOW = new Date("2026-04-26T12:00:00.000Z");

describe("parseRelativePosted", () => {
  it("parses 'X minutes ago'", () => {
    const out = parseRelativePosted("Posted 7 minutes ago", NOW);
    expect(out?.toISOString()).toBe("2026-04-26T11:53:00.000Z");
  });

  it("parses 'X hours ago'", () => {
    const out = parseRelativePosted("3 hours ago", NOW);
    expect(out?.toISOString()).toBe("2026-04-26T09:00:00.000Z");
  });

  it("parses 'X days ago'", () => {
    const out = parseRelativePosted("Posted 2 days ago", NOW);
    expect(out?.toISOString()).toBe("2026-04-24T12:00:00.000Z");
  });

  it("parses singular forms (an hour, a day)", () => {
    expect(parseRelativePosted("an hour ago", NOW)?.toISOString()).toBe("2026-04-26T11:00:00.000Z");
    expect(parseRelativePosted("a day ago", NOW)?.toISOString()).toBe("2026-04-25T12:00:00.000Z");
  });

  it("parses 'yesterday' / 'last week' / 'last month'", () => {
    expect(parseRelativePosted("yesterday", NOW)?.toISOString()).toBe("2026-04-25T12:00:00.000Z");
    expect(parseRelativePosted("Posted last week", NOW)?.toISOString()).toBe("2026-04-19T12:00:00.000Z");
    expect(parseRelativePosted("last month", NOW)?.toISOString()).toBe("2026-03-27T12:00:00.000Z");
  });

  it("returns now for 'just now' / 'moments ago'", () => {
    expect(parseRelativePosted("just now", NOW)?.toISOString()).toBe(NOW.toISOString());
    expect(parseRelativePosted("a few moments ago", NOW)?.toISOString()).toBe(NOW.toISOString());
  });

  it("handles abbreviated units (min, hr)", () => {
    expect(parseRelativePosted("5 min ago", NOW)?.toISOString()).toBe("2026-04-26T11:55:00.000Z");
    expect(parseRelativePosted("2 hr ago", NOW)?.toISOString()).toBe("2026-04-26T10:00:00.000Z");
  });

  it("returns null for unparseable input", () => {
    expect(parseRelativePosted("", NOW)).toBeNull();
    expect(parseRelativePosted(undefined, NOW)).toBeNull();
    expect(parseRelativePosted("some random text", NOW)).toBeNull();
  });
});
