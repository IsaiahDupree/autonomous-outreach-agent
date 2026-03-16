/**
 * src/services/research.ts — Perplexity Sonar API for job research
 * Researches key technical aspects of a job before generating proposals.
 */
import logger from "../config/logger";
import { PERPLEXITY_API_KEY } from "../secret";
const PERPLEXITY_BASE_URL = "https://api.perplexity.ai";

export interface JobResearch {
  /** Concise technical summary of what the job requires */
  summary: string;
  /** Key technologies and their current best practices */
  techInsights: string[];
  /** Implementation approach recommendations */
  implementation: string[];
  /** Potential pitfalls or challenges to mention in proposal */
  pitfalls: string[];
  /** Relevant industry context or trends */
  context: string;
  /** Source citations from Perplexity */
  citations: string[];
}

/**
 * Research a job posting using Perplexity Sonar to gather
 * current best practices, implementation approaches, and technical context.
 */
export async function researchJob(job: {
  title: string;
  description: string;
  budget?: string;
  skills?: string[];
}): Promise<JobResearch | null> {
  if (!PERPLEXITY_API_KEY) {
    logger.warn("[Research] No PERPLEXITY_API_KEY set — skipping research");
    return null;
  }

  const skillsStr = job.skills?.length ? `\nRequired skills: ${job.skills.join(", ")}` : "";

  try {
    const res = await fetch(`${PERPLEXITY_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${PERPLEXITY_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "sonar",
        messages: [
          {
            role: "system",
            content: `You are a senior technical consultant researching a freelance job posting.
Provide a comprehensive yet concise research brief that will help write a winning proposal.
Focus on: current best practices, recommended tech stack, common pitfalls, and implementation approach.
Be specific — name exact libraries, versions, and tools. No fluff.
Respond in valid JSON with this structure:
{
  "summary": "2-3 sentence overview of what this job needs",
  "techInsights": ["insight1", "insight2", ...],
  "implementation": ["step1", "step2", ...],
  "pitfalls": ["pitfall1", "pitfall2", ...],
  "context": "1-2 sentences of industry context or trends"
}`,
          },
          {
            role: "user",
            content: `Research this freelance job posting and give me a technical brief:

Title: ${job.title}
Budget: ${job.budget || "not specified"}
Description: ${job.description.slice(0, 800)}${skillsStr}

What are the current best practices, recommended tools/libraries, common pitfalls, and optimal implementation approach for this type of project?`,
          },
        ],
        max_tokens: 800,
        temperature: 0.3,
        search_recency_filter: "month",
      }),
    });

    if (!res.ok) {
      logger.error(`[Research] Perplexity API error: ${res.status} ${res.statusText}`);
      return null;
    }

    const data = await res.json() as {
      choices: Array<{ message: { content: string } }>;
      citations?: string[];
    };
    const content = data.choices?.[0]?.message?.content || "";
    const citations = data.citations || [];

    // Parse JSON from response (may be wrapped in ```json blocks)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn("[Research] Could not parse JSON from Perplexity response");
      return {
        summary: content.slice(0, 300),
        techInsights: [],
        implementation: [],
        pitfalls: [],
        context: "",
        citations,
      };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    logger.info(`[Research] Job researched: "${job.title.slice(0, 50)}" — ${parsed.techInsights?.length || 0} insights`);

    return {
      summary: parsed.summary || "",
      techInsights: parsed.techInsights || [],
      implementation: parsed.implementation || [],
      pitfalls: parsed.pitfalls || [],
      context: parsed.context || "",
      citations,
    };
  } catch (e) {
    logger.error(`[Research] Error: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Format research into a concise brief for the cover letter prompt.
 */
export function formatResearchBrief(research: JobResearch): string {
  const parts: string[] = [];
  if (research.summary) parts.push(`Overview: ${research.summary}`);
  if (research.techInsights.length) parts.push(`Key tech: ${research.techInsights.slice(0, 4).join("; ")}`);
  if (research.implementation.length) parts.push(`Approach: ${research.implementation.slice(0, 3).join("; ")}`);
  if (research.pitfalls.length) parts.push(`Watch out for: ${research.pitfalls.slice(0, 2).join("; ")}`);
  if (research.context) parts.push(`Context: ${research.context}`);
  return parts.join("\n");
}
