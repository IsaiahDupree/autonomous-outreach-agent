/**
 * src/services/ai-fallback.ts — Unified AI completion with multi-tier fallback.
 *
 * Tier 1: Claude OAuth (Claude MAX subscription) — primary, lowest cost
 * Tier 2: Claude API key — different rate-limit pool, used when OAuth 429s
 * Tier 3: OpenAI GPT-4o — last resort when both Claude paths fail
 *
 * On 429 specifically, we also do one short backoff retry against the same client
 * because Anthropic rate-limit windows reset on a 60s cadence and a 5s wait often
 * unblocks transient bursts.
 */
import Anthropic from "@anthropic-ai/sdk";
import logger from "../config/logger";
import { OPENAI_API_KEY, ANTHROPIC_API_KEY } from "../secret";
import { getClientAsync } from "../Agent";

const OPENAI_FALLBACK_MODELS: Record<string, string> = {
  "claude-sonnet-4-20250514": "gpt-4o",
  "claude-haiku-4-5-20251001": "gpt-4o-mini",
};

let _claudeFailures = 0;
let _openaiUsed = 0;
let _apiKeyUsed = 0;

export function getAIFallbackStats() {
  return { claudeFailures: _claudeFailures, openaiUsed: _openaiUsed, apiKeyUsed: _apiKeyUsed };
}

function is429(e: unknown): boolean {
  const err = e as { status?: number; message?: string };
  if (err?.status === 429) return true;
  return typeof err?.message === "string" && err.message.includes("429");
}

async function callClaude(client: Anthropic, opts: AiCompleteOpts): Promise<string> {
  const msg = await client.messages.create({
    model: opts.model,
    max_tokens: opts.max_tokens,
    messages: opts.messages,
    ...(opts.system ? { system: opts.system } : {}),
  });
  const block = msg.content?.[0];
  if (!block || !("text" in block)) throw new Error("Empty Claude response");
  return block.text;
}

interface AiCompleteOpts {
  model: string;
  max_tokens: number;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  system?: string;
}

/**
 * Unified AI completion — tries OAuth → API key → OpenAI in order.
 * Same interface as Claude messages.create() but with automatic fallback.
 */
export async function aiComplete(opts: AiCompleteOpts): Promise<{ text: string; provider: "claude" | "claude-api-key" | "openai" }> {
  // Tier 1: Claude OAuth
  try {
    const client = await getClientAsync();
    const text = await callClaude(client, opts);
    _claudeFailures = 0;
    return { text, provider: "claude" };
  } catch (e) {
    _claudeFailures++;
    const err = e as Error;
    logger.warn(`[ai-fallback] Claude OAuth failed (${_claudeFailures}x): ${err.message}`);

    // If it's a 429, give the rate-limit window a short retry against OAuth before
    // burning a tier — the per-minute reset often makes this work.
    if (is429(e)) {
      try {
        await new Promise(r => setTimeout(r, 5000));
        const client = await getClientAsync();
        const text = await callClaude(client, opts);
        logger.info("[ai-fallback] Claude OAuth recovered after 5s backoff");
        return { text, provider: "claude" };
      } catch (e2) {
        logger.warn(`[ai-fallback] OAuth retry also failed: ${(e2 as Error).message}`);
      }
    }
  }

  // Tier 2: Claude API key (separate rate-limit pool from OAuth)
  if (ANTHROPIC_API_KEY) {
    try {
      const apiClient = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
      const text = await callClaude(apiClient, opts);
      _apiKeyUsed++;
      logger.info(`[ai-fallback] Claude API key path succeeded (${_apiKeyUsed}x total)`);
      return { text, provider: "claude-api-key" };
    } catch (e) {
      logger.warn(`[ai-fallback] Claude API key also failed: ${(e as Error).message}`);
    }
  } else {
    logger.warn("[ai-fallback] No ANTHROPIC_API_KEY set — skipping API-key fallback tier");
  }

  // Tier 3: OpenAI
  if (!OPENAI_API_KEY) {
    logger.error("[ai-fallback] No OPENAI_API_KEY — all tiers exhausted");
    throw new Error("All Claude paths failed and no OpenAI fallback configured");
  }

  // Fallback to OpenAI
  try {
    const OpenAI = (await import("openai")).default;
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

    const fallbackModel = OPENAI_FALLBACK_MODELS[opts.model] || "gpt-4o-mini";

    // Convert Claude message format to OpenAI format
    const openaiMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
    if (opts.system) {
      openaiMessages.push({ role: "system", content: opts.system });
    }
    for (const msg of opts.messages) {
      openaiMessages.push({ role: msg.role, content: msg.content });
    }

    const completion = await openai.chat.completions.create({
      model: fallbackModel,
      max_tokens: opts.max_tokens,
      messages: openaiMessages,
    });

    const text = completion.choices?.[0]?.message?.content;
    if (!text) throw new Error("Empty OpenAI response");

    _openaiUsed++;
    logger.info(`[ai-fallback] OpenAI fallback succeeded (${fallbackModel}) — total OpenAI calls: ${_openaiUsed}`);
    return { text, provider: "openai" };
  } catch (e) {
    logger.error(`[ai-fallback] OpenAI fallback also failed: ${(e as Error).message}`);
    throw new Error(`Both Claude and OpenAI failed. Claude: connection error. OpenAI: ${(e as Error).message}`);
  }
}
