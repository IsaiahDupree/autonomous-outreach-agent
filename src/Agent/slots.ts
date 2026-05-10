/**
 * src/Agent/slots.ts — proposal "beats" structure.
 *
 * Cover letters are generated with XML section tags so we can:
 *   1. enforce a 6-beat structure (problem → solution → proof → portfolio → prior_results → cta)
 *   2. show the dashboard which beats each proposal hit
 *   3. quality-gate per beat instead of one monolithic check
 *
 * Tags are stripped from the user-facing output — Upwork sees plain text.
 */

export const SLOT_NAMES = ["problem", "solution", "proof", "portfolio", "prior_results", "cta"] as const;
export type SlotName = typeof SLOT_NAMES[number];
export type ProposalSlots = Partial<Record<SlotName, string>>;

const TAG_RE = /<\/?(problem|solution|proof|portfolio|prior_results|cta)>/gi;

/**
 * Extract XML-tagged sections and return clean rendered text + structured slots.
 * If no tags are found, the whole output is treated as the `solution` slot —
 * the prompt may have ignored the structure but we still produce something.
 */
export function parseProposalSlots(raw: string): { text: string; slots: ProposalSlots } {
  const slots: ProposalSlots = {};
  for (const name of SLOT_NAMES) {
    const re = new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, "i");
    const m = raw.match(re);
    if (m && m[1].trim()) slots[name] = m[1].trim();
  }

  // Strip the tags themselves but keep their content. Collapse blank gaps left behind.
  const text = raw
    .replace(TAG_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (Object.keys(slots).length === 0 && text) {
    slots.solution = text;
  }
  return { text, slots };
}

/**
 * Prompt fragment the model is told to emit. Kept as one block so we can change
 * wording in one place. The fragment is appended after the rules block.
 */
export const SLOT_PROMPT_INSTRUCTIONS = `STRUCTURE — wrap each beat of the proposal in XML tags. Tags are stripped from what the client sees; they're how the system tracks which beats your proposal hits. Use ALL beats that apply (omit a tag entirely if you genuinely have nothing for it):

<problem>1-2 sentences proving you understood their actual problem. Reference specifics from their post — names, numbers, the workflow they described.</problem>

<solution>3-5 lines or bullets describing your concrete approach. Name exact tools, libraries, services, models. No vague phrases like "modern stack".</solution>

<proof>Drop in your strongest proof: a GitHub repo URL, YouTube link, or proof-of-work artifact URL with one sentence on what it shows. Omit if you have none.</proof>

<portfolio>Tailored portfolio link sentence. If showcase projects were provided, mention 1-2 by name here.</portfolio>

<prior_results>One specific past project with a measurable result — numbers, timelines, or before/after. If you don't have an exact match, use the closest analogue and say "similar to your X, I built Y for Z".</prior_results>

<cta>Closing line + soft CTA + signoff. Keep it 1-3 lines.</cta>

The tags must appear exactly as shown — lowercase, no attributes. Content inside the tags is the actual proposal copy and follows all the rules above (warm tone, plain text, named tech, etc.).`;
