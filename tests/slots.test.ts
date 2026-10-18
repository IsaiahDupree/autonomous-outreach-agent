/**
 * tests/slots.test.ts — proposal slot parser + per-beat quality gate.
 */
import { describe, it, expect } from "vitest";
import { parseProposalSlots, SLOT_NAMES } from "../src/Agent/slots";
import { qualityCheckSlots } from "../src/Agent/index";

describe("parseProposalSlots", () => {
  it("extracts all six beats from a well-formed response", () => {
    const raw = `<problem>You're losing 4hrs/day on manual data entry.</problem>
<solution>I'll build an n8n workflow that ingests Stripe webhooks and pushes to your CRM.</solution>
<proof>Here's a similar pipeline I open-sourced: https://github.com/x/y</proof>
<portfolio>See my tailored page: https://example.com</portfolio>
<prior_results>I built this exact thing for a Shopify store and reduced their close time by 60%.</prior_results>
<cta>Want to hop on a 15-min call to walk through your current setup? Best, Isaiah</cta>`;

    const { text, slots } = parseProposalSlots(raw);
    expect(slots.problem).toContain("manual data entry");
    expect(slots.solution).toContain("n8n");
    expect(slots.proof).toContain("github.com");
    expect(slots.portfolio).toContain("example.com");
    expect(slots.prior_results).toContain("60%");
    expect(slots.cta).toContain("Best, Isaiah");
    expect(text).not.toContain("<problem>");
    expect(text).not.toContain("</cta>");
    expect(text).toContain("manual data entry");
  });

  it("falls back to using the whole output as the solution slot when no tags are present", () => {
    const raw = "Hi there, I'd love to help with your project. Best, Isaiah";
    const { text, slots } = parseProposalSlots(raw);
    expect(text).toBe("Hi there, I'd love to help with your project. Best, Isaiah");
    expect(slots.solution).toBe("Hi there, I'd love to help with your project. Best, Isaiah");
    expect(Object.keys(slots)).toHaveLength(1);
  });

  it("ignores empty tag pairs", () => {
    const raw = `<problem></problem><solution>Real content here.</solution>`;
    const { slots } = parseProposalSlots(raw);
    expect(slots.problem).toBeUndefined();
    expect(slots.solution).toBe("Real content here.");
  });

  it("strips tags case-insensitively but preserves content casing", () => {
    const raw = `<Problem>Big Problem.</Problem><Solution>Big Solution.</Solution>`;
    const { text, slots } = parseProposalSlots(raw);
    expect(text).toContain("Big Problem.");
    expect(slots.problem).toBe("Big Problem.");
    expect(slots.solution).toBe("Big Solution.");
  });

  it("collapses excessive blank lines left behind by stripped tags", () => {
    const raw = `<problem>A</problem>


<solution>B</solution>`;
    const { text } = parseProposalSlots(raw);
    expect(text).not.toMatch(/\n{3,}/);
  });

  it("exports the canonical slot order for the dashboard", () => {
    expect(SLOT_NAMES).toEqual(["problem", "solution", "proof", "portfolio", "prior_results", "cta"]);
  });
});

describe("qualityCheckSlots", () => {
  it("passes when every required beat hits its minimum length", () => {
    const slots = {
      problem: "Client needs a way to deduplicate 50k Stripe events per day.",
      solution: "I'll wire a Postgres-backed dedupe table fed by an Express webhook listener with idempotency keys, then forward to their CRM via n8n.",
      portfolio: "Tailored portfolio: https://example.com/r/abc",
      prior_results: "Built the same flow for a SaaS client — 99.99% dedupe rate over 6 months.",
      cta: "Hop on a quick call? Best, Isaiah",
    };
    const result = qualityCheckSlots(slots);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(100);
    expect(result.suggestions).toHaveLength(0);
  });

  it("flags missing beats by name", () => {
    const slots = { solution: "I will do the thing." };
    const result = qualityCheckSlots(slots);
    expect(result.passed).toBe(false);
    const failedNames = result.checks.filter(c => !c.passed).map(c => c.name);
    expect(failedNames).toContain("slot_problem");
    expect(failedNames).toContain("slot_portfolio");
    expect(failedNames).toContain("slot_prior_results");
    expect(failedNames).toContain("slot_cta");
    expect(result.suggestions.some(s => s.includes("<problem>"))).toBe(true);
  });

  it("flags too-short beats with the required minimum", () => {
    const slots = { problem: "short" };
    const result = qualityCheckSlots(slots);
    const problemCheck = result.checks.find(c => c.name === "slot_problem");
    expect(problemCheck?.passed).toBe(false);
    expect(problemCheck?.detail).toMatch(/Too short/);
  });

  it("reports slot coverage including the optional proof beat", () => {
    const slots = {
      problem: "Client needs a way to deduplicate 50k Stripe events per day.",
      solution: "I'll wire a Postgres-backed dedupe table fed by an Express webhook listener.",
      portfolio: "Tailored portfolio: https://example.com",
      prior_results: "Built the same flow for a SaaS client — 99.99% dedupe rate.",
      cta: "Quick call? Best, Isaiah",
    };
    const result = qualityCheckSlots(slots);
    const coverage = result.slotCoverage || [];
    const proof = coverage.find(c => c.name === "proof");
    expect(proof).toBeDefined();
    expect(proof!.present).toBe(false);
    expect(proof!.chars).toBe(0);
  });
});
