/**
 * src/browser/linkedin.ts — Puppeteer-based LinkedIn scraper
 * Self-contained fallback when Chrome CDP / Safari LinkedIn is unavailable.
 */
import type { Page } from "puppeteer";
import { newPage, humanDelay } from "./engine";
import logger from "../config/logger";

export interface ScrapedProfile {
  username: string;
  displayName?: string;
  headline?: string;
  bio?: string;
  url?: string;
  followers?: number;
}

const LINKEDIN_SEARCH = "https://www.linkedin.com/search/results/people/";

export async function searchProfiles(query: string, limit = 15): Promise<ScrapedProfile[]> {
  let page: Page | null = null;
  const profiles: ScrapedProfile[] = [];

  try {
    page = await newPage();
    const url = `${LINKEDIN_SEARCH}?keywords=${encodeURIComponent(query)}&origin=GLOBAL_SEARCH_HEADER`;

    logger.info(`[Browser/LinkedIn] Searching: ${query}`);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await humanDelay(3000, 5000);

    // Check if we need to log in
    const loginForm = await page.$('#username, input[name="session_key"]');
    if (loginForm) {
      const email = process.env.LINKEDIN_EMAIL;
      const password = process.env.LINKEDIN_PASSWORD;
      if (!email || !password) {
        logger.warn("[Browser/LinkedIn] Login required but no credentials in env");
        return [];
      }

      logger.info("[Browser/LinkedIn] Logging in...");
      const emailInput = await page.$('#username, input[name="session_key"]');
      const passInput = await page.$('#password, input[name="session_password"]');
      if (emailInput && passInput) {
        await emailInput.type(email, { delay: 30 + Math.random() * 40 });
        await humanDelay(500, 1000);
        await passInput.type(password, { delay: 30 + Math.random() * 40 });
        await humanDelay(500, 1000);

        const signInBtn = await page.$('button[type="submit"], .btn__primary--large');
        if (signInBtn) await signInBtn.click();

        await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {});
        await humanDelay(2000, 4000);

        // Re-navigate to search after login
        await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
        await humanDelay(3000, 5000);
      }
    }

    // Wait for search results
    await page.waitForSelector('.reusable-search__result-container, .entity-result, li.reusable-search__result-container', { timeout: 10000 }).catch(() => {
      logger.warn("[Browser/LinkedIn] Search results not found");
    });

    const scraped = await page.evaluate((lim: number) => {
      const results: any[] = [];
      const cards = document.querySelectorAll(
        '.reusable-search__result-container, .entity-result, li.reusable-search__result-container'
      );

      cards.forEach((card, i) => {
        if (i >= lim) return;
        const nameEl = card.querySelector('.entity-result__title-text a span[aria-hidden="true"], .app-aware-link span[aria-hidden="true"]');
        const linkEl = card.querySelector('a.app-aware-link[href*="/in/"]') as HTMLAnchorElement | null;
        const headlineEl = card.querySelector('.entity-result__primary-subtitle, .entity-result__summary');
        const bioEl = card.querySelector('.entity-result__summary, .entity-result__content-summary');

        if (nameEl && linkEl) {
          const href = linkEl.href || "";
          const usernameMatch = href.match(/\/in\/([^/?]+)/);
          results.push({
            username: usernameMatch ? usernameMatch[1] : `user-${i}`,
            displayName: nameEl.textContent?.trim() || "",
            headline: headlineEl?.textContent?.trim() || "",
            bio: bioEl?.textContent?.trim() || "",
            url: href,
          });
        }
      });
      return results;
    }, limit);

    profiles.push(...scraped);
    logger.info(`[Browser/LinkedIn] Found ${profiles.length} profiles`);
  } catch (e) {
    logger.error(`[Browser/LinkedIn] searchProfiles error: ${(e as Error).message}`);
  } finally {
    if (page) await page.close().catch(() => {});
  }

  return profiles;
}

export async function sendDM(profileUrl: string, message: string): Promise<boolean> {
  let page: Page | null = null;

  try {
    page = await newPage();
    logger.info(`[Browser/LinkedIn] Opening profile for DM: ${profileUrl}`);
    await page.goto(profileUrl, { waitUntil: "networkidle2", timeout: 30000 });
    await humanDelay(2000, 4000);

    // Click "Message" button
    const msgBtn = await page.$('button.message-anywhere-button, button[aria-label*="Message"], a[href*="messaging"]');
    if (!msgBtn) {
      logger.warn("[Browser/LinkedIn] Message button not found (may not be connected)");
      return false;
    }

    await msgBtn.click();
    await humanDelay(2000, 3000);

    // Wait for message box
    const msgBox = await page.waitForSelector(
      'div[role="textbox"], div.msg-form__contenteditable, textarea',
      { timeout: 8000 }
    ).catch(() => null);

    if (!msgBox) {
      logger.warn("[Browser/LinkedIn] Message box not found");
      return false;
    }

    await msgBox.click();
    await humanDelay(500, 1000);
    await msgBox.type(message, { delay: 20 + Math.random() * 40 });
    await humanDelay(1000, 2000);

    // Send
    const sendBtn = await page.$('button.msg-form__send-button, button[type="submit"]');
    if (sendBtn) {
      await sendBtn.click();
      await humanDelay(1500, 3000);
      logger.info("[Browser/LinkedIn] DM sent via Puppeteer");
      return true;
    }

    logger.warn("[Browser/LinkedIn] Send button not found");
    return false;
  } catch (e) {
    logger.error(`[Browser/LinkedIn] sendDM error: ${(e as Error).message}`);
    return false;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}
