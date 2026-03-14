/**
 * src/services/youtube-ideas.ts — Analyze Upwork job trends → generate YouTube content ideas
 * Reads from upwork_proposals, clusters by niche, scores demand, saves to youtube_content_ideas
 */
import { SUPABASE_URL, SUPABASE_KEY, ANTHROPIC_API_KEY } from "../secret";
import Anthropic from "@anthropic-ai/sdk";
import logger from "../config/logger";

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const supabaseHeaders = () => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
});

async function safeFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
}

// ── Niche definitions — map keywords to categories ──
const NICHE_MAP: Record<string, { keywords: string[]; label: string }> = {
  n8n_automation: {
    keywords: ["n8n", "make.com", "zapier", "no-code automation", "workflow automation"],
    label: "No-Code Automation (n8n / Make / Zapier)",
  },
  ai_agent: {
    keywords: ["ai agent", "ai automation", "ai engineer", "ai specialist", "autonomous"],
    label: "AI Agent & Automation",
  },
  llm_integration: {
    keywords: ["llm", "claude", "openai", "gpt", "rag", "langchain", "anthropic"],
    label: "LLM / Claude / OpenAI Integration",
  },
  lead_gen: {
    keywords: ["lead generation", "lead gen", "crm", "marketing automation", "email automation", "outreach"],
    label: "Lead Gen & Marketing Automation",
  },
  web_scraping: {
    keywords: ["web scraping", "scraper", "data extraction", "crawler", "data scraping"],
    label: "Web Scraping & Data Extraction",
  },
  full_stack_mvp: {
    keywords: ["full stack", "full-stack", "mvp", "saas", "web app", "web application", "dashboard"],
    label: "Full Stack / MVP / SaaS",
  },
  mobile_app: {
    keywords: ["mobile app", "react native", "flutter", "ios app", "android app", "cross platform"],
    label: "Mobile App Development",
  },
  voice_ai: {
    keywords: ["elevenlabs", "11labs", "voice ai", "text to speech", "voice agent", "voice cloning", "twilio voice"],
    label: "Voice AI & Speech",
  },
  data_pipeline: {
    keywords: ["data pipeline", "etl", "data integration", "api integration"],
    label: "Data Pipelines & ETL",
  },
  messaging: {
    keywords: ["whatsapp", "twilio", "discord bot", "telegram bot", "sms automation"],
    label: "Messaging & Chat Integrations",
  },
  python_dev: {
    keywords: ["python automation", "python script", "python developer"],
    label: "Python Development & Scripting",
  },
};

export interface NicheAnalysis {
  category: string;
  label: string;
  jobCount: number;
  avgBudget: number;
  maxBudget: number;
  budgetRange: string;
  avgScore: number;
  exampleJobs: Array<{ jobId: string; title: string; budget: string; score: number; url: string }>;
}

/**
 * Analyze all proposals in Supabase and cluster by niche.
 */
