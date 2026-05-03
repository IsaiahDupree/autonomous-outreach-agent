/**
 * tests/scorer-weights.test.ts — Pins the active scorer weights so any
 * recalibration run shows up as a deliberate, reviewable diff.
 *
 * If `data/scorer-weights.json` exists it overrides the defaults — that file
 * is itself the snapshot. Otherwise we pin the hand-tuned defaults here.
 */
import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";
import { DEFAULT_WEIGHTS, WEIGHTS } from "../src/Agent/scorer-weights";
import { preScoreJob } from "../src/Agent/scorer";

describe("scorer weights — defaults pinned", () => {
  it("default strong/weak bonuses match the documented baseline", () => {
    expect(DEFAULT_WEIGHTS).toEqual({
      STRONG_BONUS: 20,
      STRONG_CAP: 60,
      WEAK_BONUS: 8,
      WEAK_CAP: 24,
    });
  });

  it("active WEIGHTS expose the same shape as DEFAULT_WEIGHTS", () => {
    for (const key of ["STRONG_BONUS", "STRONG_CAP", "WEAK_BONUS", "WEAK_CAP"] as const) {
      expect(typeof WEIGHTS[key]).toBe("number");
      expect(WEIGHTS[key]).toBeGreaterThan(0);
    }
  });

  it("pre-score for a canonical strong-fit job is stable", () => {
    const r = preScoreJob({
      title: "n8n + Claude API automation specialist",
      description:
        "Build a workflow automation pipeline using n8n, Claude API, and webhooks. " +
        "Need API integration with hubspot CRM, lead generation, web scraping, " +
        "and a small dashboard in react / typescript on supabase.",
      budget: "$2,000 fixed",
      posted: "30 minutes ago",
      proposals: "5 to 10",
    });
    expect(r.excluded).toBe(false);
    expect(r.score).toBeGreaterThanOrEqual(80);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.strongHits.length).toBeGreaterThanOrEqual(3);
  });
});

describe("scorer weights — calibration file (if present)", () => {
  const calPath = path.resolve(process.cwd(), "data", "scorer-weights.json");
  if (!fs.existsSync(calPath)) {
    it.skip("no data/scorer-weights.json — skipping calibration snapshot", () => undefined);
    return;
  }
  const calibrated = JSON.parse(fs.readFileSync(calPath, "utf8"));

  it("calibration file is a valid weights object", () => {
    expect(calibrated).toMatchObject({
      STRONG_BONUS: expect.any(Number),
      STRONG_CAP: expect.any(Number),
      WEAK_BONUS: expect.any(Number),
      WEAK_CAP: expect.any(Number),
    });
  });

  it("per-keyword bonuses are non-negative integers within sane bounds", () => {
    const kb = calibrated.KEYWORD_BONUS || {};
    for (const [kw, bonus] of Object.entries(kb)) {
      expect(typeof bonus, `bonus for ${kw}`).toBe("number");
      expect(bonus as number).toBeGreaterThanOrEqual(0);
      expect(bonus as number).toBeLessThanOrEqual(60);
    }
  });

  it("matches stored snapshot — recalibrate intentionally to update", () => {
    expect(calibrated).toMatchSnapshot();
  });
});
