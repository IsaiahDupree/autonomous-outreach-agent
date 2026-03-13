/**
 * src/browser/engine.ts — Puppeteer browser engine (ported from Riona_v3)
 * Uses real Chrome installation + stealth to bypass Cloudflare.
 * Persistent profile keeps sessions/cookies across restarts.
 */
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import RecaptchaPlugin from "puppeteer-extra-plugin-recaptcha";
import type { Browser, Page } from "puppeteer";
import path from "path";
import fs from "fs";
import logger from "../config/logger";

// Stealth with all evasions
puppeteer.use(StealthPlugin());

// Recaptcha auto-solve (works without API key for checkbox captchas)
puppeteer.use(RecaptchaPlugin({ visualFeedback: true }));

let browser: Browser | null = null;

// Isolated profile for automation — avoids lock conflicts with regular Chrome
const DEFAULT_USER_DATA_DIR = path.join(
  process.env.APPDATA || process.env.HOME || ".",
  ".outreach-agent-chrome-profile"
);

// Find real Chrome installation
function findChrome(): string | undefined {
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return undefined;
}

export interface BrowserOptions {
  headless?: boolean;
  userDataDir?: string;
}

export async function launch(opts: BrowserOptions = {}): Promise<Browser> {
  if (browser && browser.connected) return browser;

  const headless = opts.headless ?? (process.env.BROWSER_HEADLESS !== "false");
  const userDataDir = opts.userDataDir || DEFAULT_USER_DATA_DIR;
  const executablePath = findChrome();
  const cdpPort = 9223; // Different from default 9222 to avoid conflicts

  if (executablePath && !headless) {
    // First: check if Chrome is already running on our CDP port
    let cdpReady = false;
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        cdpReady = true;
        logger.info(`[Browser] Found existing Chrome on CDP port ${cdpPort}`);
      }
    } catch { /* not running */ }

    if (!cdpReady) {
      // Kill any Chrome processes using our profile to avoid lock conflicts
      try {
        const { execSync: exec, spawn } = await import("child_process");
        // Launch Chrome as a standalone process with isolated profile
        logger.info(`[Browser] Launching Chrome natively with CDP on port ${cdpPort}`);
        logger.info(`[Browser] Using: ${executablePath}`);

        const chromeProcess = spawn(executablePath, [
          `--remote-debugging-port=${cdpPort}`,
          `--user-data-dir=${userDataDir}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--window-size=1366,768",
          "--lang=en-US,en",
        ], {
          detached: true,
          stdio: "ignore",
        });
        chromeProcess.unref();

        // Wait for Chrome to start
        logger.info("[Browser] Waiting for Chrome CDP to be ready...");
        for (let i = 0; i < 20; i++) {
          try {
            const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, {
              signal: AbortSignal.timeout(1000),
            });
            if (res.ok) {
              cdpReady = true;
              break;
            }
          } catch { /* not ready yet */ }
          await new Promise((r) => setTimeout(r, 500));
        }
      } catch (e) {
        logger.warn(`[Browser] Native Chrome launch failed: ${(e as Error).message}`);
      }
    }

    if (!cdpReady) {
      logger.warn("[Browser] CDP not ready — falling back to Puppeteer launch");
    } else {
      // Connect Puppeteer to the existing Chrome
      browser = await (puppeteer as any).connect({
        browserURL: `http://127.0.0.1:${cdpPort}`,
        defaultViewport: null,
        protocolTimeout: 300_000, // 5 min — Upwork pages can be slow
      });

      browser!.on("disconnected", () => {
        logger.warn("[Browser] Disconnected");
        browser = null;
      });

      logger.info("[Browser] Connected to native Chrome via CDP");
      return browser!;
    }
  }

  // Fallback: standard Puppeteer launch (use separate profile to avoid lock conflicts)
  const fallbackDir = userDataDir + "-puppeteer";
  logger.info(`[Browser] Launching via Puppeteer (headless=${headless})`);
  browser = await (puppeteer as any).launch({
    headless: headless ? "new" : false,
    executablePath,
    userDataDir: fallbackDir,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--disable-dev-shm-usage",
      "--window-size=1366,768",
      "--lang=en-US,en",
      `--remote-debugging-port=${cdpPort}`,
    ],
    defaultViewport: null,
    ignoreDefaultArgs: ["--enable-automation"],
  });

  browser!.on("disconnected", () => {
    logger.warn("[Browser] Disconnected");
    browser = null;
  });

  return browser!;
}

