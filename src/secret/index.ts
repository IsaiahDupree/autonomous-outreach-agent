/**
 * src/secret/index.ts — typed secrets (mirrors Riona pattern)
 * All values fall back to empty string — never throw at startup
 */
import dotenv from "dotenv";
dotenv.config();

export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
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

// Browser mode: "safari" = external service only, "puppeteer" = built-in only, "auto" = try safari, fall back to puppeteer
export const BROWSER_MODE = (process.env.BROWSER_MODE || "auto") as "safari" | "puppeteer" | "auto";
export const BROWSER_HEADLESS = process.env.BROWSER_HEADLESS !== "false";

// Auto-send: skip Telegram approval and submit proposals automatically
// AUTO_SEND=true enables, AUTO_SEND_MIN_SCORE sets minimum score (default 7)
export const AUTO_SEND = process.env.AUTO_SEND === "true";
export const AUTO_SEND_MIN_SCORE = parseInt(process.env.AUTO_SEND_MIN_SCORE || "7");
