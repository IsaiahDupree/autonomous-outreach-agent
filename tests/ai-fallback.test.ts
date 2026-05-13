/**
 * tests/ai-fallback.test.ts — AI fallback layer tests
 *
 * Tests that:
 * - Claude is used as primary provider
 * - OpenAI kicks in when Claude fails
 * - Both failing throws a clear error
 * - Stats tracking works
 * - Model mapping is correct (Sonnet → GPT-4o, Haiku → GPT-4o-mini)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Must use vi.hoisted for variables referenced in vi.mock factories
const { mockClaudeCreate, mockOpenAICreate } = vi.hoisted(() => ({
  mockClaudeCreate: vi.fn(),
  mockOpenAICreate: vi.fn(),
}));

vi.mock("../src/Agent", () => ({
  getClientAsync: vi.fn().mockResolvedValue({
    messages: { create: mockClaudeCreate },
  }),
}));

vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      chat = { completions: { create: mockOpenAICreate } };
    },
  };
});

vi.mock("../src/secret", () => ({
  OPENAI_API_KEY: "test-openai-key",
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_AUTH_TOKEN: "",
  AI_PRIMARY: "auto",
}));

vi.mock("../src/config/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { aiComplete, getAIFallbackStats, resetAIFallbackBreakers } from "../src/services/ai-fallback";

beforeEach(() => {
  vi.clearAllMocks();
  resetAIFallbackBreakers();
});

describe("AI Fallback Layer", () => {

  // ── Claude primary ──

  describe("Claude as primary", () => {
    it("should use Claude when it succeeds", async () => {
      mockClaudeCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "Hello from Claude" }],
      });

      const result = await aiComplete({
        model: "claude-sonnet-4-20250514",
        max_tokens: 100,
        messages: [{ role: "user", content: "test" }],
      });

      expect(result.text).toBe("Hello from Claude");
      expect(result.provider).toBe("claude");
      expect(mockOpenAICreate).not.toHaveBeenCalled();
    });

    it("should pass model and max_tokens to Claude", async () => {
      mockClaudeCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
      });

      await aiComplete({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        messages: [{ role: "user", content: "test" }],
      });

      expect(mockClaudeCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 200,
        }),
      );
    });

    it("should pass system prompt to Claude when provided", async () => {
      mockClaudeCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
      });

      await aiComplete({
        model: "claude-sonnet-4-20250514",
        max_tokens: 100,
        messages: [{ role: "user", content: "test" }],
        system: "You are a helpful assistant",
      });

      expect(mockClaudeCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          system: "You are a helpful assistant",
        }),
      );
    });
  });

  // ── OpenAI fallback ──

  describe("OpenAI fallback", () => {
    it("should fall back to OpenAI when Claude fails", async () => {
      mockClaudeCreate.mockRejectedValueOnce(new Error("Claude API rate limit"));
      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{ message: { content: "Hello from OpenAI" } }],
      });

      const result = await aiComplete({
        model: "claude-sonnet-4-20250514",
        max_tokens: 100,
        messages: [{ role: "user", content: "test" }],
      });

      expect(result.text).toBe("Hello from OpenAI");
      expect(result.provider).toBe("openai");
    });

    it("should fall back when Claude returns empty content", async () => {
      mockClaudeCreate.mockResolvedValueOnce({ content: [] });
      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{ message: { content: "OpenAI saved the day" } }],
      });

      const result = await aiComplete({
        model: "claude-sonnet-4-20250514",
        max_tokens: 100,
        messages: [{ role: "user", content: "test" }],
      });

      expect(result.text).toBe("OpenAI saved the day");
      expect(result.provider).toBe("openai");
    });

    it("should map claude-sonnet to gpt-4o", async () => {
      mockClaudeCreate.mockRejectedValueOnce(new Error("down"));
      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{ message: { content: "ok" } }],
      });

      await aiComplete({
        model: "claude-sonnet-4-20250514",
        max_tokens: 100,
        messages: [{ role: "user", content: "test" }],
      });

      expect(mockOpenAICreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: "gpt-4o" }),
      );
    });

    it("should map claude-haiku to gpt-4o-mini", async () => {
      mockClaudeCreate.mockRejectedValueOnce(new Error("down"));
      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{ message: { content: "ok" } }],
      });

      await aiComplete({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 100,
        messages: [{ role: "user", content: "test" }],
      });

      expect(mockOpenAICreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: "gpt-4o-mini" }),
      );
    });

    it("should convert system prompt to OpenAI format", async () => {
      mockClaudeCreate.mockRejectedValueOnce(new Error("down"));
      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{ message: { content: "ok" } }],
      });

      await aiComplete({
        model: "claude-sonnet-4-20250514",
        max_tokens: 100,
        messages: [{ role: "user", content: "hello" }],
        system: "You are a scorer",
      });

      expect(mockOpenAICreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: "system", content: "You are a scorer" },
            { role: "user", content: "hello" },
          ],
        }),
      );
    });

    it("should pass max_tokens to OpenAI", async () => {
      mockClaudeCreate.mockRejectedValueOnce(new Error("down"));
      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{ message: { content: "ok" } }],
      });

      await aiComplete({
        model: "claude-sonnet-4-20250514",
        max_tokens: 800,
        messages: [{ role: "user", content: "test" }],
      });

      expect(mockOpenAICreate).toHaveBeenCalledWith(
        expect.objectContaining({ max_tokens: 800 }),
      );
    });
  });

  // ── Both failing ──

  describe("both providers failing", () => {
    it("should throw when both Claude and OpenAI fail", async () => {
      mockClaudeCreate.mockRejectedValueOnce(new Error("Claude down"));
      mockOpenAICreate.mockRejectedValueOnce(new Error("OpenAI down"));

      await expect(
        aiComplete({
          model: "claude-sonnet-4-20250514",
          max_tokens: 100,
          messages: [{ role: "user", content: "test" }],
        }),
      ).rejects.toThrow("Both Claude and OpenAI failed");
    });

    it("should include both error messages", async () => {
      mockClaudeCreate.mockRejectedValueOnce(new Error("rate limited"));
      mockOpenAICreate.mockRejectedValueOnce(new Error("quota exceeded"));

      try {
        await aiComplete({
          model: "claude-sonnet-4-20250514",
          max_tokens: 100,
          messages: [{ role: "user", content: "test" }],
        });
      } catch (e) {
        expect((e as Error).message).toContain("quota exceeded");
      }
    });

    it("should throw when OpenAI returns empty response", async () => {
      mockClaudeCreate.mockRejectedValueOnce(new Error("down"));
      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{ message: { content: null } }],
      });

      await expect(
        aiComplete({
          model: "claude-sonnet-4-20250514",
          max_tokens: 100,
          messages: [{ role: "user", content: "test" }],
        }),
      ).rejects.toThrow();
    });
  });

  // ── Stats tracking ──

  describe("stats tracking", () => {
    it("should track fallback stats", async () => {
      const stats = getAIFallbackStats();
      expect(stats).toHaveProperty("claudeFailures");
      expect(stats).toHaveProperty("openaiUsed");
      expect(typeof stats.claudeFailures).toBe("number");
      expect(typeof stats.openaiUsed).toBe("number");
    });
  });

  // ── Resilience patterns ──

  describe("resilience", () => {
    it("should handle multiple sequential fallbacks", async () => {
      // Call 1: Claude fails, OpenAI works
      mockClaudeCreate.mockRejectedValueOnce(new Error("fail 1"));
      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{ message: { content: "openai 1" } }],
      });

      const r1 = await aiComplete({
        model: "claude-sonnet-4-20250514",
        max_tokens: 100,
        messages: [{ role: "user", content: "test 1" }],
      });
      expect(r1.provider).toBe("openai");

      // Call 2: Claude works again
      mockClaudeCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "claude back" }],
      });

      const r2 = await aiComplete({
        model: "claude-sonnet-4-20250514",
        max_tokens: 100,
        messages: [{ role: "user", content: "test 2" }],
      });
      expect(r2.provider).toBe("claude");
    });

    it("should handle Claude returning null content block", async () => {
      mockClaudeCreate.mockResolvedValueOnce({
        content: [{ type: "text" }], // missing text field
      });
      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{ message: { content: "fallback" } }],
      });

      const result = await aiComplete({
        model: "claude-sonnet-4-20250514",
        max_tokens: 100,
        messages: [{ role: "user", content: "test" }],
      });
      expect(result.provider).toBe("openai");
    });
  });

  // ── Circuit breaker ──

  describe("circuit breaker", () => {
    function err429() {
      return Object.assign(new Error("429 rate_limit_error"), { status: 429 });
    }

    it("trips OAuth breaker after 429 + 429 retry, skips Tier 1 on next call", async () => {
      // Call 1: OAuth 429 → retry 429 → OpenAI succeeds → breaker should trip
      mockClaudeCreate.mockRejectedValueOnce(err429()).mockRejectedValueOnce(err429());
      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{ message: { content: "openai-1" } }],
      });

      const r1 = await aiComplete({
        model: "claude-sonnet-4-20250514",
        max_tokens: 100,
        messages: [{ role: "user", content: "test" }],
      });
      expect(r1.provider).toBe("openai");
      expect(mockClaudeCreate).toHaveBeenCalledTimes(2); // initial + 5s retry
      expect(getAIFallbackStats().oauthBreakerSecLeft).toBeGreaterThan(0);

      // Call 2: breaker active → OAuth NOT called → OpenAI succeeds
      mockClaudeCreate.mockClear();
      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{ message: { content: "openai-2" } }],
      });

      const r2 = await aiComplete({
        model: "claude-sonnet-4-20250514",
        max_tokens: 100,
        messages: [{ role: "user", content: "test" }],
      });
      expect(r2.provider).toBe("openai");
      expect(mockClaudeCreate).not.toHaveBeenCalled();
    });

    it("does NOT trip OAuth breaker on a single 429 that recovers via 5s retry", async () => {
      mockClaudeCreate
        .mockRejectedValueOnce(err429())
        .mockResolvedValueOnce({ content: [{ type: "text", text: "claude-recovered" }] });

      const r = await aiComplete({
        model: "claude-sonnet-4-20250514",
        max_tokens: 100,
        messages: [{ role: "user", content: "test" }],
      });
      expect(r.provider).toBe("claude");
      expect(getAIFallbackStats().oauthBreakerSecLeft).toBe(0);
    }, 10_000);

    it("does NOT trip OAuth breaker on non-429 errors", async () => {
      mockClaudeCreate.mockRejectedValueOnce(new Error("network down"));
      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{ message: { content: "openai" } }],
      });

      await aiComplete({
        model: "claude-sonnet-4-20250514",
        max_tokens: 100,
        messages: [{ role: "user", content: "test" }],
      });
      expect(getAIFallbackStats().oauthBreakerSecLeft).toBe(0);
    });

    it("clears OAuth breaker on a successful call after window expiry (manual reset)", async () => {
      // Trip the breaker
      mockClaudeCreate.mockRejectedValueOnce(err429()).mockRejectedValueOnce(err429());
      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{ message: { content: "openai" } }],
      });
      await aiComplete({
        model: "claude-sonnet-4-20250514",
        max_tokens: 100,
        messages: [{ role: "user", content: "test" }],
      });
      expect(getAIFallbackStats().oauthBreakerSecLeft).toBeGreaterThan(0);

      // Manually clear (simulates window expiry) and verify next call hits OAuth
      resetAIFallbackBreakers();
      mockClaudeCreate.mockClear();
      mockClaudeCreate.mockResolvedValueOnce({ content: [{ type: "text", text: "claude-back" }] });

      const r = await aiComplete({
        model: "claude-sonnet-4-20250514",
        max_tokens: 100,
        messages: [{ role: "user", content: "test" }],
      });
      expect(r.provider).toBe("claude");
      expect(mockClaudeCreate).toHaveBeenCalledTimes(1);
    });
  });
});