export async function newPage(): Promise<Page> {
  const b = await launch();
  const pages = await b.pages();
  // Reuse the first blank tab if available
  const page = pages.length > 0 && pages[0].url() === "about:blank" ? pages[0] : await b.newPage();

  // Set realistic headers
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

  // Override navigator properties for extra stealth
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    // Chrome-specific
    (window as any).chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
  });

  return page;
}

export async function close(): Promise<void> {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
    logger.info("[Browser] Closed");
  }
}

export function isRunning(): boolean {
  return browser !== null && browser.connected;
}

// ── Cookie persistence ──────────────────────────────────
const COOKIE_FILE = path.join(DEFAULT_USER_DATA_DIR, "saved-cookies.json");

/**
 * Save all browser cookies to disk (JSON).
 * Call after successful login to persist session.
 */
export async function saveCookies(page: Page): Promise<void> {
  try {
    const client = await page.createCDPSession();
    const { cookies } = await client.send("Network.getAllCookies") as { cookies: any[] };
    fs.mkdirSync(path.dirname(COOKIE_FILE), { recursive: true });
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
    logger.info(`[Browser] Saved ${cookies.length} cookies to ${COOKIE_FILE}`);
    await client.detach();
  } catch (e) {
    logger.warn(`[Browser] Failed to save cookies: ${(e as Error).message}`);
  }
}

/**
 * Restore cookies from disk into the current page/browser.
 * Call before navigating to check if session is still valid.
 * Returns true if cookies were loaded.
 */
