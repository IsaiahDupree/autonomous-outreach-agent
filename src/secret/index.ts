/**
 * src/secret/index.ts — typed secrets (mirrors Riona pattern)
 * All values fall back to empty string — never throw at startup
 */
import dotenv from "dotenv";
dotenv.config();

export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
export const ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN || "";
export const SUPABASE_URL = process.env.SUPABASE_URL || "https://ivhfuhxorppptyuofbgq.supabase.co";
export const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || "";
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
export const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
export const CRMLITE_URL = process.env.CRMLITE_URL || "";
export const CRMLITE_API_KEY = process.env.CRMLITE_API_KEY || "";
export const OBSIDIAN_VAULT = process.env.OBSIDIAN_VAULT_PATH || process.env.MEMORY_VAULT_PATH || "";
export const LINKEDIN_EMAIL = process.env.LINKEDIN_EMAIL || "";
export const LINKEDIN_PASSWORD = process.env.LINKEDIN_PASSWORD || "";

// Safari service — use SAFARI_SERVICE_URL (port 7070) or legacy individual ports
const safariBase = process.env.SAFARI_SERVICE_URL || "";
export const SAFARI_UPWORK_PORT = parseInt(process.env.SAFARI_UPWORK_PORT || "7070");
export const SAFARI_LINKEDIN_PORT = parseInt(process.env.SAFARI_LINKEDIN_PORT || "7070");
export const SAFARI_SERVICE_URL = safariBase || `http://localhost:${SAFARI_UPWORK_PORT}`;
export const CHROME_CDP_PORT = parseInt(process.env.CHROME_CDP_PORT || "9222");
export const PORT = parseInt(process.env.PORT || "3500");

// Public base URL for short-link redirects (/r/:slug). Falls back to local Express.
export const TRACKING_BASE_URL = process.env.TRACKING_BASE_URL || `http://localhost:${PORT}`;

// Browser mode: "safari" = external service only, "puppeteer" = built-in only, "auto" = try safari, fall back to puppeteer
export const BROWSER_MODE = (process.env.BROWSER_MODE || "auto") as "safari" | "puppeteer" | "auto";
export const BROWSER_HEADLESS = process.env.BROWSER_HEADLESS !== "false";

// Auto-send: skip Telegram approval and submit proposals automatically
// AUTO_SEND=true enables, AUTO_SEND_MIN_SCORE sets minimum score (default 7)
export const AUTO_SEND = process.env.AUTO_SEND === "true";
export const AUTO_SEND_MIN_SCORE = parseInt(process.env.AUTO_SEND_MIN_SCORE || "7");
// Hard-stop threshold for auto-submissions: refuse to submit when remaining connects fall below this.
export const AUTO_SEND_MIN_CONNECTS = parseInt(process.env.AUTO_SEND_MIN_CONNECTS || "16");

// Fast-poll: be the first to apply by polling Upwork's "Most Recent" feed every N seconds and
// dispatching the full pipeline immediately when a fresh job hits the score threshold.
// Disabled by default (set FAST_POLL=true to enable). Pair with reasonable interval so we don't
// hammer Upwork — 60s is a safe baseline.
export const FAST_POLL = process.env.FAST_POLL === "true";
export const FAST_POLL_INTERVAL_SEC = parseInt(process.env.FAST_POLL_INTERVAL_SEC || "60");
export const FAST_POLL_KEYWORDS = (process.env.FAST_POLL_KEYWORDS || "AI automation,n8n automation,Claude API")
  .split(",").map(s => s.trim()).filter(Boolean);
export const FAST_POLL_TOP_N = parseInt(process.env.FAST_POLL_TOP_N || "3");
export const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY || "";
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

/**
 * Required env vars for production runs. Missing values cause a fail-fast at boot
 * via assertRequiredEnv() rather than silently producing empty proposals or NPEs
 * deep in the pipeline. Skipped when NODE_ENV !== "production" so dev/test/CI
 * workflows that intentionally omit secrets keep working.
 */
function readRequiredEnv(): Array<[string, string]> {
  const env = process.env;
  return [
    ["ANTHROPIC_API_KEY", env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || ""],
    ["SUPABASE_URL", env.SUPABASE_URL || ""],
    ["SUPABASE_KEY", env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || ""],
    ["TELEGRAM_BOT_TOKEN", env.TELEGRAM_BOT_TOKEN || ""],
    ["TELEGRAM_CHAT_ID", env.TELEGRAM_CHAT_ID || ""],
  ];
}

export function assertRequiredEnv(opts: { force?: boolean } = {}): void {
  const isProd = process.env.NODE_ENV === "production";
  if (!isProd && !opts.force) return;
  const missing = readRequiredEnv().filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(
      `[secret] Missing required env vars in production: ${missing.join(", ")}. ` +
        `Set them in .env or the process environment before starting.`,
    );
  }
}
