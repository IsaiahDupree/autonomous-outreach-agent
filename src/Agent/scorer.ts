/**
 * src/Agent/scorer.ts — Two-stage job scoring: deterministic pre-filter + AI scoring
 * Stage 1: Hard excludes, budget floors, ICP keyword matching, point-based 0-100
 * Stage 2: Claude AI scoring for fit assessment (only for jobs that pass Stage 1)
 */
import Anthropic from "@anthropic-ai/sdk";
import logger from "../config/logger";
import { ANTHROPIC_API_KEY } from "../secret";
import { getCharacter } from "./index";

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── Hard exclude keywords — instant drop if title or description matches ──
const HARD_EXCLUDES = [
  "wordpress", "shopify", "data entry", "logo design", "graphic design",
  "video editing", "esri", "figma", "webflow", "java developer",
  "mobile app developer", ".net developer", "php developer",
  "senior devops", "devops engineer", "web developer",
  "senior backend", "senior frontend", "senior fullstack",
  "ios developer", "android developer", "react developer", "angular developer",
  "unity developer", "game developer", "blockchain developer",
  "salesforce", "oracle", "tableau", "power bi",
];

// Short keywords that need word-boundary matching (avoid false positives like "strategist" → "gis")
const HARD_EXCLUDES_REGEX = [
  /\bgis\b/i,
  /\bsap\b/i,
];

// ── ICP strong keywords — must match at least 1 or score → 0 ──
const ICP_STRONG_KEYWORDS = [
  "ai automation", "workflow automation", "browser automation",
  "claude", "openai", "anthropic", "n8n", "zapier", "make.com",
  "api integration", "crm integration", "marketing automation",
  "llm", "gpt", "chatbot", "ai agent", "ai workflow",
  "python automation", "web scraping", "data pipeline",
];

// ── ICP weak keywords — supporting signals ──
const ICP_WEAK_KEYWORDS = [
  "automat", "script", "bot", "scrape", "crawl", "pipeline",
  "integration", "webhook", "api", "etl", "data",
  "lead gen", "outreach", "email", "sms", "notification",
  "schedule", "cron", "trigger", "monitor", "alert",
  "saas", "startup", "mvp", "prototype", "tool",
];

// ── Budget floors ──
const BUDGET_FLOOR_HOURLY = 29;   // below $29/hr → drop
const BUDGET_FLOOR_FIXED = 500;   // below $500 fixed → drop

export interface ScoredJob {
  score: number;        // 0-10 overall fit (final combined)
  preScore: number;     // 0-100 deterministic pre-score
  bidRange: string;     // suggested bid range
  reasoning: string;    // 1-line reason
  tags: string[];       // matched skill tags
  excluded?: string;    // if excluded, the reason
}

export interface PreScoreResult {
  score: number;        // 0-100
  excluded: boolean;
  excludeReason?: string;
  strongHits: string[];
  weakHits: string[];
  budgetBonus: number;
  recencyBonus: number;
}

/**
 * Stage 1: Deterministic pre-scoring (0-100 points, no API calls).
 * Returns score=0 with excluded=true if the job should be instantly dropped.
 */
