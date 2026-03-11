/**
 * src/services/telegram.ts — Approval gate with rich actions
 * Uses HTML parse_mode — more reliable than Markdown with dynamic content.
 * Actions: send, send_with_portfolio, skip (+ view_job as URL button)
 */
import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } from "../secret";
import logger from "../config/logger";

const API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
let lastUpdateId = 0;
const APPROVAL_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4h → auto-skip

export type ApprovalAction = "send" | "send_with_portfolio" | "skip" | "timeout";

/** Escape HTML special chars in dynamic content */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Convert our simple Markdown-ish text to HTML for Telegram */
function toHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*([^*]+)\*/g, "<b>$1</b>")
    .replace(/_([^_]+)_/g, "<i>$1</i>");
}

async function send(body: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(`${API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      logger.warn(`[Telegram] sendMessage failed (${res.status}): ${err.slice(0, 200)}`);
      // Retry without formatting
      if (body.parse_mode) {
        const plain = (body.text as string).replace(/<[^>]+>/g, "");
        const retry = await fetch(`${API}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, text: plain, parse_mode: undefined }),
        });
        return retry.ok;
      }
      return false;
    }
    return true;
  } catch (e) {
    logger.error(`[Telegram] send error: ${(e as Error).message}`);
    return false;
  }
}

export async function notify(text: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  await send({
    chat_id: TELEGRAM_CHAT_ID,
    text: toHtml(text),
    parse_mode: "HTML",
  });
}

/**
 * Send a job for approval with rich action buttons:
 * Row 1: ✅ Send Proposal | 📋 With Portfolio Link
 * Row 2: 🔗 View Job (URL) | ❌ Skip
 */
export async function sendForApproval(item: {
  id: string; type: "proposal" | "dm" | "comment";
  title: string; preview: string; jobUrl?: string; platform?: string;
}): Promise<void> {
  const emoji = { proposal: "📋", dm: "💬", comment: "💭" }[item.type];
  const prefix = item.type === "proposal" ? "upwork" : "chrome";

  const keyboard: Array<Array<Record<string, string>>> = [
    [
      { text: "✅ Send Proposal", callback_data: `${prefix}_send:${item.id}` },
      { text: "📋 With Portfolio", callback_data: `${prefix}_portfolio:${item.id}` },
    ],
    [
      // URL button opens job directly in browser — no callback needed
      ...(item.jobUrl ? [{ text: "🔗 View Job", url: item.jobUrl }] : []),
      { text: "❌ Skip", callback_data: `${prefix}_skip:${item.id}` },
    ],
  ];

  await send({
    chat_id: TELEGRAM_CHAT_ID,
    text: `${emoji} <b>${esc(item.title)}</b>\n\n${toHtml(item.preview.slice(0, 3500))}\n\n<i>Auto-skips in 4h</i>`,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: keyboard },
  });
}

/**
 * Wait for user action on Telegram.
 * Returns the action taken: send, send_with_portfolio, skip, or timeout.
 */
export async function waitForApproval(id: string, prefix: string): Promise<{ action: ApprovalAction }> {
  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(5000);
    try {
      const res = await fetch(`${API}/getUpdates?offset=${lastUpdateId + 1}&timeout=4&allowed_updates=callback_query`);
      const data = await res.json() as { result: Array<{ update_id: number; callback_query?: { id: string; data: string } }> };

      for (const update of data?.result || []) {
        lastUpdateId = Math.max(lastUpdateId, update.update_id);
        const cb = update.callback_query;
        if (!cb) continue;

        // Acknowledge the button press
        await fetch(`${API}/answerCallbackQuery`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callback_query_id: cb.id }),
        });

        // Match actions for this job
        if (cb.data === `${prefix}_send:${id}`) return { action: "send" };
        if (cb.data === `${prefix}_portfolio:${id}`) return { action: "send_with_portfolio" };
        if (cb.data === `${prefix}_skip:${id}`) return { action: "skip" };

        // Legacy support for old approve button format
        if (cb.data === `${prefix}_approve:${id}`) return { action: "send" };
      }
    } catch { /* keep polling */ }
  }

  await notify(`⏰ Auto-skipped after 4h timeout | ID: ${id}`);
  return { action: "timeout" };
}

export async function shutdown(server: import("http").Server): Promise<void> {
  logger.info("[telegram] Shutting down notification service");
  server.close();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
