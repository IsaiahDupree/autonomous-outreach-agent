/**
 * src/Agent/scorer.ts — AI-powered job scoring using Claude
 * Scores Upwork jobs for relevance, feasibility, and fit.
 */
import Anthropic from "@anthropic-ai/sdk";
import logger from "../config/logger";
import { ANTHROPIC_API_KEY } from "../secret";
import { getCharacter } from "./index";

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

export interface ScoredJob {
  score: number;        // 0-10 overall fit
  bidRange: string;     // suggested bid range
  reasoning: string;    // 1-line reason
  tags: string[];       // matched skill tags
}

/**
 * Score a job for ICP fit + feasibility using Claude.
 * Returns score 0-10 with bid suggestion.
 */
export async function scoreJob(job: {
  title: string;
  description: string;
  budget?: string;
}): Promise<ScoredJob> {
  const character = getCharacter();
  const icp = character?.icp || {};
  const persona = character?.persona || "AI automation consultant";

  try {
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [{
        role: "user",
        content: `You are ${persona}. Score this Upwork job for fit.

Title: ${job.title}
Budget: ${job.budget || "not specified"}
Description: ${job.description.slice(0, 600)}

Your ICP: ${JSON.stringify(icp)}
Your skills: Claude API, Python, n8n, AI automation, marketing automation, web scraping, data pipelines

Reply in EXACTLY this JSON format (no markdown):
{"score":7,"bidRange":"$500-$800","reasoning":"Good fit - needs Python automation for lead gen","tags":["python","automation"]}

Score criteria:
- 8-10: Perfect fit, you can deliver exactly what they need
- 6-7: Good fit, relevant skills overlap
- 4-5: Partial fit, some skills match
- 0-3: Poor fit, outside your expertise`,
      }],
    });

    let text = (msg.content[0] as { text: string }).text.trim();
    // Strip markdown code blocks if present
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    // Extract just the JSON object (ignore any trailing text)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in response");
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      score: Math.min(10, Math.max(0, parsed.score || 0)),
      bidRange: parsed.bidRange || "TBD",
      reasoning: parsed.reasoning || "",
      tags: parsed.tags || [],
    };
  } catch (e) {
    logger.error(`[Scorer] scoreJob error: ${(e as Error).message}`);
    return { score: 5, bidRange: "TBD", reasoning: "Scoring failed", tags: [] };
  }
}
