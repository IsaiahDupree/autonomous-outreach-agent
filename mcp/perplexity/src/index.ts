#!/usr/bin/env node
/**
 * mcp/perplexity — MCP server for Perplexity APIs
 * Exposes Sonar, Sonar Pro, Reasoning, Deep Research, and raw Web Search as tools.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY || "";
const BASE_URL = "https://api.perplexity.ai";

if (!PERPLEXITY_API_KEY) {
  console.error("WARNING: PERPLEXITY_API_KEY not set — all tools will fail");
}

// ── Shared helpers ──────────────────────────────────────────────────────────

interface SonarRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens?: number;
  temperature?: number;
  search_recency_filter?: string;
  search_mode?: string;
  search_domain_filter?: string[];
  return_images?: boolean;
  return_related_questions?: boolean;
  web_search_options?: Record<string, unknown>;
  response_format?: Record<string, unknown>;
}

interface SonarResponse {
  id: string;
  model: string;
  choices: Array<{ message: { role: string; content: string } }>;
  citations?: string[];
  search_results?: Array<{
    title: string;
    url: string;
    date?: string;
    snippet?: string;
  }>;
  images?: Array<{
    image_url: string;
    origin_url?: string;
    title?: string;
  }>;
  related_questions?: string[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    citation_tokens?: number;
    num_search_queries?: number;
    cost?: Record<string, number>;
  };
}

async function callSonar(body: SonarRequest): Promise<SonarResponse> {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Perplexity API ${res.status}: ${errText || res.statusText}`);
  }
  return res.json() as Promise<SonarResponse>;
}

interface SearchRequest {
  query: string | string[];
  max_results?: number;
  country?: string;
  search_domain_filter?: string[];
  search_language_filter?: string[];
}

interface SearchResponse {
  results: Array<{
    title: string;
    url: string;
    snippet: string;
    date?: string;
  }>;
  id: string;
}

async function callSearch(body: SearchRequest): Promise<SearchResponse> {
  const res = await fetch(`${BASE_URL}/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Perplexity Search API ${res.status}: ${errText || res.statusText}`);
  }
  return res.json() as Promise<SearchResponse>;
}

function formatSonarResult(data: SonarResponse): string {
  const parts: string[] = [];
  const content = data.choices?.[0]?.message?.content || "(no content)";
  parts.push(content);

  if (data.citations?.length) {
    parts.push("\n\n--- Sources ---");
    data.citations.forEach((c, i) => parts.push(`[${i + 1}] ${c}`));
  }
  if (data.search_results?.length) {
    parts.push("\n\n--- Search Results ---");
    data.search_results.forEach((r, i) =>
      parts.push(`[${i + 1}] ${r.title}\n    ${r.url}${r.snippet ? `\n    ${r.snippet.slice(0, 200)}` : ""}`)
    );
  }
  if (data.images?.length) {
    parts.push("\n\n--- Images ---");
    data.images.forEach((img, i) =>
      parts.push(`[${i + 1}] ${img.title || "Image"}: ${img.image_url}`)
    );
  }
  if (data.related_questions?.length) {
    parts.push("\n\n--- Related Questions ---");
    data.related_questions.forEach((q, i) => parts.push(`${i + 1}. ${q}`));
  }
  if (data.usage) {
    const u = data.usage;
    parts.push(`\n\n--- Usage: ${u.total_tokens} tokens, ${u.num_search_queries || 0} searches ---`);
  }
  return parts.join("\n");
}

// ── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "perplexity",
  version: "1.0.0",
});

// ── Tool 1: Sonar Search (fast, cheap) ──────────────────────────────────────

server.registerTool(
  "sonar_search",
  {
    title: "Perplexity Sonar Search",
    description:
      "Fast AI-powered web search using Perplexity Sonar. Best for quick factual lookups, current events, and general research. Returns AI summary + citations + search results.",
    inputSchema: {
      query: z.string().describe("The search query or question"),
      system_prompt: z
        .string()
        .optional()
        .describe("Optional system prompt to guide the response style"),
      recency: z
        .enum(["hour", "day", "week", "month", "year"])
        .optional()
        .describe("Filter results by recency"),
      search_mode: z
        .enum(["web", "academic", "sec"])
        .optional()
        .describe("Search mode: web (default), academic (scholarly), or sec (SEC filings)"),
      domains: z
        .string()
        .optional()
        .describe("Comma-separated domain filter (prefix - to exclude, e.g. 'reddit.com,-pinterest.com')"),
      max_tokens: z.number().min(1).max(4096).optional().describe("Max response tokens (default 1024)"),
      return_images: z.boolean().optional().describe("Return relevant images (Tier 2+ only)"),
      return_related: z.boolean().optional().describe("Return related follow-up questions"),
    },
  },
  async ({ query, system_prompt, recency, search_mode, domains, max_tokens, return_images, return_related }) => {
    const messages: Array<{ role: string; content: string }> = [];
    if (system_prompt) messages.push({ role: "system", content: system_prompt });
    messages.push({ role: "user", content: query });

    const body: SonarRequest = {
      model: "sonar",
      messages,
      max_tokens: max_tokens || 1024,
      temperature: 0.2,
    };
    if (recency) body.search_recency_filter = recency;
    if (search_mode) body.search_mode = search_mode;
    if (domains) body.search_domain_filter = domains.split(",").map((d) => d.trim());
    if (return_images) body.return_images = true;
    if (return_related) body.return_related_questions = true;

    const data = await callSonar(body);
    return { content: [{ type: "text" as const, text: formatSonarResult(data) }] };
  }
);

// ── Tool 2: Sonar Pro Search (deeper, multi-step) ──────────────────────────

server.registerTool(
  "sonar_pro_search",
  {
    title: "Perplexity Sonar Pro Search",
    description:
      "Deep AI-powered web search using Sonar Pro. Higher reasoning capability, supports Pro Search mode for multi-step research. Best for complex questions requiring synthesis from multiple sources.",
    inputSchema: {
      query: z.string().describe("The research question or complex query"),
      system_prompt: z.string().optional().describe("Optional system prompt"),
      recency: z.enum(["hour", "day", "week", "month", "year"]).optional().describe("Recency filter"),
      search_mode: z.enum(["web", "academic", "sec"]).optional().describe("Search mode"),
      search_type: z
        .enum(["fast", "pro", "auto"])
        .optional()
        .describe("Search depth: fast (default), pro (multi-step deeper), auto (model decides)"),
      search_context_size: z
        .enum(["low", "medium", "high"])
        .optional()
        .describe("How much search context to fetch (affects cost)"),
      domains: z.string().optional().describe("Comma-separated domain filter"),
      max_tokens: z.number().min(1).max(8192).optional().describe("Max response tokens (default 2048)"),
      return_images: z.boolean().optional(),
      return_related: z.boolean().optional(),
    },
  },
  async ({
    query, system_prompt, recency, search_mode, search_type, search_context_size,
    domains, max_tokens, return_images, return_related,
  }) => {
    const messages: Array<{ role: string; content: string }> = [];
    if (system_prompt) messages.push({ role: "system", content: system_prompt });
    messages.push({ role: "user", content: query });

    const body: SonarRequest = {
      model: "sonar-pro",
      messages,
      max_tokens: max_tokens || 2048,
      temperature: 0.2,
    };
    if (recency) body.search_recency_filter = recency;
    if (search_mode) body.search_mode = search_mode;
    if (domains) body.search_domain_filter = domains.split(",").map((d) => d.trim());
    if (return_images) body.return_images = true;
    if (return_related) body.return_related_questions = true;

    const webOpts: Record<string, unknown> = {};
    if (search_type) webOpts.search_type = search_type;
    if (search_context_size) webOpts.search_context_size = search_context_size;
    if (Object.keys(webOpts).length > 0) body.web_search_options = webOpts;

    const data = await callSonar(body);
    return { content: [{ type: "text" as const, text: formatSonarResult(data) }] };
  }
);

// ── Tool 3: Sonar Reasoning (analytical/logical tasks) ──────────────────────

server.registerTool(
  "sonar_reasoning",
  {
    title: "Perplexity Sonar Reasoning",
    description:
      "Analytical reasoning with web search using Sonar Reasoning Pro. Best for complex analysis, comparisons, technical evaluations, and tasks requiring step-by-step logic with real-time data.",
    inputSchema: {
      query: z.string().describe("The analytical question requiring reasoning"),
      system_prompt: z.string().optional().describe("Optional system prompt"),
      reasoning_effort: z
        .enum(["minimal", "low", "medium", "high"])
        .optional()
        .describe("How much reasoning effort to apply (default: medium)"),
      recency: z.enum(["hour", "day", "week", "month", "year"]).optional(),
      search_mode: z.enum(["web", "academic", "sec"]).optional(),
      max_tokens: z.number().min(1).max(8192).optional().describe("Max response tokens (default 2048)"),
    },
  },
  async ({ query, system_prompt, reasoning_effort, recency, search_mode, max_tokens }) => {
    const messages: Array<{ role: string; content: string }> = [];
    if (system_prompt) messages.push({ role: "system", content: system_prompt });
    messages.push({ role: "user", content: query });

    const body: Record<string, unknown> = {
      model: "sonar-reasoning-pro",
      messages,
      max_tokens: max_tokens || 2048,
      temperature: 0.2,
    };
    if (reasoning_effort) body.reasoning_effort = reasoning_effort;
    if (recency) body.search_recency_filter = recency;
    if (search_mode) body.search_mode = search_mode;

    const data = await callSonar(body as unknown as SonarRequest);
    return { content: [{ type: "text" as const, text: formatSonarResult(data) }] };
  }
);

// ── Tool 4: Deep Research (multi-step, comprehensive) ───────────────────────

server.registerTool(
  "deep_research",
  {
    title: "Perplexity Deep Research",
    description:
      "Multi-step deep research using Sonar Deep Research. Performs up to 10 search iterations to build comprehensive research reports. Best for thorough market analysis, technology comparisons, and in-depth investigations. Slower and more expensive than other tools.",
    inputSchema: {
      query: z.string().describe("The research topic or question requiring deep investigation"),
      system_prompt: z.string().optional().describe("Optional system prompt to guide research focus"),
      max_tokens: z.number().min(1).max(16384).optional().describe("Max response tokens (default 4096)"),
    },
  },
  async ({ query, system_prompt, max_tokens }) => {
    const messages: Array<{ role: string; content: string }> = [];
    if (system_prompt) messages.push({ role: "system", content: system_prompt });
    messages.push({ role: "user", content: query });

    const data = await callSonar({
      model: "sonar-deep-research",
      messages,
      max_tokens: max_tokens || 4096,
      temperature: 0.2,
    });
    return { content: [{ type: "text" as const, text: formatSonarResult(data) }] };
  }
);

// ── Tool 5: Raw Web Search (no AI, just results) ───────────────────────────

server.registerTool(
  "web_search",
  {
    title: "Perplexity Web Search",
    description:
      "Raw web search results without AI summarization. Returns ranked URLs, titles, and snippets. Supports batch queries (up to 5). Best for finding specific pages, checking what exists online, or gathering raw URLs for further processing.",
    inputSchema: {
      query: z
        .string()
        .describe("Search query (or multiple queries separated by | for batch, max 5)"),
      max_results: z.number().min(1).max(20).optional().describe("Results per query (default 10)"),
      country: z.string().optional().describe("ISO 3166-1 alpha-2 country code for localized results"),
      domains: z.string().optional().describe("Comma-separated domain filter"),
      language: z.string().optional().describe("ISO 639-1 language codes, comma-separated"),
    },
  },
  async ({ query, max_results, country, domains, language }) => {
    const queries = query.includes("|") ? query.split("|").map((q) => q.trim()).slice(0, 5) : query;

    const body: SearchRequest = {
      query: queries,
      max_results: max_results || 10,
    };
    if (country) body.country = country;
    if (domains) body.search_domain_filter = domains.split(",").map((d) => d.trim());
    if (language) body.search_language_filter = language.split(",").map((l) => l.trim());

    const data = await callSearch(body);

    const lines: string[] = [];
    data.results.forEach((r, i) => {
      lines.push(`[${i + 1}] ${r.title}`);
      lines.push(`    ${r.url}`);
      if (r.snippet) lines.push(`    ${r.snippet.slice(0, 300)}`);
      if (r.date) lines.push(`    Date: ${r.date}`);
      lines.push("");
    });
    return { content: [{ type: "text" as const, text: lines.join("\n") || "No results found" }] };
  }
);

// ── Tool 6: Research Job (specialized for Upwork proposals) ─────────────────

server.registerTool(
  "research_job",
  {
    title: "Research Freelance Job",
    description:
      "Research a freelance job posting to gather current best practices, recommended tools/libraries, implementation approaches, and common pitfalls. Returns structured technical brief ideal for writing winning proposals.",
    inputSchema: {
      title: z.string().describe("Job title"),
      description: z.string().describe("Job description (will be truncated to 800 chars)"),
      budget: z.string().optional().describe("Job budget"),
      skills: z.string().optional().describe("Comma-separated required skills"),
    },
  },
  async ({ title, description, budget, skills }) => {
    const skillsStr = skills ? `\nRequired skills: ${skills}` : "";

    const data = await callSonar({
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

Title: ${title}
Budget: ${budget || "not specified"}
Description: ${description.slice(0, 800)}${skillsStr}

What are the current best practices, recommended tools/libraries, common pitfalls, and optimal implementation approach for this type of project?`,
        },
      ],
      max_tokens: 800,
      temperature: 0.3,
      search_recency_filter: "month",
    });

    const content = data.choices?.[0]?.message?.content || "";
    const citations = data.citations || [];

    // Try to parse JSON and format nicely
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        const parts: string[] = [];
        if (parsed.summary) parts.push(`## Summary\n${parsed.summary}`);
        if (parsed.techInsights?.length)
          parts.push(`\n## Key Technologies\n${parsed.techInsights.map((t: string) => `- ${t}`).join("\n")}`);
        if (parsed.implementation?.length)
          parts.push(`\n## Implementation Approach\n${parsed.implementation.map((s: string, i: number) => `${i + 1}. ${s}`).join("\n")}`);
        if (parsed.pitfalls?.length)
          parts.push(`\n## Pitfalls to Watch\n${parsed.pitfalls.map((p: string) => `- ${p}`).join("\n")}`);
        if (parsed.context) parts.push(`\n## Industry Context\n${parsed.context}`);
        if (citations.length)
          parts.push(`\n## Sources\n${citations.map((c, i) => `[${i + 1}] ${c}`).join("\n")}`);
        return { content: [{ type: "text" as const, text: parts.join("\n") }] };
      } catch {
        // Fall through to raw content
      }
    }

    let result = content;
    if (citations.length) result += `\n\nSources:\n${citations.map((c, i) => `[${i + 1}] ${c}`).join("\n")}`;
    return { content: [{ type: "text" as const, text: result }] };
  }
);

// ── Tool 7: Structured Search (JSON schema output) ─────────────────────────

server.registerTool(
  "structured_search",
  {
    title: "Perplexity Structured Search",
    description:
      "Search with structured JSON output. Define a JSON schema and Perplexity will return data matching that structure. Best for extracting specific data points, comparisons, or building datasets from web search.",
    inputSchema: {
      query: z.string().describe("The search query"),
      schema_name: z.string().describe("Name for the output schema"),
      schema_json: z.string().describe("JSON schema string defining the expected output structure"),
      recency: z.enum(["hour", "day", "week", "month", "year"]).optional(),
      max_tokens: z.number().min(1).max(4096).optional(),
    },
  },
  async ({ query, schema_name, schema_json, recency, max_tokens }) => {
    let schema: Record<string, unknown>;
    try {
      schema = JSON.parse(schema_json);
    } catch {
      return { content: [{ type: "text" as const, text: "ERROR: Invalid JSON schema provided" }] };
    }

    const body: SonarRequest = {
      model: "sonar",
      messages: [{ role: "user", content: query }],
      max_tokens: max_tokens || 1024,
      temperature: 0.1,
      response_format: {
        type: "json_schema",
        json_schema: { name: schema_name, schema, strict: true },
      },
    };
    if (recency) body.search_recency_filter = recency;

    const data = await callSonar(body);
    return { content: [{ type: "text" as const, text: formatSonarResult(data) }] };
  }
);

// ── Tool 8: Academic Search ─────────────────────────────────────────────────

server.registerTool(
  "academic_search",
  {
    title: "Perplexity Academic Search",
    description:
      "Search scholarly and academic sources. Uses Sonar Pro with academic search mode for finding research papers, studies, and peer-reviewed content. Best for technical research, citations, and evidence-based analysis.",
    inputSchema: {
      query: z.string().describe("Academic research question"),
      max_tokens: z.number().min(1).max(4096).optional().describe("Max response tokens (default 2048)"),
      return_related: z.boolean().optional().describe("Return related research questions"),
    },
  },
  async ({ query, max_tokens, return_related }) => {
    const body: SonarRequest = {
      model: "sonar-pro",
      messages: [
        {
          role: "system",
          content: "You are a research assistant. Cite specific papers, authors, and publication years. Focus on peer-reviewed and authoritative sources.",
        },
        { role: "user", content: query },
      ],
      max_tokens: max_tokens || 2048,
      temperature: 0.1,
      search_mode: "academic",
    };
    if (return_related) body.return_related_questions = true;

    const data = await callSonar(body);
    return { content: [{ type: "text" as const, text: formatSonarResult(data) }] };
  }
);

// ── Start Server ────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Perplexity MCP server running on stdio (8 tools available)");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