export async function analyzeNiches(): Promise<NicheAnalysis[]> {
  // Fetch all qualified proposals (score >= 5)
  const res = await safeFetch(
    `${SUPABASE_URL}/rest/v1/upwork_proposals?score=gte.5&select=job_id,job_title,budget,score,job_url,status&order=score.desc&limit=500`,
    { headers: supabaseHeaders() },
  );
  if (!res.ok) {
    logger.error(`[YouTube] Failed to fetch proposals: ${res.status}`);
    return [];
  }

  const jobs = (await res.json()) as Array<{
    job_id: string; job_title: string; budget: string | null;
    score: number; job_url: string; status: string;
  }>;

  logger.info(`[YouTube] Analyzing ${jobs.length} qualified jobs across ${Object.keys(NICHE_MAP).length} niches`);

  const results: NicheAnalysis[] = [];

  for (const [category, niche] of Object.entries(NICHE_MAP)) {
    const matching = jobs.filter((j) => {
      const text = (j.job_title || "").toLowerCase();
      return niche.keywords.some((kw) => text.includes(kw));
    });

    if (matching.length === 0) continue;

    // Parse budgets
    const budgets = matching
      .map((j) => {
        const m = (j.budget || "").match(/\$([\d,]+)/);
        return m ? parseFloat(m[1].replace(/,/g, "")) : 0;
      })
      .filter((b) => b > 0);

    const avgBudget = budgets.length > 0 ? Math.round(budgets.reduce((a, b) => a + b, 0) / budgets.length) : 0;
    const maxBudget = budgets.length > 0 ? Math.max(...budgets) : 0;
    const minBudget = budgets.length > 0 ? Math.min(...budgets) : 0;
    const avgScore = Math.round((matching.reduce((sum, j) => sum + j.score, 0) / matching.length) * 10) / 10;

    results.push({
      category,
      label: niche.label,
      jobCount: matching.length,
      avgBudget,
      maxBudget,
      budgetRange: budgets.length > 0 ? `$${minBudget.toLocaleString()} - $${maxBudget.toLocaleString()}` : "N/A",
      avgScore,
      exampleJobs: matching.slice(0, 5).map((j) => ({
        jobId: j.job_id,
        title: j.job_title,
        budget: j.budget || "N/A",
        score: j.score,
        url: j.job_url,
      })),
    });
  }

  // Sort by job count descending
  results.sort((a, b) => b.jobCount - a.jobCount);
  return results;
}

/**
 * Use Claude to generate a YouTube tutorial idea from a niche analysis.
 */
async function generateIdeaFromNiche(niche: NicheAnalysis, existingVideos: string[] = []): Promise<{
  title: string;
  slug: string;
  description: string;
  hook: string;
  techStack: string[];
  difficulty: string;
  estimatedDuration: string;
  outline: Array<{ step: number; title: string; description: string; duration: string }>;
  demandScore: number;
  feasibilityScore: number;
}> {
  const exampleList = niche.exampleJobs
    .map((j) => `- "${j.title}" (${j.budget}, score ${j.score}/10)`)
    .join("\n");

  const msg = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 800,
    messages: [{
      role: "user",
      content: `You are a YouTube content strategist for a developer who does AI automation, web scraping, and full-stack freelancing on Upwork.

Based on this Upwork market data, generate a YouTube tutorial idea:

Niche: ${niche.label}
Job count: ${niche.jobCount} active jobs
Average budget: $${niche.avgBudget}
Budget range: ${niche.budgetRange}
Average fit score: ${niche.avgScore}/10

Example jobs clients are posting:
${exampleList}

Reply in EXACTLY this JSON format (no markdown):
{
  "title": "Build X with Y — Complete Tutorial",
  "slug": "build-x-with-y",
  "description": "2-3 sentence description of what viewers will learn and build",
  "hook": "Short thumbnail/intro hook (under 10 words)",
  "techStack": ["tool1", "tool2", "tool3"],
  "difficulty": "beginner|intermediate|advanced",
  "estimatedDuration": "30 min|45 min|1 hour|2 hours",
  "outline": [
    {"step": 1, "title": "Step title", "description": "What we do", "duration": "5 min"},
    {"step": 2, "title": "...", "description": "...", "duration": "10 min"}
  ],
  "demandScore": 8,
  "feasibilityScore": 7
}

Existing videos on my channel (avoid duplicating these topics):
${existingVideos.slice(0, 20).map((v) => `- ${v}`).join("\n")}

IMPORTANT:
- Title should be searchable (include the main tech stack)
- The project must be completable in the video duration
- Focus on what Upwork clients actually pay for (not theory)
- Include real deliverables viewers can show in their portfolio
- demandScore: 1-10 based on job count and budget
- feasibilityScore: 1-10 based on how fast this demo can be built
- Do NOT duplicate existing video topics — find the GAP between what I've covered and what clients pay for`,
    }],
  });

  const block = msg.content?.[0];
  if (!block || !("text" in block)) throw new Error("Empty Claude response");
  let text = block.text.trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON found");
  return JSON.parse(jsonMatch[0]);
}

/**
 * Save a content idea to Supabase.
 */