export function preScoreJob(job: {
  title: string;
  description: string;
  budget?: string;
  posted?: string;
}): PreScoreResult {
  const text = `${job.title} ${job.description}`.toLowerCase();

  // ── Hard excludes ──
  for (const kw of HARD_EXCLUDES) {
    if (text.includes(kw)) {
      return {
        score: 0, excluded: true,
        excludeReason: `Hard exclude: "${kw}"`,
        strongHits: [], weakHits: [],
        budgetBonus: 0, recencyBonus: 0,
      };
    }
  }
  for (const re of HARD_EXCLUDES_REGEX) {
    if (re.test(text)) {
      return {
        score: 0, excluded: true,
        excludeReason: `Hard exclude: ${re.source}`,
        strongHits: [], weakHits: [],
        budgetBonus: 0, recencyBonus: 0,
      };
    }
  }

  // ── Budget hard floor ──
  if (job.budget) {
    const budgetText = job.budget.toLowerCase();
    // Parse hourly rate
    const hourlyMatch = budgetText.match(/\$([\d,.]+)\s*(?:\/hr|per hour|hourly)/i);
    if (hourlyMatch) {
      const rate = parseFloat(hourlyMatch[1].replace(/,/g, ""));
      if (rate < BUDGET_FLOOR_HOURLY) {
        return {
          score: 0, excluded: true,
          excludeReason: `Budget floor: $${rate}/hr < $${BUDGET_FLOOR_HOURLY}/hr`,
          strongHits: [], weakHits: [],
          budgetBonus: 0, recencyBonus: 0,
        };
      }
    }
    // Parse fixed price
    const fixedMatch = budgetText.match(/\$([\d,.]+)/);
    if (fixedMatch && !hourlyMatch) {
      const amount = parseFloat(fixedMatch[1].replace(/,/g, ""));
      if (amount > 0 && amount < BUDGET_FLOOR_FIXED) {
        return {
          score: 0, excluded: true,
          excludeReason: `Budget floor: $${amount} < $${BUDGET_FLOOR_FIXED}`,
          strongHits: [], weakHits: [],
          budgetBonus: 0, recencyBonus: 0,
        };
      }
    }
  }

  // ── ICP strong keyword matching (required — must have at least 1) ──
  const strongHits: string[] = [];
  for (const kw of ICP_STRONG_KEYWORDS) {
    if (text.includes(kw)) strongHits.push(kw);
  }

  if (strongHits.length === 0) {
    return {
      score: 0, excluded: true,
      excludeReason: "No ICP strong keyword match",
      strongHits: [], weakHits: [],
      budgetBonus: 0, recencyBonus: 0,
    };
  }

  // ── Point-based scoring ──
  let score = 0;

  // Strong keyword hits: +20 each, capped at 60
  score += Math.min(60, strongHits.length * 20);

  // Weak keyword hits: +8 each, capped at 24
  const weakHits: string[] = [];
  for (const kw of ICP_WEAK_KEYWORDS) {
    if (text.includes(kw)) weakHits.push(kw);
  }
  score += Math.min(24, weakHits.length * 8);

  // ── Budget bonus ──
  let budgetBonus = 0;
  if (job.budget) {
    const amtMatch = job.budget.match(/\$([\d,.]+)/);
    if (amtMatch) {
      const amount = parseFloat(amtMatch[1].replace(/,/g, ""));
      if (amount >= 1000) budgetBonus = 20;
      else if (amount >= 500) budgetBonus = 10;
    }
    // Contract type bonus
    if (job.budget.toLowerCase().includes("hourly") || job.budget.toLowerCase().includes("/hr")) {
      budgetBonus += 8;
    } else {
      budgetBonus += 4; // fixed
    }
  }
  score += budgetBonus;

  // ── Recency bonus ──
  let recencyBonus = 0;
  if (job.posted) {
    const posted = job.posted.toLowerCase();
    const hoursMatch = posted.match(/(\d+)\s*hour/);
    const minutesMatch = posted.match(/(\d+)\s*min/);
    if (minutesMatch || posted.includes("just now") || posted.includes("moment")) {
      recencyBonus = 15; // very fresh
    } else if (hoursMatch) {
      const hours = parseInt(hoursMatch[1]);
      if (hours <= 4) recencyBonus = 15;
      else if (hours <= 24) recencyBonus = 8;
    } else if (posted.includes("yesterday")) {
      recencyBonus = 5;
    }
  }
  score += recencyBonus;

  return {
    score: Math.min(100, score),
    excluded: false,
    strongHits, weakHits,
    budgetBonus, recencyBonus,
  };
}

/**
 * Stage 2: AI-powered scoring using Claude (only called for jobs that pass Stage 1).
 * Returns score 0-10 with bid suggestion.
 */
export async function scoreJob(job: {
  title: string;
  description: string;
  budget?: string;
  posted?: string;
}): Promise<ScoredJob> {
  // Stage 1: deterministic pre-filter
  const pre = preScoreJob(job);

  if (pre.excluded) {
    logger.info(`[Scorer] Pre-filter excluded: ${pre.excludeReason}`);
    return {
      score: 0, preScore: 0,
      bidRange: "N/A",
      reasoning: pre.excludeReason || "Excluded by pre-filter",
      tags: [],
      excluded: pre.excludeReason,
    };
  }

  logger.info(`[Scorer] Pre-score: ${pre.score}/100 (strong: ${pre.strongHits.length}, weak: ${pre.weakHits.length}, budget: +${pre.budgetBonus}, recency: +${pre.recencyBonus})`);

  // Stage 2: AI scoring
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
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in response");
    const parsed = JSON.parse(jsonMatch[0]);

    const aiScore = Math.min(10, Math.max(0, parsed.score || 0));

    return {
      score: aiScore,
      preScore: pre.score,
      bidRange: parsed.bidRange || "TBD",
      reasoning: parsed.reasoning || "",
      tags: [...(parsed.tags || []), ...pre.strongHits.slice(0, 3)],
    };
  } catch (e) {
    logger.error(`[Scorer] AI scoreJob error: ${(e as Error).message}`);
    // Fall back to pre-score converted to 0-10 scale
    const fallbackScore = Math.round(pre.score / 10);
    return {
      score: Math.min(10, fallbackScore),
      preScore: pre.score,
      bidRange: "TBD",
      reasoning: `AI scoring failed — using pre-score (${pre.score}/100)`,
      tags: pre.strongHits.slice(0, 5),
    };
  }
}
