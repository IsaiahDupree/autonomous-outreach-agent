/**
 * src/client/Chrome.ts — LinkedIn/Chrome discovery client
 * Dual-mode: tries Safari/CDP service first, falls back to Puppeteer (Riona-style).
 */
import logger from "../config/logger";
import { CHROME_CDP_PORT, SAFARI_LINKEDIN_PORT, BROWSER_MODE } from "../secret";
import * as cloud from "../services/cloud";
import * as obsidian from "../services/obsidian";
import * as tg from "../services/telegram";
import { scoreProspectWithAI, generateDMOpening } from "../Agent";
import * as linkedinBrowser from "../browser/linkedin";

const LINKEDIN_SAFARI_BASE = `http://localhost:${SAFARI_LINKEDIN_PORT}`;

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

let safariUp: boolean | null = null;
let cdpUp: boolean | null = null;

async function checkSafari(): Promise<boolean> {
  if (BROWSER_MODE === "puppeteer") return false;
  if (safariUp !== null) return safariUp;
  safariUp = await cloud.checkService(SAFARI_LINKEDIN_PORT);
  return safariUp;
}

export async function checkCDP(): Promise<boolean> {
  if (BROWSER_MODE === "puppeteer") return false;
  if (cdpUp !== null) return cdpUp;
  try {
    const res = await fetch(`http://localhost:${CHROME_CDP_PORT}/json`, { signal: AbortSignal.timeout(2000) });
    cdpUp = res.ok;
  } catch {
    cdpUp = false;
  }
  return cdpUp;
}

/** Check if any backend is available (Safari, CDP, or Puppeteer) */
async function hasBackend(): Promise<"safari" | "cdp" | "puppeteer" | null> {
  if (BROWSER_MODE !== "puppeteer") {
    if (await checkSafari()) return "safari";
    if (await checkCDP()) return "cdp";
  }
  if (BROWSER_MODE === "safari") return null;
  return "puppeteer";
}

async function scrapeViaSafari(query: string, limit: number): Promise<Prospect[]> {
  const res = await fetch(`${LINKEDIN_SAFARI_BASE}/api/scrape/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Scrape failed: ${res.status}`);
  const raw = await res.json() as Prospect[];
  return raw.map((p) => ({ ...p, platform: "linkedin" }));
}

async function dmViaSafari(username: string, message: string): Promise<boolean> {
  const res = await fetch(`${LINKEDIN_SAFARI_BASE}/api/dm/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, message }),
    signal: AbortSignal.timeout(30000),
  });
  return res.ok;
}

export async function scrapeLinkedIn(query: string, limit = 15): Promise<Prospect[]> {
  try {
    const backend = await hasBackend();
    if (!backend) {
      logger.warn("[Chrome] No backend available for LinkedIn scraping");
      return [];
    }

    if (backend === "safari" || backend === "cdp") {
      return await scrapeViaSafari(query, limit);
    }

    // Puppeteer fallback
    logger.info("[Chrome] Using Puppeteer browser for LinkedIn");
    const profiles = await linkedinBrowser.searchProfiles(query, limit);
    return profiles.map((p) => ({ ...p, platform: "linkedin" } as Prospect));
  } catch (e) {
    logger.error(`[Chrome] scrapeLinkedIn error: ${(e as Error).message}`);
    // If Safari failed, try Puppeteer
    if (BROWSER_MODE === "auto") {
      safariUp = false;
      cdpUp = false;
      logger.info("[Chrome] External service failed, retrying with Puppeteer");
      const profiles = await linkedinBrowser.searchProfiles(query, limit);
      return profiles.map((p) => ({ ...p, platform: "linkedin" } as Prospect));
    }
    return [];
  }
}

export async function sendLinkedInDM(username: string, message: string, profileUrl?: string): Promise<boolean> {
  try {
    const backend = await hasBackend();
    if (!backend) return false;

    if (backend === "safari" || backend === "cdp") {
      return await dmViaSafari(username, message);
    }

    // Puppeteer fallback — needs profile URL
    const url = profileUrl || `https://www.linkedin.com/in/${username}/`;
    return await linkedinBrowser.sendDM(url, message);
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

  const backend = await hasBackend();
  if (!backend) {
    logger.warn("[Chrome] No backend available — skipping discovery");
    await tg.notify(`⚠️ *Chrome discovery skipped* — no browser backend available`);
    return;
  }
  logger.info(`[Chrome] Using backend: ${backend}`);

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

      const { action } = await tg.waitForApproval(p.id, "chrome");

      if (action === "send" || action === "send_with_portfolio") {
        const ok = await sendLinkedInDM(p.username, opening, p.url);
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