async function saveIdea(niche: NicheAnalysis, idea: Awaited<ReturnType<typeof generateIdeaFromNiche>>): Promise<boolean> {
  const overallScore = Math.round(((idea.demandScore * 0.5) + (idea.feasibilityScore * 0.3) + (niche.avgScore * 0.2)) * 10) / 10;

  const body = {
    title: idea.title,
    slug: idea.slug,
    description: idea.description,
    hook: idea.hook,
    category: niche.category,
    job_count: niche.jobCount,
    avg_budget: niche.avgBudget,
    max_budget: niche.maxBudget,
    budget_range: niche.budgetRange,
    example_jobs: niche.exampleJobs,
    tech_stack: idea.techStack,
    difficulty: idea.difficulty,
    estimated_duration: idea.estimatedDuration,
    tutorial_outline: idea.outline,
    demand_score: idea.demandScore,
    feasibility_score: idea.feasibilityScore,
    overall_score: overallScore,
    priority: Math.round(overallScore * niche.jobCount),
    analyzed_at: new Date().toISOString(),
  };

  const res = await safeFetch(`${SUPABASE_URL}/rest/v1/youtube_content_ideas`, {
    method: "POST",
    headers: { ...supabaseHeaders(), Prefer: "return=representation,resolution=merge-duplicates" },
    body: JSON.stringify(body),
  });

  if (res.status === 409) {
    // Update existing
    await safeFetch(
      `${SUPABASE_URL}/rest/v1/youtube_content_ideas?slug=eq.${encodeURIComponent(idea.slug)}`,
      { method: "PATCH", headers: supabaseHeaders(), body: JSON.stringify({ ...body, updated_at: new Date().toISOString() }) },
    );
  }

  return res.ok || res.status === 409;
}

/**
 * Fetch existing YouTube videos from yt_content_queue to avoid duplicate ideas
 * and cross-reference what's already covered.
 */
async function getExistingVideos(): Promise<string[]> {
  try {
    const res = await safeFetch(
      `${SUPABASE_URL}/rest/v1/yt_content_queue?select=title&limit=100`,
      { headers: supabaseHeaders() },
    );
    if (!res.ok) return [];
    const rows = (await res.json()) as Array<{ title: string }>;
    return rows.map((r) => r.title.toLowerCase());
  } catch {
    return [];
  }
}

/**
 * Full pipeline: analyze Upwork trends → cross-ref existing videos → generate ideas → save to Supabase.
 */
export async function runContentIdeaPipeline(): Promise<{
  analyzed: number;
  generated: number;
  saved: number;
  ideas: Array<{ title: string; category: string; score: number; jobCount: number }>;
}> {
  logger.info("[YouTube] Starting content idea pipeline...");

  const niches = await analyzeNiches();
  logger.info(`[YouTube] Found ${niches.length} active niches`);

  // Cross-reference with existing YouTube content
  const existingVideos = await getExistingVideos();
  logger.info(`[YouTube] Found ${existingVideos.length} existing videos for gap analysis`);

  const results: Array<{ title: string; category: string; score: number; jobCount: number }> = [];
  let generated = 0;
  let saved = 0;

  for (const niche of niches) {
    try {
      const idea = await generateIdeaFromNiche(niche, existingVideos);
      generated++;

      const overallScore = Math.round(((idea.demandScore * 0.5) + (idea.feasibilityScore * 0.3) + (niche.avgScore * 0.2)) * 10) / 10;

      const ok = await saveIdea(niche, idea);
      if (ok) saved++;

      results.push({
        title: idea.title,
        category: niche.label,
        score: overallScore,
        jobCount: niche.jobCount,
      });

      logger.info(`[YouTube] Generated: "${idea.title}" (score ${overallScore}, ${niche.jobCount} jobs)`);
    } catch (e) {
      logger.error(`[YouTube] Failed to generate idea for ${niche.label}: ${(e as Error).message}`);
    }
  }

  results.sort((a, b) => b.score - a.score);
  logger.info(`[YouTube] Pipeline complete: ${niches.length} analyzed, ${generated} generated, ${saved} saved`);
  return { analyzed: niches.length, generated, saved, ideas: results };
}
