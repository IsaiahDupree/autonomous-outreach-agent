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
  name_signoff?: string;
  icp: Record<string, unknown>;
  portfolio?: {
    url: string;
    label?: string;
    templates?: Record<string, string>;
  };
  github?: {
    username: string;
    repos: Record<string, {
      url: string;
      description: string;
      keywords: string[];
    }>;
  };
  winningExamples?: Array<{
    style: string;
    description: string;
    job: string;
  }>;
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
 * Find a matching GitHub repo based on job title/description keywords
 */
export function getMatchingGithubRepo(job: { title: string; description: string }): string {
  const repos = characterConfig?.github?.repos;
  if (!repos) return "";
  const jobText = `${job.title} ${job.description}`.toLowerCase();
  for (const [, repo] of Object.entries(repos)) {
    const matchCount = repo.keywords.filter(kw => jobText.includes(kw.toLowerCase())).length;
    if (matchCount >= 2) {
      return `\n\nHere's my GitHub repo with a working implementation: ${repo.url}\n${repo.description}`;
    }
  }
  return "";
}

/**
 * Generate an Upwork cover letter for a job posting
 * Style modeled after Isaiah's winning proposals: warm, proof-driven, structured.
 */
export async function generateCoverLetter(job: {
  title: string;
  description: string;
  budget?: string;
}): Promise<string> {
  const persona = characterConfig?.persona || "a professional AI automation consultant";
  const signoff = characterConfig?.name_signoff || "";
  const githubProof = getMatchingGithubRepo(job);

  const prompt = `You are ${persona}.

Write an Upwork cover letter (150-250 words) for this job:
Title: ${job.title}
Budget: ${job.budget || "not specified"}
Description: ${job.description.slice(0, 600)}
${githubProof ? `\nYou have this relevant GitHub repo to reference:${githubProof}` : ""}

STYLE — model these winning proposals that got hired:

EXAMPLE 1 (proof-first, led with existing repo):
"I'd be thrilled to help—I've already built and open-sourced a working solution that covers nearly all your outlined objectives.
🔗 Here's my GitHub repo: [url]
✅ Why I'm a strong fit:
I've already built a containerized FastAPI + MongoDB Atlas Search system that includes:
Vector search using paraphrase-multilingual-MiniLM-L12-v2..."

EXAMPLE 2 (technical-depth, named exact hardware/libs):
"Hi there, I'd love to help with this project. I'm an aerospace engineer with experience in computational fluid dynamics and GPU acceleration...
I currently run tests and development on an RTX 4070, which allows me to prototype and benchmark GPU-based implementations efficiently..."

EXAMPLE 3 (structured plan with numbered steps):
"I'd love to help you streamline the conversion...
Here's how I would approach the project:
1. Translation Automation — I will use OpenAI's language models to accurately translate...
2. Voice Generation — I'll feed the translated lines into ElevenLabs...
3. Scripted Automation — I'll develop a custom script to..."

RULES:
- Start with "Hi there," or "I'd love to help" — warm and personal
- Use bullet points (•), numbered lists, and emojis (✅ 🔗 📌) where helpful for structure
- Name EXACT technologies, libraries, hardware — never be vague
- If you have a GitHub repo, lead with it as proof
- Include 1 concrete similar project with specific results (numbers, timelines)
- End with a structured deliverable plan OR a soft CTA
- Sign off with: "Best,\\n${signoff || "Isaiah"}"
- Sound like a real engineer excited about the work, not a template
- NO generic filler like "I am writing to express my interest"
- Return ONLY the cover letter text, no preamble`;

  const msg = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 600,
    messages: [{ role: "user", content: prompt }],
  });

  const block = msg.content?.[0];
  if (!block || !("text" in block)) throw new Error("Empty Claude response");
  return block.text;
}

/**
 * Generate a specific answer to an Upwork screening question
 */
export async function answerScreeningQuestion(
  question: string,
  job: { title: string; description: string },
): Promise<string> {
  const persona = characterConfig?.persona || "a professional AI automation consultant";
  const msg = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 200,
    messages: [{
      role: "user",
      content: `You are ${persona} answering an Upwork screening question.

Job: ${job.title}
Description: ${job.description.slice(0, 300)}
Question: ${question}

Write a concise, specific answer (2-4 sentences). Reference your relevant experience.
Name exact technologies and tools. Sound like a real engineer, not a template.
Return ONLY the answer text.`,
    }],
  });
  const block = msg.content?.[0];
  if (!block || !("text" in block)) throw new Error("Empty Claude response");
  return block.text;
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

  const block = msg.content?.[0];
  if (!block || !("text" in block)) throw new Error("Empty Claude response");
  const score = parseInt(block.text.trim());
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

  const block = msg.content?.[0];
  if (!block || !("text" in block)) throw new Error("Empty Claude response");
  return block.text.trim();
}
