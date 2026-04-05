/**
 * src/services/proof-of-work.ts — Generate proof-of-work artifacts for top proposals
 *
 * For high-scoring jobs, generates a technical brief + code samples that show
 * the client "we've already started thinking about your project." The artifact
 * is saved as a GitHub Gist and referenced in the cover letter.
 *
 * Only triggers for jobs with aiScore >= 8 or compositeScore >= 80.
 */
import logger from "../config/logger";
// AI calls go through ai-fallback.ts for Claude → OpenAI resilience
import { researchJob, formatResearchBrief } from "./research";
import * as cloud from "./cloud";
import { notify } from "./telegram";
import { GITHUB_TOKEN } from "../secret";

// ── Types ──

export interface ProofInput {
  jobId: string;
  title: string;
  description: string;
  budget?: string;
  tags?: string[];
}

export interface TechnicalBrief {
  analysis: string;
  architectureDiagram: string;
  codeSnippets: Array<{ filename: string; language: string; code: string }>;
  implementationPlan: string;
}

export interface ProofArtifact {
  type: "gist" | "inline";
  url?: string;
  brief: TechnicalBrief;
  generatedAt: string;
}

// ── Config ──

const PROOF_TIMEOUT_MS = 45 * 60 * 1000; // 45 minutes max

// ── Main Entry ──

/**
 * Generate a proof-of-work artifact for a high-value job.
 * Returns the artifact with optional Gist URL, or null on failure.
 */
export async function generateProofArtifact(job: ProofInput): Promise<ProofArtifact | null> {
  logger.info(`[proof] Generating artifact for "${job.title.slice(0, 50)}"`);

  try {
    // Research the job first for context
    let researchBrief: string | undefined;
    try {
      const research = await researchJob({
        title: job.title,
        description: job.description,
        budget: job.budget,
        skills: job.tags,
      });
      if (research) researchBrief = formatResearchBrief(research);
    } catch {
      logger.warn("[proof] Research failed — generating brief without it");
    }

    // Generate the technical brief
    const brief = await generateTechnicalBrief(job, researchBrief);

    // Try to create a GitHub Gist
    let url: string | undefined;
    if (GITHUB_TOKEN) {
      try {
        url = await createGist(brief, job.title);
      } catch (e) {
        logger.warn(`[proof] Gist creation failed: ${(e as Error).message} — using inline`);
      }
    }

    const artifact: ProofArtifact = {
      type: url ? "gist" : "inline",
      url,
      brief,
      generatedAt: new Date().toISOString(),
    };

    // Persist to Supabase
    await cloud.saveProofArtifact(job.jobId, artifact);

    logger.info(`[proof] Artifact ready for "${job.title.slice(0, 50)}" — ${artifact.type}${url ? `: ${url}` : ""}`);
    await notify(
      `🔨 *Proof-of-work generated*\n` +
      `Job: ${job.title.slice(0, 50)}\n` +
      `Type: ${artifact.type}${url ? `\n🔗 ${url}` : ""}`
    );

    return artifact;
  } catch (e) {
    logger.error(`[proof] Generation failed for "${job.title.slice(0, 50)}": ${(e as Error).message}`);
    return null;
  }
}

/**
 * Generate proof artifacts for multiple jobs in parallel.
 * Used by daily strategy to enrich top jobs after plan is built.
 * Respects the 45-minute timeout — any unfinished jobs get skipped.
 */
export async function enrichWithProofs(jobs: ProofInput[]): Promise<Map<string, ProofArtifact>> {
  if (jobs.length === 0) return new Map();

  logger.info(`[proof] Enriching ${jobs.length} jobs with proof artifacts`);

  const results = new Map<string, ProofArtifact>();
  const timeout = AbortSignal.timeout(PROOF_TIMEOUT_MS);

  const promises = jobs.map(async (job) => {
    if (timeout.aborted) return;
    const artifact = await generateProofArtifact(job);
    if (artifact) results.set(job.jobId, artifact);
  });

  await Promise.allSettled(promises);

  logger.info(`[proof] Enrichment complete: ${results.size}/${jobs.length} artifacts generated`);
  return results;
}

// ── Claude Brief Generation ──

