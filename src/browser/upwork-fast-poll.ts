/**
 * src/browser/upwork-fast-poll.ts — fast scrape of "Most Recent" job tiles for the fast-poll loop.
 *
 * Uses the engine's existing CDP-attached Chrome. Goes to Upwork's recency-sorted search and
 * extracts top-N tile metadata in a single page.evaluate. No interaction beyond page.goto.
 *
 * Owns its OWN dedicated tab (cached across calls) so other flows — submitProposal,
 * scrapeBestMatches, the user manually browsing — can't yank the page out from under us
 * mid-evaluate. That race was producing "Execution context was destroyed" warnings every cycle.
 */
import type { Page } from "puppeteer";
import logger from "../config/logger";
import { launch } from "./engine";
import type { ScrapedJob } from "./upwork";

const SEARCH_URL_BASE = "https://www.upwork.com/nx/search/jobs/";

// fast-poll-tune-001: cap reloads at one per 30s. Multi-keyword cycles would
// otherwise hammer the same tab back-to-back and trip Cloudflare. When the
// throttle fires we re-evaluate the current DOM instead of navigating.
const RELOAD_THROTTLE_MS = 30_000;
let _lastNavAt = 0;

let _fastPollTab: Page | null = null;
let _fastPollTabClosed = false;

async function getOrCreateFastPollTab(): Promise<Page> {
  const b = await launch();
  if (_fastPollTab && !_fastPollTabClosed) {
    try {
      // Probe — page may have closed/crashed even if we still hold the ref
      await _fastPollTab.evaluate(() => 1);
      return _fastPollTab;
    } catch {
      _fastPollTab = null;
      _fastPollTabClosed = true;
    }
  }
  const tab = await b.newPage();
  await tab.setViewport({ width: 1366, height: 768 }).catch(() => {});
  // Best-effort: if cookies are missing on this fresh tab, copy from the user's logged-in tab.
  const userPages = (await b.pages()).filter(p => p !== tab && p.url().includes("upwork.com") && !p.url().includes("about:blank"));
  if (userPages.length > 0) {
    const cookies = await userPages[0].cookies().catch(() => []);
    if (cookies.length > 0) await tab.setCookie(...cookies as any).catch(() => {});
  }
  tab.on("close", () => { _fastPollTabClosed = true; });
  _fastPollTab = tab;
  _fastPollTabClosed = false;
  logger.info("[FastPoll/Browser] Spawned dedicated fast-poll tab");
  return tab;
}

export async function fetchMostRecentJobs(keyword: string, limit = 3): Promise<ScrapedJob[]> {
  const page = await getOrCreateFastPollTab();

  const url = `${SEARCH_URL_BASE}?sort=recency&q=${encodeURIComponent(keyword)}`;
  const now = Date.now();
  const sinceLastNav = now - _lastNavAt;
  if (sinceLastNav < RELOAD_THROTTLE_MS) {
    // Within the 30s reload window — re-evaluate whatever's currently rendered
    // rather than triggering another navigation.
    logger.debug(`[FastPoll/Browser] reload throttled (${Math.round(sinceLastNav / 1000)}s since last nav) — re-reading current DOM`);
  } else {
    try {
      await page.goto(url, { waitUntil: "networkidle2", timeout: 25000 });
      _lastNavAt = Date.now();
    } catch (e) {
      logger.warn(`[FastPoll/Browser] goto failed for "${keyword}": ${(e as Error).message}`);
      return [];
    }
    // Brief settle so SPA hydrates the tile list.
    await new Promise(r => setTimeout(r, 1500));

    // Cloudflare miss detection: only screenshot when the page is actually
    // showing a challenge, so the artifact correlates 1:1 with CF blocks.
    const challenged = await page.evaluate(() => {
      const t = document.title || "";
      return t.includes("Just a moment") || t.includes("Checking") || t.includes("Attention Required");
    }).catch(() => false);
    if (challenged) {
      const stamp = Date.now();
      await page.screenshot({ path: `debug-turnstile-miss-${stamp}.png` }).catch(() => {});
      logger.warn(`[FastPoll/Browser] Cloudflare challenge during fast-poll on "${keyword}" — screenshot debug-turnstile-miss-${stamp}.png`);
      return [];
    }
  }

  const tiles = await page.evaluate((max: number) => {
    const articles = Array.from(document.querySelectorAll("article")) as HTMLElement[];
    const out: Array<{
      id: string; url: string; title: string; description: string;
      budget?: string; posted?: string; proposals?: string;
    }> = [];
    for (const a of articles.slice(0, max)) {
      const link = a.querySelector('a[href*="/jobs/"]') as HTMLAnchorElement | null;
      if (!link) continue;
      const idMatch = link.href.match(/~(\w+)/);
      if (!idMatch) continue;
      // Strip search-highlight markup from URL — Upwork bakes <span class="highlight"> into
      // the search-result anchor href.
      const cleanUrl = link.href
        .replace(/span-class-highlight-?/g, "")
        .replace(/-+/g, "-")
        .split("?")[0];

      // Title: prefer a heading-like child, fall back to anchor text. Strip <span class="highlight">
      // wrappers Upwork bakes into the live DOM.
      const headingEl = a.querySelector("h2, h3, h4, [data-test*='job-title']") as HTMLElement | null;
      const rawTitle = (headingEl?.textContent || link.textContent || "").trim().replace(/\s+/g, " ");
      const title = rawTitle.slice(0, 200);

      // Description: scoop the entire article's text (minus the title) so the pre-filter has
      // ICP keywords + budget + proposals to chew on. Search tiles vary by Upwork's A/B test;
      // grabbing all visible text is more robust than chasing data-test attrs.
      const allText = (a.innerText || a.textContent || "").trim().replace(/\s+/g, " ");
      const description = allText.slice(0, 1200);

      const budget = ((a.querySelector('[data-test*="budget"]')?.textContent) || "").trim().slice(0, 60);
      const posted = ((a.querySelector('[data-test*="posted"]')?.textContent) || "").trim().slice(0, 60);
      const proposals = ((a.querySelector('[data-test*="proposals"]')?.textContent) || "").trim().slice(0, 60);
      out.push({ id: idMatch[1], url: cleanUrl, title, description, budget, posted, proposals });
    }
    return out;
  }, limit);

  return tiles.map(t => ({ ...t, source: "search" as const }));
}

/** Test helper — clears throttle/tab state. Not used in production. */
export function _resetFastPollBrowserForTests(): void {
  _lastNavAt = 0;
  _fastPollTab = null;
  _fastPollTabClosed = false;
}
