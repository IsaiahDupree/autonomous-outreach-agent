/**
 * src/Agent/index.ts — AI Agent core (Claude, mirrors Riona's Gemini agent)
 * Generates cover letters, prospect messages, and scoring using Claude API
 */
import Anthropic from "@anthropic-ai/sdk";
import logger from "../config/logger";
import { ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN } from "../secret";
import fs from "fs";
import path from "path";
import os from "os";

/**
 * Claude OAuth auto-refresh.
 * Reads token from ~/.claude/.credentials.json, auto-refreshes when expired.
 * Fallback chain: OAuth (auto-refresh) → ANTHROPIC_AUTH_TOKEN env → ANTHROPIC_API_KEY
 */
const CRED_PATH = path.join(os.homedir(), ".claude", ".credentials.json");
const OAUTH_BETA = "oauth-2025-04-20";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

async function refreshOAuthToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string; expiresAt: number } | null> {
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    });
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const data = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
    if (!data.access_token) {
      logger.error(`[Agent] OAuth refresh failed: ${data.error || "no access_token"}`);
      return null;
    }
    const result = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: Date.now() + (data.expires_in || 28800) * 1000,
    };
    // Write refreshed credentials back to disk
    const creds = JSON.parse(fs.readFileSync(CRED_PATH, "utf-8"));
    creds.claudeAiOauth = { ...creds.claudeAiOauth, ...result };
    fs.writeFileSync(CRED_PATH, JSON.stringify(creds), "utf-8");
    logger.info(`[Agent] OAuth token refreshed — expires ${new Date(result.expiresAt).toISOString()}`);
    return result;
  } catch (e) {
    logger.error(`[Agent] OAuth refresh error: ${(e as Error).message}`);
    return null;
  }
}

function makeOAuthClient(token: string): Anthropic {
  return new Anthropic({
    authToken: token,
    apiKey: null,
    defaultHeaders: { "anthropic-beta": OAUTH_BETA },
  });
}

async function getClientAsync(): Promise<Anthropic> {
  // 1. Try Claude Code OAuth credentials (auto-refresh if expired)
  try {
    if (fs.existsSync(CRED_PATH)) {
      const creds = JSON.parse(fs.readFileSync(CRED_PATH, "utf-8"));
      const oauth = creds.claudeAiOauth;
      if (oauth?.accessToken) {
        const needsRefresh = oauth.expiresAt && oauth.expiresAt - Date.now() < TOKEN_REFRESH_BUFFER_MS;
        if (!needsRefresh) {
          return makeOAuthClient(oauth.accessToken);
        }
        // Token expired or about to expire — refresh it
        if (oauth.refreshToken) {
          logger.info("[Agent] OAuth token expiring soon — refreshing...");
          const refreshed = await refreshOAuthToken(oauth.refreshToken);
          if (refreshed) return makeOAuthClient(refreshed.accessToken);
        }
        // Refresh failed but token might still work
        if (oauth.expiresAt > Date.now()) return makeOAuthClient(oauth.accessToken);
        logger.warn("[Agent] OAuth token expired and refresh failed — falling back");
      }
    }
  } catch (e) {
    logger.warn(`[Agent] Failed to read Claude credentials: ${(e as Error).message}`);
  }

  // 2. Try env var auth token
  if (ANTHROPIC_AUTH_TOKEN) return makeOAuthClient(ANTHROPIC_AUTH_TOKEN);

  // 3. Fall back to API key
  return new Anthropic({ apiKey: ANTHROPIC_API_KEY });
}

// Synchronous version for backwards compat — uses cached token without refresh
function getClient(): Anthropic {
  try {
    if (fs.existsSync(CRED_PATH)) {
      const creds = JSON.parse(fs.readFileSync(CRED_PATH, "utf-8"));
      const oauth = creds.claudeAiOauth;
      if (oauth?.accessToken && (!oauth.expiresAt || oauth.expiresAt > Date.now())) {
        return makeOAuthClient(oauth.accessToken);
      }
    }
  } catch { /* fall through */ }
  if (ANTHROPIC_AUTH_TOKEN) return makeOAuthClient(ANTHROPIC_AUTH_TOKEN);
  return new Anthropic({ apiKey: ANTHROPIC_API_KEY });
}

