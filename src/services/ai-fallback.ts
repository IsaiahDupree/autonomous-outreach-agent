/**
 * src/services/ai-fallback.ts — Unified AI completion with multi-tier fallback.
 *
 * Default order ("auto"):
 *   Tier 1: Claude OAuth (Claude MAX subscription) — lowest marginal cost
 *   Tier 2: Claude API key — separate rate-limit pool, kicks in when OAuth 429s
 *   Tier 3: OpenAI GPT-4o — last resort when both Claude paths fail
 *
 * AI_PRIMARY=openai mode:
 *   Tier 1: OpenAI GPT-4o — first
 *   Tier 2/3: Claude OAuth → Claude API key — only if OpenAI itself fails
 *   Use when Anthropic credit is empty or you want predictably-priced OpenAI runs
 *   without paying the Claude-failure tax on every call.
 *
 * On 429 specifically, we do one short backoff retry against the same client
 * because Anthropic rate-limit windows reset on a 60s cadence and a 5s wait often
 * unblocks transient bursts. Persistent 429s trip a 5min circuit breaker so we
 * stop wasting 12-17s/call on a known-doomed tier.
 */
import Anthropic from "@anthropic-ai/sdk";
import logger from "../config/logger";
import { OPENAI_API_KEY, ANTHROPIC_API_KEY, AI_PRIMARY } from "../secret";
import { getClientAsync } from "../Agent";

const OPENAI_FALLBACK_MODELS: Record<string, string> = {
  "claude-sonnet-4-20250514": "gpt-4o",
  "claude-haiku-4-5-20251001": "gpt-4o-mini",
};

let _claudeFailures = 0;
let _openaiUsed = 0;
let _apiKeyUsed = 0;

// Circuit breakers — once a tier fails in a way that won't auto-recover quickly, skip it for a
// window so we don't burn 12-17s on doomed retries every call. Tripped on 429 (OAuth) and on
// "credit balance too low" (API key). Cleared on the next success or when the window expires.
let _oauthBreakerUntil = 0;
let _apiKeyBreakerUntil = 0;
const OAUTH_BREAKER_MS = 5 * 60 * 1000;    // 5min — Anthropic 429 windows reset on a 60s cadence
const APIKEY_BREAKER_MS = 30 * 60 * 1000;  // 30min — credit-too-low won't recover until a top-up

export function getAIFallbackStats() {
  const now = Date.now();
  return {
    claudeFailures: _claudeFailures,
    openaiUsed: _openaiUsed,
    apiKeyUsed: _apiKeyUsed,
    oauthBreakerSecLeft: Math.max(0, Math.round((_oauthBreakerUntil - now) / 1000)),
    apiKeyBreakerSecLeft: Math.max(0, Math.round((_apiKeyBreakerUntil - now) / 1000)),
  };
}

/** Test/manual reset hook — clears all breaker state. */
export function resetAIFallbackBreakers(): void {
  _oauthBreakerUntil = 0;
  _apiKeyBreakerUntil = 0;
  _claudeFailures = 0;
}

function is429(e: unknown): boolean {
  const err = e as { status?: number; message?: string };
  if (err?.status === 429) return true;
  return typeof err?.message === "string" && err.message.includes("429");
}

