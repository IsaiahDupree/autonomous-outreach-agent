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
  ".net developer", "php developer",
  "senior devops", "devops engineer",
  "angular developer",
  "unity developer", "game developer", "blockchain developer",
  "salesforce", "oracle", "tableau", "power bi",
];

// Short keywords that need word-boundary matching (avoid false positives like "strategist" → "gis")
const HARD_EXCLUDES_REGEX = [
  /\bgis\b/i,
  /\bsap\b/i,
];

// ── Competitive blacklist — removed most items, these are actually our market ──
// Only blacklist truly oversaturated commodity work
const COMPETITIVE_BLACKLIST: string[] = [
  // Intentionally empty — n8n, zapier, make.com are core skills, not competition
];

// ── ICP strong keywords — must match at least 1 or score → 0 ──
const ICP_STRONG_KEYWORDS = [
  // AI / LLM
  "ai automation", "workflow automation", "browser automation",
  "claude", "openai", "anthropic", "gemini",
  "llm", "gpt", "chatbot", "ai agent", "ai workflow",
  "machine learning", "nlp", "natural language",
  // Automation tools
  "n8n", "zapier", "make.com", "make automation",
  "api integration", "crm integration", "marketing automation",
  "email automation", "lead generation", "lead gen",
  "hubspot", "gohighlevel", "highlevel", "salesforce integration",
  // Development
  "python automation", "python script", "python developer",
  "web scraping", "data scraping", "data extraction", "web crawler",
  "data pipeline", "etl", "data integration",
  "mobile app", "react native", "flutter", "full stack",
  "ios app", "android app", "cross platform",
  "saas", "mvp", "prototype", "web app",
  // Ops / infra
  "automation engineer", "automation specialist", "automation expert",
  "bot development", "process automation", "rpa",
  "webhook", "api development", "backend developer",
  // Voice AI / Audio
  "elevenlabs", "11labs", "voice ai", "text to speech", "voice cloning",
  "voice agent", "voice assistant", "speech synthesis",
  // Web apps
  "web application", "dashboard", "admin panel", "portal",
];

// ── ICP weak keywords — supporting signals ──
const ICP_WEAK_KEYWORDS = [
  "automat", "script", "bot", "scrape", "crawl", "pipeline",
  "integration", "webhook", "api", "etl", "data",
  "lead gen", "outreach", "email", "sms", "notification",
  "schedule", "cron", "trigger", "monitor", "alert",
  "saas", "startup", "mvp", "prototype", "tool",
  "dashboard", "analytics", "report", "workflow",
  "backend", "frontend", "fullstack", "microservice",
  "database", "postgres", "mongodb", "supabase", "firebase",
  "node.js", "typescript", "react", "next.js", "express",
  "django", "fastapi", "flask",
  "docker", "aws", "cloud", "deploy",
  "stripe", "payment", "billing",
];

// Short keywords that need word-boundary matching to avoid false positives
// (e.g., "llm" shouldn't match "william", "bot" shouldn't match "robot")
const SHORT_KEYWORD_REGEX_CACHE = new Map<string, RegExp>();
function matchesKeyword(text: string, kw: string): boolean {
  // Multi-word phrases or long keywords: .includes() is fine
  if (kw.length >= 5 || kw.includes(" ") || kw.includes(".")) {
    return text.includes(kw);
  }
  // Short keywords: use word-boundary regex
  let re = SHORT_KEYWORD_REGEX_CACHE.get(kw);
  if (!re) {
    re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    SHORT_KEYWORD_REGEX_CACHE.set(kw, re);
  }
  return re.test(text);
}

// ── Budget floors ── (URL filters already enforce minimums, these catch edge cases)
const BUDGET_FLOOR_HOURLY = 20;   // below $20/hr → drop
const BUDGET_FLOOR_FIXED = 200;   // below $200 fixed → drop

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
// Minimum client hire rate — skip clients who rarely hire (tire-kickers)
const MIN_CLIENT_HIRE_RATE = 15; // percent

