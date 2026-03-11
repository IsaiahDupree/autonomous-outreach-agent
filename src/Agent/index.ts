/**
 * src/Agent/index.ts — AI Agent core (Claude, mirrors Riona's Gemini agent)
 * Generates cover letters, prospect messages, and scoring using Claude API
 */
import Anthropic from "@anthropic-ai/sdk";
import logger from "../config/logger";
import { ANTHROPIC_API_KEY } from "../secret";
import fs from "fs";
import path from "path";

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

export interface CharacterConfig {
  name: string;
  persona: string;
  tone: string;
  icp: Record<string, unknown>;
  portfolio?: {
    url: string;
    label?: string;
    templates?: Record<string, string>;
  };
  upwork?: Record<string, unknown>;
  approvalRequired: boolean;
}

let characterConfig: CharacterConfig | null = null;

export async function initAgent(characterFile = "sample.character.json"): Promise<void> {
  const charPath = path.join(__dirname, "characters", characterFile);
  if (fs.existsSync(charPath)) {
    characterConfig = JSON.parse(fs.readFileSync(charPath, "utf8"));
    logger.info(`[Agent] Loaded character: ${characterConfig?.name}`);
  } else {
    logger.warn(`[Agent] Character file not found: ${charPath} — using defaults`);
  }
}

export function getCharacter(): CharacterConfig | null {
  return characterConfig;
}

/**
 * Get a portfolio line to prepend to a cover letter.
 * Picks the best template based on job tags, or uses default.
 */
export function getPortfolioLine(tags?: string[]): string {
  const portfolio = characterConfig?.portfolio;
  if (!portfolio?.url) return "";
  const templates = portfolio.templates || {};
  const url = portfolio.url;

  // Try to match a template based on job tags
  if (tags?.length) {
    const tagStr = tags.join(" ").toLowerCase();
    for (const [key, tmpl] of Object.entries(templates)) {
      if (key === "default") continue;
      // Match template key against tags (e.g. "ai-automation" matches "ai automation")
      const keyWords = key.replace(/-/g, " ");
      if (tagStr.includes(keyWords) || keyWords.split(" ").some(w => tagStr.includes(w))) {
        return tmpl.replace("{url}", url);
      }
    }
  }

  // Fall back to default template
  return (templates.default || `${portfolio.label || "See my relevant work"}: ${url}`).replace("{url}", url);
}

/**
 * Generate an Upwork cover letter for a job posting
 */
export async function generateCoverLetter(job: {
  title: string;
  description: string;
  budget?: string;
}): Promise<string> {
  const persona = characterConfig?.persona || "a professional AI automation consultant";
  const prompt = `You are ${persona}.

Write a SHORT (150-200 word) Upwork cover letter for this job:
Title: ${job.title}
Budget: ${job.budget || "not specified"}
Description: ${job.description.slice(0, 500)}

Rules:
- Start with a specific hook referencing their exact need
- Mention 1 concrete similar project you've built
- State a clear outcome/deliverable
- End with a soft CTA (not pushy)
- NO generic phrases like "I am writing to apply"
- Return ONLY the cover letter text, no preamble`;

  const msg = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 400,
    messages: [{ role: "user", content: prompt }],
  });

  return (msg.content[0] as { text: string }).text;
}

/**
 * Score a prospect's ICP fit using Claude (0-10)
 */
export async function scoreProspectWithAI(profile: {
  bio?: string;
  displayName?: string;
  headline?: string;
  followers?: number;
}): Promise<number> {
  const text = `${profile.displayName || ""} | ${profile.headline || ""} | ${profile.bio || ""}`;

  const msg = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 50,
    messages: [{
      role: "user",
      content: `Score this LinkedIn profile for ICP fit (software founders $500K-$5M ARR needing AI automation). Reply with ONLY a number 0-10.

Profile: "${text.slice(0, 300)}"`,
    }],
  });

  const score = parseInt((msg.content[0] as { text: string }).text.trim());
  return isNaN(score) ? 0 : Math.min(10, Math.max(0, score));
}

/**
 * Generate a personalized DM opening for a prospect
 */
export async function generateDMOpening(profile: {
  displayName: string;
  bio?: string;
  platform: string;
}): Promise<string> {
  const msg = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 150,
    messages: [{
      role: "user",
      content: `Write a 1-sentence personalized DM opening for ${profile.displayName} on ${profile.platform}.
Their bio: "${(profile.bio || "").slice(0, 200)}"
Context: You're an AI automation consultant. The opening should reference something specific from their bio.
Reply with ONLY the opening sentence.`,
    }],
  });

  return (msg.content[0] as { text: string }).text.trim();
}
