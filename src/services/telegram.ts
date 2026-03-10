/**
 * src/services/telegram.ts — Approval gate (mirrors Riona pattern, extended)
 */
import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } from "../secret";
import logger from "../config/logger";

const API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
let lastUpdateId = 0;
const APPROVAL_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4h → auto-skip

export async function notify(text: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  await fetch(`${API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" }),
  }).catch(() => {});
}

export async function sendForApproval(item: {
  id: string; type: "proposal" | "dm" | "comment";
  title: string; preview: string; platform?: string;
}): Promise<void> {
  const emoji = { proposal: "📋", dm: "💬", comment: "💭" }[item.type];
  const prefix = item.type === "proposal" ? "upwork" : "chrome";

  await fetch(`${API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: `${emoji} *${item.title}*\n\n${item.preview.slice(0, 400)}\n\n_Auto-skips in 4h_`,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Approve", callback_data: `${prefix}_approve:${item.id}` },
          { text: "❌ Skip", callback_data: `${prefix}_skip:${item.id}` },
        ]],
      },
    }),
  });
}

export async function waitForApproval(id: string, prefix: string): Promise<{ approved: boolean }> {
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
        await fetch(`${API}/answerCallbackQuery`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callback_query_id: cb.id }),
        });
        if (cb.data === `${prefix}_approve:${id}`) return { approved: true };
        if (cb.data === `${prefix}_skip:${id}`) return { approved: false };
      }
    } catch { /* keep polling */ }
  }

  await notify(`⏰ Auto-skipped after 4h timeout | ID: ${id}`);
  return { approved: false };
}

export async function shutdown(server: import("http").Server): Promise<void> {
  logger.info("[telegram] Shutting down notification service");
  server.close();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