function isCreditTooLow(e: unknown): boolean {
  const msg = (e as { message?: string })?.message || "";
  return msg.includes("credit balance is too low") || msg.includes("credit balance too low");
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

/** Single OpenAI invocation — returns text on success, throws on failure. */
async function callOpenAI(opts: AiCompleteOpts): Promise<string> {
  const OpenAI = (await import("openai")).default;
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  const fallbackModel = OPENAI_FALLBACK_MODELS[opts.model] || "gpt-4o-mini";

  const openaiMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  if (opts.system) openaiMessages.push({ role: "system", content: opts.system });
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
  return text;
}

/**
 * Unified AI completion. Order depends on AI_PRIMARY:
 *   - "auto" (default): Claude OAuth → Claude API key → OpenAI
 *   - "openai": OpenAI first, Claude as backup if OpenAI itself fails
 * Same call shape as Claude messages.create() with automatic provider switching.
 */
export async function aiComplete(opts: AiCompleteOpts): Promise<{ text: string; provider: "claude" | "claude-api-key" | "openai" }> {
  // OpenAI-primary mode: try it first, return on success. If OpenAI itself errors,
  // fall through to the Claude tiers below as a last-ditch backup.
  if (AI_PRIMARY === "openai" && OPENAI_API_KEY) {
    try {
      const text = await callOpenAI(opts);
      _openaiUsed++;
      logger.info(`[ai-fallback] OpenAI primary succeeded — total OpenAI calls: ${_openaiUsed}`);
      return { text, provider: "openai" };
    } catch (e) {
      logger.warn(`[ai-fallback] OpenAI primary failed, falling through to Claude: ${(e as Error).message}`);
    }
  }

  const now = Date.now();

  // Tier 1: Claude OAuth — skip if breaker is active
  if (now < _oauthBreakerUntil) {
    const left = Math.round((_oauthBreakerUntil - now) / 1000);
    logger.info(`[ai-fallback] OAuth breaker active (${left}s left) — skipping Tier 1`);
  } else {
    try {
      const client = await getClientAsync();
      const text = await callClaude(client, opts);
      _claudeFailures = 0;
      _oauthBreakerUntil = 0;
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
          _oauthBreakerUntil = 0;
          return { text, provider: "claude" };
        } catch (e2) {
          logger.warn(`[ai-fallback] OAuth retry also failed: ${(e2 as Error).message}`);
          if (is429(e2)) {
            _oauthBreakerUntil = Date.now() + OAUTH_BREAKER_MS;
            logger.warn(`[ai-fallback] OAuth breaker tripped — skipping Tier 1 for next ${OAUTH_BREAKER_MS / 60000}min`);
          }
        }
      }
    }
  }

  // Tier 2: Claude API key — skip if breaker is active or no key configured
  if (!ANTHROPIC_API_KEY) {
    logger.warn("[ai-fallback] No ANTHROPIC_API_KEY set — skipping API-key fallback tier");
  } else if (Date.now() < _apiKeyBreakerUntil) {
    const left = Math.round((_apiKeyBreakerUntil - Date.now()) / 1000);
    logger.info(`[ai-fallback] API-key breaker active (${left}s left) — skipping Tier 2`);
  } else {
    try {
      const apiClient = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
      const text = await callClaude(apiClient, opts);
      _apiKeyUsed++;
      _apiKeyBreakerUntil = 0;
      logger.info(`[ai-fallback] Claude API key path succeeded (${_apiKeyUsed}x total)`);
      return { text, provider: "claude-api-key" };
    } catch (e) {
      logger.warn(`[ai-fallback] Claude API key also failed: ${(e as Error).message}`);
      if (isCreditTooLow(e)) {
        _apiKeyBreakerUntil = Date.now() + APIKEY_BREAKER_MS;
        logger.warn(`[ai-fallback] API-key breaker tripped (credit too low) — skipping Tier 2 for next ${APIKEY_BREAKER_MS / 60000}min`);
      }
    }
  }

  // Tier 3: OpenAI fallback
  if (!OPENAI_API_KEY) {
    logger.error("[ai-fallback] No OPENAI_API_KEY — all tiers exhausted");
    throw new Error("All Claude paths failed and no OpenAI fallback configured");
  }

  try {
    const text = await callOpenAI(opts);
    _openaiUsed++;
    logger.info(`[ai-fallback] OpenAI fallback succeeded — total OpenAI calls: ${_openaiUsed}`);
    return { text, provider: "openai" };
  } catch (e) {
    logger.error(`[ai-fallback] OpenAI fallback also failed: ${(e as Error).message}`);
    throw new Error(`Both Claude and OpenAI failed. Claude: connection error. OpenAI: ${(e as Error).message}`);
  }
}