export function preScoreJob(job: {
  title: string;
  description: string;
  budget?: string;
  posted?: string;
  proposals?: string;
  clientHireRate?: number;
  clientHires?: number;
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

  // ── Competitive blacklist — too saturated, skip ──
  for (const kw of COMPETITIVE_BLACKLIST) {
    if (text.includes(kw)) {
      return {
        score: 0, excluded: true,
        excludeReason: `Competitive blacklist: "${kw}" (too much competition)`,
        strongHits: [], weakHits: [],
        budgetBonus: 0, recencyBonus: 0,
      };
    }
  }

  // ── Proposal count ceiling — skip jobs with 20+ proposals ──
  if (job.proposals) {
    const proposalText = job.proposals.toLowerCase();
    // Parse "15 to 20 proposals", "20 to 50", "50+", "20+ proposals"
    const rangeMatch = proposalText.match(/(\d+)\s*to\s*(\d+)/);
    const plusMatch = proposalText.match(/(\d+)\+/);
    const singleMatch = proposalText.match(/(\d+)\s*proposal/);
    let proposalCount = 0;
    if (rangeMatch) {
      proposalCount = parseInt(rangeMatch[1]); // use lower bound
    } else if (plusMatch) {
      proposalCount = parseInt(plusMatch[1]);
    } else if (singleMatch) {
      proposalCount = parseInt(singleMatch[1]);
    }
    if (proposalCount >= 50) {
      return {
        score: 0, excluded: true,
        excludeReason: `Too many proposals: ${job.proposals} (max 50)`,
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

  // ── Client hire rate filter (Freelancer Plus data) ──
  // Skip clients with very low hire rates (tire-kickers who post but never hire)
  // Only filter if we have hire rate data AND the client has enough history to judge
  if (job.clientHireRate !== undefined && job.clientHireRate < MIN_CLIENT_HIRE_RATE) {
    const isNewClient = job.clientHires !== undefined && job.clientHires < 3;
    if (!isNewClient) {
      // Exclude established clients (3+ hires) with poor hire rates
      return {
        score: 0, excluded: true,
        excludeReason: `Low client hire rate: ${job.clientHireRate}% (min ${MIN_CLIENT_HIRE_RATE}%, ${job.clientHires ?? "?"} hires)`,
        strongHits: [], weakHits: [],
        budgetBonus: 0, recencyBonus: 0,
      };
    }
  }

  // ── ICP strong keyword matching (required — must have at least 1) ──
  const strongHits: string[] = [];
  for (const kw of ICP_STRONG_KEYWORDS) {
    if (matchesKeyword(text, kw)) strongHits.push(kw);
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
    if (matchesKeyword(text, kw)) weakHits.push(kw);
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
  proposals?: string;
  clientHireRate?: number;
  clientHires?: number;
  competitiveBidRange?: { low?: number; avg?: number; high?: number };
  interviewing?: number;
  invitesSent?: number;
  paymentVerified?: boolean;
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
${job.clientHireRate !== undefined ? `Client hire rate: ${job.clientHireRate}% (${job.clientHires ?? "?"} hires)` : ""}
${job.competitiveBidRange?.avg ? `Competitive bids: Low $${job.competitiveBidRange.low || "?"} / Avg $${job.competitiveBidRange.avg} / High $${job.competitiveBidRange.high || "?"}` : ""}
${job.interviewing ? `Currently interviewing: ${job.interviewing} candidates` : ""}
${job.invitesSent ? `Invites sent: ${job.invitesSent}` : ""}
${job.paymentVerified !== undefined ? `Payment verified: ${job.paymentVerified ? "Yes" : "No"}` : ""}

Your ICP: ${JSON.stringify(icp)}
Your skills: Claude API, Python, n8n, AI automation, marketing automation, web scraping, data pipelines, React Native, full stack

Reply in EXACTLY this JSON format (no markdown):
{"score":7,"bidRange":"$500-$800","reasoning":"Good fit - needs Python automation for lead gen","tags":["python","automation"]}

IMPORTANT: Use the full 1-10 range. Do NOT cluster everything at 5-6.
- 9-10: Dream job. Core skill match (AI automation, scraping, n8n, Claude API), good budget ($1K+), ideal client, low competition
- 7-8: Strong fit. Most skills align, reasonable budget, clear deliverable you can nail
- 5-6: Decent fit. Some skill overlap but not your sweet spot, or budget is low
- 3-4: Weak fit. Tangential skills, wrong domain, or poor budget
- 1-2: No fit. Completely outside expertise

Factor in competitive data: fewer candidates interviewing = better chance. High hire rate client = more likely to hire. If avg bid exists, suggest a bid near/below avg to be competitive.

Example: An "n8n + Claude API automation" job at $2K with a verified client = 9/10
Example: A "Python web scraper for lead gen" at $800 = 8/10
Example: A "React Native bug fix" at $250 = 2/10`,
      }],
    });

    const block = msg.content?.[0];
    if (!block || !("text" in block)) throw new Error("Empty Claude response");
    let text = block.text.trim();
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