async function generateTechnicalBrief(job: ProofInput, researchBrief?: string): Promise<TechnicalBrief> {
  const { aiComplete } = await import("./ai-fallback");

  const prompt = `You are a senior full-stack engineer preparing a technical brief for a potential client project.

JOB:
Title: ${job.title}
Description: ${job.description.slice(0, 1200)}
Budget: ${job.budget || "Not specified"}
Skills: ${(job.tags || []).join(", ")}
${researchBrief ? `\nRESEARCH CONTEXT:\n${researchBrief}` : ""}

Generate a technical brief that demonstrates you've already started thinking about their project. This will be shared as a GitHub Gist linked in the proposal.

Return EXACTLY this JSON structure (no markdown wrapping, pure JSON):
{
  "analysis": "2-3 paragraphs showing deep understanding of the project. Reference specific technologies, potential challenges, and your recommended approach. Mention concrete tools/libraries with version numbers where relevant. Show you understand their BUSINESS goal, not just the technical requirements.",
  "architectureDiagram": "ASCII art diagram showing the system architecture. Use box-drawing characters. Include data flow arrows. Label each component. Keep it under 30 lines.",
  "codeSnippets": [
    {
      "filename": "relevant_filename.ext",
      "language": "python or typescript or relevant language",
      "code": "50-80 lines of working starter code that demonstrates the KEY technical approach. Include imports, type hints, error handling. This should be code they could actually run."
    }
  ],
  "implementationPlan": "A phased timeline with 3-4 phases. Each phase: name, duration estimate, deliverables. Include a 'Week 1 quick win' that shows immediate value."
}

IMPORTANT:
- The code must be WORKING and demonstrate real capability, not pseudocode
- Reference specific library versions (e.g., "FastAPI 0.104", "React 18.2", "LangChain 0.1")
- The architecture diagram should be specific to THIS project, not generic
- The analysis should mention the client's business context and how your approach delivers ROI
- Keep the total brief concise but impressive — quality over quantity`;

  const result = await aiComplete({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
  });

  if (result.provider === "openai") {
    logger.info("[proof] Technical brief generated via OpenAI fallback");
  }

  // Parse JSON from response (handle potential markdown wrapping)
  let text = result.text.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  const parsed = JSON.parse(text) as TechnicalBrief;

  // Validate required fields
  if (!parsed.analysis || !parsed.architectureDiagram || !parsed.codeSnippets?.length || !parsed.implementationPlan) {
    throw new Error("Incomplete technical brief — missing required sections");
  }

  return parsed;
}

// ── GitHub Gist Creation ──

async function createGist(brief: TechnicalBrief, jobTitle: string): Promise<string> {
  const cleanTitle = jobTitle.replace(/[^a-zA-Z0-9\s-]/g, "").slice(0, 60).trim();
  const slug = cleanTitle.toLowerCase().replace(/\s+/g, "-");

  // Build gist files
  const files: Record<string, { content: string }> = {
    [`${slug}-technical-brief.md`]: {
      content: [
        `# Technical Brief: ${jobTitle}`,
        "",
        "## Project Analysis",
        "",
        brief.analysis,
        "",
        "## Architecture",
        "",
        "```",
        brief.architectureDiagram,
        "```",
        "",
        "## Implementation Plan",
        "",
        brief.implementationPlan,
        "",
        "---",
        `*Prepared by Isaiah Dupree — Full-Stack Engineer & AI Automation Specialist*`,
      ].join("\n"),
    },
  };

  // Add code snippets as separate files
  for (const snippet of brief.codeSnippets) {
    files[snippet.filename] = { content: snippet.code };
  }

  const res = await fetch("https://api.github.com/gists", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      description: `Technical Brief: ${jobTitle.slice(0, 80)}`,
      public: true,
      files,
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub Gist API error ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json() as { html_url: string };
  return data.html_url;
}

// ── Cover Letter Integration ──

/**
 * Format proof artifact for insertion into a cover letter.
 * Returns 2-3 lines that reference the technical brief.
 */
export function formatProofForCoverLetter(artifact: ProofArtifact): string {
  if (artifact.url) {
    return `I've already started analyzing your project and put together a technical brief with architecture and working code samples:\n${artifact.url}`;
  }
  // Inline fallback — include a teaser from the analysis
  const teaser = artifact.brief.analysis.split(".").slice(0, 2).join(".") + ".";
  return `I've already started analyzing your project. Here's my initial take:\n${teaser}`;
}
