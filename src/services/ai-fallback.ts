/**
 * src/services/ai-fallback.ts — Unified AI completion with Claude → OpenAI fallback
 *
 * Primary: Claude (Anthropic) via OAuth/API key
 * Fallback: OpenAI GPT-4o when Claude is unavailable
 *
 * All AI calls in the codebase should use this instead of calling Claude directly,
 * so the entire pipeline stays alive if Claude goes down.
 */
import logger from "../config/logger";
import { OPENAI_API_KEY } from "../secret";
import { getClientAsync } from "../Agent";

// Model mapping: Claude model → OpenAI equivalent
const OPENAI_FALLBACK_MODELS: Record<string, string> = {
  "claude-sonnet-4-20250514": "gpt-4o",
  "claude-haiku-4-5-20251001": "gpt-4o-mini",
};

// Track consecutive failures for logging
let _claudeFailures = 0;
let _openaiUsed = 0;

export function getAIFallbackStats() {
  return { claudeFailures: _claudeFailures, openaiUsed: _openaiUsed };
}

/**
 * Unified AI completion — tries Claude first, falls back to OpenAI.
 * Same interface as Claude messages.create() but with automatic fallback.
 */
export async function aiComplete(opts: {
  model: string;
  max_tokens: number;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  system?: string;
}): Promise<{ text: string; provider: "claude" | "openai" }> {
  // Try Claude first
  try {
    const client = await getClientAsync();
    const msg = await client.messages.create({
      model: opts.model,
      max_tokens: opts.max_tokens,
      messages: opts.messages,
      ...(opts.system ? { system: opts.system } : {}),
    });

    const block = msg.content?.[0];
    if (!block || !("text" in block)) throw new Error("Empty Claude response");

    _claudeFailures = 0; // reset on success
    return { text: block.text, provider: "claude" };
  } catch (e) {
    _claudeFailures++;
    const err = e as Error;
    logger.warn(`[ai-fallback] Claude failed (${_claudeFailures}x): ${err.message}`);

    // If no OpenAI key, rethrow — can't fallback
    if (!OPENAI_API_KEY) {
      logger.error("[ai-fallback] No OPENAI_API_KEY — cannot fall back to OpenAI");
      throw e;
    }
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