/**
 * Strip all markdown formatting from text — Upwork renders plain text only.
 * Removes: **bold**, *italic*, [links](url), `code`, ### headings, etc.
 * Preserves: emojis, plain URLs, numbered lists, bullet characters.
 */
export function stripMarkdown(text: string): string {
  return text
    // Remove markdown links but keep the text and URL: [text](url) → text: url
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1: $2")
    // Remove bold/italic markers: **text** or __text__ → text
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/_{1,3}([^_]+)_{1,3}/g, "$1")
    // Remove inline code backticks
    .replace(/`([^`]+)`/g, "$1")
    // Remove heading markers
    .replace(/^#{1,6}\s+/gm, "")
    // Remove horizontal rules
    .replace(/^[-*_]{3,}\s*$/gm, "")
    // Clean up any double spaces left behind
    .replace(/  +/g, " ")
    .trim();
}

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
  youtube?: {
    channel: string;
    videos: Record<string, {
      url: string;
      title: string;
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
 * Find matching YouTube videos based on job keywords.
 * Returns up to 2 most relevant video links for proof of capability.
 */
export function getMatchingYouTubeVideos(job: { title: string; description: string }): string {
  const videos = characterConfig?.youtube?.videos;
  if (!videos) return "";
  const jobText = `${job.title} ${job.description}`.toLowerCase();

  const scored: Array<{ url: string; title: string; score: number }> = [];
  for (const [, video] of Object.entries(videos)) {
    const matchCount = video.keywords.filter(kw => jobText.includes(kw.toLowerCase())).length;
    if (matchCount >= 1) {
      scored.push({ url: video.url, title: video.title, score: matchCount });
    }
  }

  // Sort by match count, take top 2
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 2);
  if (top.length === 0) return "";

  const lines = top.map(v => `🎥 ${v.title}: ${v.url}`);
  return `\n\nI also make YouTube content showing my AI/automation work:\n${lines.join("\n")}`;
}

/**
 * Generate an Upwork cover letter for a job posting
 * Style modeled after Isaiah's winning proposals: warm, proof-driven, structured.
 */
export async function generateCoverLetter(job: {
  title: string;
  description: string;
  budget?: string;
  researchBrief?: string;
}): Promise<string> {
  const persona = characterConfig?.persona || "a professional AI automation consultant";
  const signoff = characterConfig?.name_signoff || "";
  const githubProof = getMatchingGithubRepo(job);
  const youtubeProof = getMatchingYouTubeVideos(job);

  const prompt = `You are ${persona}.

Write an Upwork cover letter (150-250 words) for this job:
Title: ${job.title}
Budget: ${job.budget || "not specified"}
Description: ${job.description.slice(0, 600)}
${githubProof ? `\nYou have this relevant GitHub repo to reference:${githubProof}` : ""}
${youtubeProof ? `\nYou have these relevant YouTube videos showing your work:${youtubeProof}` : ""}
${job.researchBrief ? `\nTECHNICAL RESEARCH (use these insights to sound knowledgeable — reference specific tools/versions):\n${job.researchBrief}` : ""}

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
- If you have YouTube videos, you MUST include ALL provided YouTube video links as proof of capability (shows you actually build and ship). List each on its own line with the 🎥 emoji and title.
- Include 1 concrete similar project with specific results (numbers, timelines)
- End with a structured deliverable plan OR a soft CTA
- Sign off with: "Best,\\n${signoff || "Isaiah"}"
- Sound like a real engineer excited about the work, not a template
- NO generic filler like "I am writing to express my interest"
- CRITICAL: NO markdown formatting. No **bold**, no *italic*, no [links](url), no \`code\`. Upwork renders plain text only.
  - Write URLs as plain text: https://github.com/... NOT [text](url)
  - Use plain dashes (-) or bullet chars (•) for lists, NOT markdown syntax
- Return ONLY the cover letter text, no preamble`;

  const msg = await (await getClientAsync()).messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 600,
    messages: [{ role: "user", content: prompt }],
  });

  const block = msg.content?.[0];
  if (!block || !("text" in block)) throw new Error("Empty Claude response");
  return stripMarkdown(block.text);
}

// ── Proposal Quality Gate ─────────────────────────────────────────────────

export interface QualityCheckResult {
  passed: boolean;
  score: number;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  suggestions: string[];
}