export async function restoreCookies(page: Page): Promise<boolean> {
  try {
    if (!fs.existsSync(COOKIE_FILE)) return false;
    const raw = fs.readFileSync(COOKIE_FILE, "utf-8");
    const cookies = JSON.parse(raw);
    if (!Array.isArray(cookies) || cookies.length === 0) return false;

    // Check age — skip if cookies are older than 7 days
    const stat = fs.statSync(COOKIE_FILE);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > 7 * 24 * 60 * 60 * 1000) {
      logger.info("[Browser] Saved cookies are older than 7 days — skipping restore");
      return false;
    }

    const client = await page.createCDPSession();
    await client.send("Network.setCookies", { cookies });
    logger.info(`[Browser] Restored ${cookies.length} cookies (${Math.round(ageMs / 3600000)}h old)`);
    await client.detach();
    return true;
  } catch (e) {
    logger.warn(`[Browser] Failed to restore cookies: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Check if we have saved cookies that might still be valid.
 */
export function hasSavedCookies(): boolean {
  if (!fs.existsSync(COOKIE_FILE)) return false;
  const stat = fs.statSync(COOKIE_FILE);
  return Date.now() - stat.mtimeMs < 7 * 24 * 60 * 60 * 1000;
}

/** Random delay to appear human (Riona-style jitter) */
export function humanDelay(minMs = 800, maxMs = 2500): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs) + minMs);
  return new Promise((r) => setTimeout(r, ms));
}

// Track the CDP port for reconnection
let activeCdpPort = 9223;

/**
 * Wait for Cloudflare challenge to auto-resolve.
 * Strategy: find the Turnstile widget position, DISCONNECT CDP to remove
 * all automation traces, click with native OS mouse, wait, then reconnect.
 */
export async function waitForCloudflare(page: Page, maxWaitMs = 60000): Promise<boolean> {
  const { solveTurnstile, idleMouseMovements, humanClick } = await import("./mouse");
  const start = Date.now();

  // First check — maybe no challenge
  const title = await page.title();
  if (!title.includes("Just a moment") && !title.includes("Checking") && !title.includes("Attention")) {
    return true;
  }

  logger.info("[Browser] Cloudflare challenge detected — using disconnect+native-click strategy");

  // Wait for Turnstile widget to load
  await humanDelay(3000, 5000);

  // Get widget position while still connected
  const widgetBox = await page.evaluate(() => {
    const all = document.querySelectorAll("*");
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      const r = el.getBoundingClientRect();
      if (r.width > 200 && r.width < 400 && r.height > 50 && r.height < 100 && r.y > 100) {
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }
    }
    return null;
  }).catch(() => null);

  if (!widgetBox) {
    logger.warn("[Browser] Could not find Turnstile widget position");
    // Fall back to non-disconnect approach
    await solveTurnstile(page);
    await humanDelay(10000, 15000);
    const t2 = await page.title();
    return !t2.includes("Just a moment") && !t2.includes("Checking");
  }

  logger.info(`[Browser] Widget at x=${widgetBox.x}, y=${widgetBox.y}, w=${widgetBox.w}, h=${widgetBox.h}`);

  // Get window bounds for screen coordinate conversion
  const { getWindowBounds } = await import("./mouse");
  const winBounds = await getWindowBounds(page);

  // Calculate click target (checkbox is ~28px from left, vertically centered)
  const clickPageX = widgetBox.x + 28;
  const clickPageY = widgetBox.y + widgetBox.h / 2;
  const clickScreenX = Math.round(winBounds.x + clickPageX);
  const clickScreenY = Math.round(winBounds.y + clickPageY);

  logger.info(`[Browser] Will click at screen(${clickScreenX}, ${clickScreenY})`);

  // DISCONNECT CDP — this removes all automation fingerprints from Chrome
  logger.info("[Browser] Disconnecting CDP to clear automation traces...");
  browser!.disconnect();
  browser = null;

  // Wait longer for CDP to fully detach — gives Chrome time to "forget" automation
  await new Promise((r) => setTimeout(r, 3000 + Math.random() * 2000));

  // Now click with native OS mouse — Chrome is running as a completely normal browser
  logger.info("[Browser] Clicking Turnstile with native mouse (CDP disconnected)...");
  const { nativeClickExported } = await import("./mouse");

  // Add slight random jitter to the click coordinates each time
  const jitterX = Math.round(clickScreenX + (Math.random() * 6 - 3));
  const jitterY = Math.round(clickScreenY + (Math.random() * 6 - 3));
  nativeClickExported(jitterX, jitterY);

  // Wait for Cloudflare verification — randomize to avoid pattern detection
  const verifyWaitMs = 20000 + Math.random() * 10000; // 20-30s
  logger.info(`[Browser] Waiting ${Math.round(verifyWaitMs / 1000)}s for Cloudflare to verify (CDP disconnected)...`);
  await new Promise((r) => setTimeout(r, verifyWaitMs));

  // RECONNECT CDP
  logger.info("[Browser] Reconnecting to Chrome via CDP...");
  let reconnected = false;
  for (let i = 0; i < 10; i++) {
    try {
      browser = await (puppeteer as any).connect({
        browserURL: `http://127.0.0.1:${activeCdpPort}`,
        defaultViewport: null,
        protocolTimeout: 300_000,
      });
      reconnected = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  if (!reconnected || !browser) {
    logger.error("[Browser] Failed to reconnect to Chrome");
    return false;
  }

  logger.info("[Browser] Reconnected to Chrome");
  browser.on("disconnected", () => { browser = null; });

  // Check if Cloudflare passed by looking at the current page
  const pages = await browser.pages();
  if (pages.length > 0) {
    const currentTitle = await pages[0].title();
    if (!currentTitle.includes("Just a moment") && !currentTitle.includes("Checking") && !currentTitle.includes("Attention")) {
      logger.info("[Browser] Cloudflare challenge PASSED!");
      return true;
    }
    logger.warn(`[Browser] Cloudflare still present after click. Title: "${currentTitle}"`);
  }

  return false;
}
