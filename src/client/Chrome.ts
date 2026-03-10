/**
 * src/client/Chrome.ts — Chrome CDP platform client (mirrors Riona's Twitter.ts)
 * Handles LinkedIn prospecting via Chrome DevTools Protocol
 */
import logger from "../config/logger";
import { CHROME_CDP_PORT, SAFARI_LINKEDIN_PORT } from "../secret";
import * as cloud from "../services/cloud";
import * as obsidian from "../services/obsidian";
import * as tg from "../services/telegram";
import { scoreProspectWithAI, generateDMOpening } from "../Agent";

const LINKEDIN_CHROME_BASE = `http://localhost:${SAFARI_LINKEDIN_PORT}`;

export interface Prospect {
  id?: string;
  username: string;
  displayName?: string;
  bio?: string;
  headline?: string;
  followers?: number;
  url?: string;
  platform: string;
  icpScore?: number;
}

export async function checkCDP(): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${CHROME_CDP_PORT}/json`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch { return false; }
}

export async function scrapeLinkedIn(query: string, limit = 20): Promise<Prospect[]> {
  try {
    const res = await fetch(`${LINKEDIN_CHROME_BASE}/api/scrape/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`Scrape failed: ${res.status}`);
    const raw = await res.json() as Prospect[];
    return raw.map((p) => ({ ...p, platform: "linkedin" }));
  } catch (e) {
    logger.error(`[Chrome] scrapeLinkedIn error: ${(e as Error).message}`);
    return [];
  }
}

export async function sendLinkedInDM(username: string, message: string): Promise<boolean> {
  try {
    const res = await fetch(`${LINKEDIN_CHROME_BASE}/api/dm/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, message }),
      signal: AbortSignal.timeout(30000),
    });
    return res.ok;
  } catch (e) {
    logger.error(`[Chrome] sendDM error: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Full cycle: scrape → AI score → save prospects → queue DMs → Telegram approval → send
 */
export async function runDiscoveryCycle(keywords: string[], icpThreshold = 6): Promise<void> {
  logger.info("[Chrome] Starting discovery cycle");

  const cdpUp = await checkCDP();
  if (!cdpUp) {
    logger.warn("[Chrome] CDP not reachable — skipping");
    await tg.notify(`⚠️ *Chrome discovery skipped* — CDP port ${CHROME_CDP_PORT} unreachable`);
    return;
  }

  for (const kw of keywords) {
    const prospects = await scrapeLinkedIn(kw, 15);

    for (const p of prospects) {
      p.icpScore = await scoreProspectWithAI(p);
      if ((p.icpScore || 0) < icpThreshold) continue;

      await cloud.saveProspect(p);
      obsidian.logProspect(p, "discovered");

      // Queue DM for approval
      const opening = await generateDMOpening({
        displayName: p.displayName || p.username,
        bio: p.bio,
        platform: "linkedin",
      });

      p.id = `${Date.now()}-${p.username}`;

      await tg.sendForApproval({
        id: p.id, type: "dm",
        title: `LinkedIn DM: ${p.displayName || p.username} (ICP ${p.icpScore}/10)`,
        preview: opening,
        platform: "linkedin",
      });

      const { approved } = await tg.waitForApproval(p.id, "chrome");

      if (approved) {
        const ok = await sendLinkedInDM(p.username, opening);
        obsidian.logProspect(p, ok ? "dm_sent" : "dm_failed");
        await tg.notify(ok ? `🚀 LinkedIn DM sent to @${p.username}` : `❌ DM failed: @${p.username}`);
        await cloud.logAction("chrome", "dm_send", ok ? "ok" : "error", { username: p.username });
      } else {
        obsidian.logProspect(p, "skipped");
      }
    }
  }

  logger.info("[Chrome] Discovery cycle complete");
}