/**
 * Deterministic quality gate: validates a cover letter meets winning proposal standards
 * before it can be submitted. Based on patterns from 5 won proposals.
 *
 * Checks:
 * 1. Warm opening (not generic)
 * 2. Specific tech mentioned (exact tools, libraries, versions)
 * 3. Proof element (GitHub link, portfolio, or concrete past project)
 * 4. Structured deliverables (numbered steps or bullet list)
 * 5. Name sign-off
 * 6. Minimum length (150 words)
 * 7. No generic filler phrases
 * 8. Addresses job-specific needs (references keywords from job)
 */
export function qualityCheckCoverLetter(
  coverLetter: string,
  job: { title: string; description: string; skills?: string[]; tags?: string[] },
): QualityCheckResult {
  const text = coverLetter || "";
  const lower = text.toLowerCase();
  const words = text.split(/\s+/).filter(Boolean);
  const checks: Array<{ name: string; passed: boolean; detail: string }> = [];
  const suggestions: string[] = [];

  // 1. Warm opening — must start with greeting, not generic
  const warmOpenings = ["hi there", "i'd love to", "i'd be thrilled", "i noticed", "hello", "hey there"];
  const genericOpenings = ["i am writing", "dear hiring", "to whom", "i wish to", "i want to apply", "i am interested"];
  const hasWarmOpening = warmOpenings.some(o => lower.startsWith(o) || lower.slice(0, 50).includes(o));
  const hasGenericOpening = genericOpenings.some(o => lower.slice(0, 100).includes(o));
  checks.push({
    name: "warm_opening",
    passed: hasWarmOpening && !hasGenericOpening,
    detail: hasGenericOpening ? "Generic opening detected" : hasWarmOpening ? "Warm opening" : "No warm greeting found",
  });
  if (!hasWarmOpening) suggestions.push("Start with 'Hi there,' or 'I'd love to help' — warm and personal");
  if (hasGenericOpening) suggestions.push("Remove generic filler like 'I am writing to express my interest'");

  // 2. Specific technologies — must name exact tools/libraries, not be vague
  const techPatterns = [
    /\b(python|typescript|javascript|react|node\.?js|fastapi|django|flask)\b/i,
    /\b(claude|gpt-?[34o]|openai|anthropic|gemini|llama)\b/i,
    /\b(n8n|make\.com|zapier|puppeteer|selenium|playwright)\b/i,
    /\b(mongodb|postgres|supabase|firebase|redis|docker|kubernetes)\b/i,
    /\b(pytorch|tensorflow|cuda|cupy|numba|pandas|numpy)\b/i,
    /\b(aws|gcp|azure|vercel|railway|digitalocean)\b/i,
    /\b(rtx\s?\d{4}|gpu|raspberry\s?pi|arduino|esp32)\b/i,
    /\b(next\.?js|vue|svelte|tailwind|prisma|drizzle)\b/i,
    /\b(elevenlabs|whisper|tts|stt|langchain|rag)\b/i,
    /\b(matlab|simulink|solidworks|cad|fea)\b/i,
  ];
  const techMatches = techPatterns.filter(p => p.test(text)).length;
  checks.push({
    name: "specific_tech",
    passed: techMatches >= 2,
    detail: `${techMatches} tech categories mentioned`,
  });
  if (techMatches < 2) suggestions.push("Name at least 2 specific technologies, libraries, or tools — never be vague");

  // 3. Proof element — GitHub link, YouTube video, portfolio, or concrete past project
  const hasGithub = /github\.com/i.test(text);
  const hasYouTube = /youtube\.com|youtu\.be/i.test(text);
  const hasPortfolio = /portfolio|isaiah-portfolio/i.test(text);
  const hasProofProject = /i('ve| have) (built|created|developed|shipped|delivered|implemented|deployed)/i.test(text);
  const hasConcreteResult = /\d+\s*(user|client|project|request|record|%|hour|day|week)/i.test(text);
  const proofScore = (hasGithub ? 1 : 0) + (hasYouTube ? 1 : 0) + (hasPortfolio ? 1 : 0) + (hasProofProject ? 1 : 0) + (hasConcreteResult ? 1 : 0);
  checks.push({
    name: "proof_element",
    passed: proofScore >= 1,
    detail: [
      hasGithub && "GitHub link",
      hasYouTube && "YouTube video",
      hasPortfolio && "Portfolio",
      hasProofProject && "Past project reference",
      hasConcreteResult && "Concrete result with numbers",
    ].filter(Boolean).join(", ") || "No proof elements found",
  });
  if (proofScore === 0) suggestions.push("Include proof: GitHub repo link, YouTube video, portfolio, or describe a concrete past project with results");

  // 4. Structured deliverables — numbered steps or bullet list
  const numberedSteps = (text.match(/^\s*\d+[\.\)]\s/gm) || []).length;
  const bulletPoints = (text.match(/[•✅📌🔗✓\-]\s/g) || []).length;
  const hasStructure = numberedSteps >= 2 || bulletPoints >= 2;
  checks.push({
    name: "structured_deliverables",
    passed: hasStructure,
    detail: `${numberedSteps} numbered steps, ${bulletPoints} bullet points`,
  });
  if (!hasStructure) suggestions.push("Add a structured plan: numbered steps (1. 2. 3.) or bullet points for deliverables");

  // 5. Name sign-off
  const signoff = characterConfig?.name_signoff || "Isaiah";
  const hasSignoff = text.includes(signoff) || /\b(best|regards|cheers),?\s*\n/i.test(text);
  checks.push({
    name: "name_signoff",
    passed: hasSignoff,
    detail: hasSignoff ? `Signs off with "${signoff}"` : "No name sign-off found",
  });
  if (!hasSignoff) suggestions.push(`End with: "Best,\\n${signoff}"`);

  // 6. Length — 150-350 words (sweet spot for winning proposals)
  const wordCount = words.length;
  const lengthOk = wordCount >= 120 && wordCount <= 400;
  checks.push({
    name: "word_count",
    passed: lengthOk,
    detail: `${wordCount} words (target: 150-350)`,
  });
  if (wordCount < 120) suggestions.push(`Too short (${wordCount} words). Winning proposals are 150-250 words.`);
  if (wordCount > 400) suggestions.push(`Too long (${wordCount} words). Keep it concise — 150-250 words.`);

  // 7. No generic filler
  const fillers = [
    "i am confident", "i am the right", "look no further",
    "i guarantee", "100% satisfaction", "i am a hard worker",
    "please consider", "thank you for the opportunity",
    "i am eager to", "i assure you",
  ];
  const foundFillers = fillers.filter(f => lower.includes(f));
  checks.push({
    name: "no_filler",
    passed: foundFillers.length === 0,
    detail: foundFillers.length === 0 ? "No generic filler" : `Filler found: "${foundFillers[0]}"`,
  });
  if (foundFillers.length > 0) suggestions.push(`Remove filler: "${foundFillers[0]}" — sound like a real engineer, not a template`);

  // 8. No markdown — Upwork renders plain text only
  const markdownPatterns = [
    /\*\*[^*]+\*\*/,        // **bold**
    /\*[^*]+\*/,            // *italic*  (but allow standalone * in bullet lists)
    /\[[^\]]+\]\([^)]+\)/,  // [link](url)
    /`[^`]+`/,              // `code`
    /^#{1,6}\s/m,           // # heading
  ];
  const foundMarkdown = markdownPatterns.filter(p => p.test(text));
  const hasMarkdown = foundMarkdown.length > 0;
  checks.push({
    name: "no_markdown",
    passed: !hasMarkdown,
    detail: hasMarkdown ? `Markdown detected (${foundMarkdown.length} patterns)` : "Clean plain text",
  });
  if (hasMarkdown) suggestions.push("Remove all markdown formatting — Upwork renders plain text. Use plain URLs, not [text](url)");

  // 9. Job-specific relevance — references keywords from the job
  const jobKeywords = extractJobKeywords(job);
  const matchedKeywords = jobKeywords.filter(kw => lower.includes(kw.toLowerCase()));
  const relevanceOk = matchedKeywords.length >= 2 || jobKeywords.length < 2;
  checks.push({
    name: "job_relevance",
    passed: relevanceOk,
    detail: `${matchedKeywords.length}/${jobKeywords.length} job keywords referenced: ${matchedKeywords.slice(0, 5).join(", ") || "none"}`,
  });
  if (!relevanceOk) suggestions.push(`Reference specific job needs: ${jobKeywords.slice(0, 4).join(", ")}`);

  // Calculate overall score (weighted)
  const weights: Record<string, number> = {
    warm_opening: 10, specific_tech: 15, proof_element: 20,
    structured_deliverables: 15, name_signoff: 5, word_count: 10,
    no_filler: 5, no_markdown: 10, job_relevance: 10,
  };
  let earned = 0;
  let total = 0;
  for (const check of checks) {
    const w = weights[check.name] || 10;
    total += w;
    if (check.passed) earned += w;
  }
  const score = Math.round((earned / total) * 100);
  const passed = score >= 60 && checks.filter(c => !c.passed).length <= 2;

  return { passed, score, checks, suggestions };
}

/**
 * Extract key terms from a job to check proposal relevance.
 */
function extractJobKeywords(job: { title: string; description: string; skills?: string[]; tags?: string[] }): string[] {
  const keywords: string[] = [];
  // Add explicit skills/tags
  if (job.skills?.length) keywords.push(...job.skills.slice(0, 8));
  if (job.tags?.length) keywords.push(...job.tags.slice(0, 8));
  // Extract tech terms from title + description
  const text = `${job.title} ${job.description}`.toLowerCase();
  const techTerms = [
    "python", "typescript", "javascript", "react", "node", "fastapi",
    "django", "flask", "mongodb", "postgres", "supabase", "firebase",
    "docker", "aws", "gcp", "openai", "claude", "gpt", "llm",
    "n8n", "make", "zapier", "puppeteer", "selenium", "scrapy",
    "tensorflow", "pytorch", "pandas", "langchain", "rag",
    "next.js", "vue", "svelte", "tailwind", "graphql", "rest api",
    "raspberry pi", "arduino", "esp32", "matlab", "gpu", "cuda",
    "elevenlabs", "whisper", "tts", "voice", "chatbot", "agent",
    "automation", "scraping", "dashboard", "pipeline", "workflow",
  ];
  for (const term of techTerms) {
    if (text.includes(term) && !keywords.some(k => k.toLowerCase() === term)) {
      keywords.push(term);
    }
  }
  return [...new Set(keywords)].slice(0, 12);
}

/**
 * AI-powered quality refinement: if deterministic check fails,
 * ask Claude to fix the proposal and return an improved version.
 */
export async function refineCoverLetter(
  coverLetter: string,
  job: { title: string; description: string; skills?: string[]; tags?: string[] },
  qualityResult: QualityCheckResult,
): Promise<string> {
  const failedChecks = qualityResult.checks.filter(c => !c.passed);
  const suggestions = qualityResult.suggestions;

  if (failedChecks.length === 0) return coverLetter;

  const signoff = characterConfig?.name_signoff || "Isaiah";
  const githubProof = getMatchingGithubRepo(job);

  const msg = await (await getClientAsync()).messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 600,
    messages: [{
      role: "user",
      content: `You are a proposal editor. Fix this Upwork cover letter to meet quality standards.

CURRENT COVER LETTER:
${coverLetter}

JOB TITLE: ${job.title}
JOB DESCRIPTION: ${job.description.slice(0, 400)}
${githubProof ? `RELEVANT GITHUB REPO:${githubProof}` : ""}

FAILED QUALITY CHECKS:
${failedChecks.map(c => `- ${c.name}: ${c.detail}`).join("\n")}

REQUIRED FIXES:
${suggestions.map((s, i) => `${i + 1}. ${s}`).join("\n")}

RULES:
- Keep the core message but fix the failed checks
- Must be 150-250 words
- Must start with a warm greeting
- Must name exact technologies
- Must include proof (GitHub link, past project, or concrete results)
- Must have numbered steps or bullet points for deliverables
- Must sign off with "Best,\\n${signoff}"
- NO generic filler phrases
- CRITICAL: NO markdown formatting. No **bold**, no *italic*, no [links](url). Plain text only — Upwork does not render markdown.
- Return ONLY the improved cover letter text`,
    }],
  });

  const block = msg.content?.[0];
  if (!block || !("text" in block)) return coverLetter;
  return stripMarkdown(block.text);
}

/**
 * Generate a specific answer to an Upwork screening question
 */
export async function answerScreeningQuestion(
  question: string,
  job: { title: string; description: string },
): Promise<string> {
  const persona = characterConfig?.persona || "a professional AI automation consultant";
  const msg = await (await getClientAsync()).messages.create({
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

  const msg = await (await getClientAsync()).messages.create({
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
  const msg = await (await getClientAsync()).messages.create({
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
