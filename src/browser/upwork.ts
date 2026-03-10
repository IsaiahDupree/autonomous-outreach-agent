/**
 * src/browser/upwork.ts — Puppeteer-based Upwork scraper
 * Searches one keyword at a time with filters. Handles Cloudflare + login.
 */
import type { Page } from "puppeteer";
import { newPage, humanDelay, waitForCloudflare, launch, saveCookies, restoreCookies, hasSavedCookies } from "./engine";
import logger from "../config/logger";

export interface ScrapedJob {
  id: string;
  title: string;
  description: string;
  url: string;
  budget?: string;
  clientSpend?: string;
  proposals?: string;
  posted?: string;
  skills?: string[];
  score?: number;
}

export interface SearchFilters {
  // Sorting
  sort?: "recency" | "relevance";

  // Posted within: only jobs from last N hours
  postedWithin?: "1" | "3" | "24" | "72" | "168";  // hours: 1h, 3h, 24h, 3d, 7d

  // Experience level: 1=entry, 2=intermediate, 3=expert (can combine)
  experienceLevel?: ("1" | "2" | "3")[];

  // Job type + budget
  jobType?: "fixed" | "hourly";
  budgetMin?: number;           // fixed-price min (used with amount=min-max)
  budgetMax?: number;           // fixed-price max
  hourlyRateMin?: number;       // hourly min (used with hourly_rate=min-max)
  hourlyRateMax?: number;       // hourly max

  // Number of proposals: 0-4, 5-9, 10-14, 15-19, 20-49
  proposalRange?: "0-4" | "5-9" | "10-14" | "15-19" | "20-49";

  // Client info
  paymentVerified?: boolean;     // only show payment-verified clients
  previouslyHired?: boolean;     // only show your previous clients

  // Client history: no hires, 1-9, 10+
  clientHires?: "0" | "1-9" | "10+";

  // Client location (country name, e.g. "United States")
  clientLocation?: string;

  // Client time zone (GMT offset or timezone name)
  clientTimezone?: string;

  // Project length: less than month, 1-3 months, 3-6 months, 6+ months
  projectLength?: "weeks" | "months" | "semester" | "ongoing";

  // Hours per week (for hourly jobs)
  hoursPerWeek?: "less_than_30" | "more_than_30";

  // Contract-to-hire roles only
  contractToHire?: boolean;

  // Category filter (Upwork category slug, e.g. "it_networking", "web_mobile_software_dev")
  category?: string;

  // Subcategory filter
  subcategory?: string;

  // Connect price range (cost to apply): "0-2", "2-4", "4-6"
  connectPrice?: string;

  // Pagination
  page?: number;
  perPage?: number;              // results per page (default 10, max 50)
}

function buildSearchUrl(keyword: string, filters: SearchFilters = {}): string {
  const params = new URLSearchParams();
  params.set("q", keyword);
  params.set("sort", filters.sort || "recency");

  // Posted within (hours)
  if (filters.postedWithin) params.set("per_page", filters.postedWithin);
  // Upwork uses "posted" param: 1=last 24h, but the actual URL param is "t" for time
  // The most reliable way is using the recency sort + the "posted" param
  if (filters.postedWithin) {
    // Upwork URL param: "1" = last 24h, etc. — maps to "hours" query param
    params.set("hours", filters.postedWithin);
  }

  // Experience level (can set multiple)
  if (filters.experienceLevel?.length) {
    filters.experienceLevel.forEach(l => params.append("contractor_tier", l));
  }

  // Job type
  if (filters.jobType) params.set("job_type", filters.jobType);

  // Fixed-price budget range
  if (filters.budgetMin && filters.budgetMax) {
    params.set("amount", `${filters.budgetMin}-${filters.budgetMax}`);
  } else if (filters.budgetMin) {
    params.set("amount", `${filters.budgetMin}-`);
  } else if (filters.budgetMax) {
    params.set("amount", `0-${filters.budgetMax}`);
  }

  // Hourly rate range
  if (filters.hourlyRateMin && filters.hourlyRateMax) {
    params.set("hourly_rate", `${filters.hourlyRateMin}-${filters.hourlyRateMax}`);
  } else if (filters.hourlyRateMin) {
    params.set("hourly_rate", `${filters.hourlyRateMin}-`);
  } else if (filters.hourlyRateMax) {
    params.set("hourly_rate", `0-${filters.hourlyRateMax}`);
  }

  // Number of proposals
  if (filters.proposalRange) params.set("proposals", filters.proposalRange);

  // Client info
  if (filters.paymentVerified) params.set("payment_verified", "1");
  if (filters.previouslyHired) params.set("previously_hired", "true");

  // Client history
  if (filters.clientHires === "0") params.set("client_hires", "0");
  else if (filters.clientHires === "1-9") params.set("client_hires", "1-9");
  else if (filters.clientHires === "10+") params.set("client_hires", "10-");

  // Client location
  if (filters.clientLocation) params.set("location", filters.clientLocation);

  // Client time zone
  if (filters.clientTimezone) params.set("timezone", filters.clientTimezone);

  // Project length
  if (filters.projectLength) params.set("duration_v3", filters.projectLength);

  // Hours per week
  if (filters.hoursPerWeek === "less_than_30") params.set("hours_per_week", "as_needed");
  if (filters.hoursPerWeek === "more_than_30") params.set("hours_per_week", "30");

  // Contract to hire
  if (filters.contractToHire) params.set("t", "1");

  // Category / subcategory
  if (filters.category) params.set("category2", filters.category);
  if (filters.subcategory) params.set("subcategory2", filters.subcategory);

  // Connect price
  if (filters.connectPrice) params.set("connect_price", filters.connectPrice);

  // Pagination
  if (filters.page) params.set("page", String(filters.page));
  if (filters.perPage) params.set("per_page", String(filters.perPage));

  return `https://www.upwork.com/nx/search/jobs/?${params.toString()}`;
}

/**
 * Detect and handle Upwork login page.
 */
async function handleLogin(page: Page): Promise<boolean> {
  const url = page.url();
  const isLoginPage = url.includes("login") || url.includes("account-security");
  if (!isLoginPage) {
    const loginForm = await page.$('#login_username, input[name="login[username]"]');
    if (!loginForm) return true;
  }

  const email = process.env.UPWORK_EMAIL;
  const password = process.env.UPWORK_PASSWORD;
  if (!email || !password) {
    logger.warn("[Browser/Upwork] Login required but no UPWORK_EMAIL/UPWORK_PASSWORD in env");
    return false;
  }

  logger.info("[Browser/Upwork] Logging in...");
  try {
    // Take debug screenshot of login page
    await page.screenshot({ path: "debug-login-page.png" }).catch(() => {});

    // Wait for page to fully settle
    await humanDelay(2000, 3000);

    // Try multiple username selectors
    const usernameSelectors = [
      '#login_username',
      'input[name="login[username]"]',
      'input[type="email"]',
      'input[placeholder*="email" i]',
      'input[placeholder*="username" i]',
    ];

    let usernameInput = null;
    for (const sel of usernameSelectors) {
      await page.waitForSelector(sel, { timeout: 5000 }).catch(() => {});
      usernameInput = await page.$(sel);
      if (usernameInput) {
        logger.info(`[Browser/Upwork] Found username input: ${sel}`);
        break;
      }
    }

    if (!usernameInput) {
      logger.warn("[Browser/Upwork] No username input found");
      await page.screenshot({ path: "debug-login-no-input.png" }).catch(() => {});
      return false;
    }

    // Focus and clear the field first
    await usernameInput.focus();
    await humanDelay(200, 400);
    await page.keyboard.down("Control");
    await page.keyboard.press("a");
    await page.keyboard.up("Control");
    await humanDelay(100, 200);
    await page.keyboard.type(email, { delay: 25 + Math.random() * 40 });
    await humanDelay(800, 1500);

    // Submit username by pressing Enter (avoids button click issues)
    await page.keyboard.press("Enter");
    logger.info("[Browser/Upwork] Pressed Enter to submit username");

    // Wait for navigation (Upwork navigates to password page)
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {});
    await humanDelay(2000, 3500);

    // Refresh page ref in case of navigation
    let currentPage = page;
    try {
      const b = await launch();
      const pages = await b.pages();
      const p = pages.find(pg => pg.url().includes("upwork")) || pages[0];
      if (p) currentPage = p;
    } catch { /* keep existing page */ }

    // Handle potential Cloudflare on password page
    const cfTitle = await currentPage.title().catch(() => "");
    if (cfTitle.includes("Just a moment") || cfTitle.includes("Checking")) {
      logger.info("[Browser/Upwork] Cloudflare challenge on password step");
      await waitForCloudflare(currentPage, 90000);
      const b = await launch();
      const pages = await b.pages();
      const p = pages.find(pg => pg.url().includes("upwork")) || pages[0];
      if (p) {
        await humanDelay(2000, 3000);
        return handleLogin(p);
      }
    }

    // Wait for password field
    const passwordSelectors = [
      '#login_password',
      'input[name="login[password]"]',
      'input[type="password"]',
    ];
    let passwordInput = null;
    for (const sel of passwordSelectors) {
      await currentPage.waitForSelector(sel, { timeout: 8000 }).catch(() => {});
      passwordInput = await currentPage.$(sel);
      if (passwordInput) {
        logger.info(`[Browser/Upwork] Found password input: ${sel}`);
        break;
      }
    }

    if (!passwordInput) {
      logger.warn("[Browser/Upwork] No password input found");
      await currentPage.screenshot({ path: "debug-login-no-password.png" }).catch(() => {});
      return false;
    }

    await passwordInput.focus();
    await humanDelay(200, 400);
    await currentPage.keyboard.down("Control");
    await currentPage.keyboard.press("a");
    await currentPage.keyboard.up("Control");
    await humanDelay(100, 200);
    await currentPage.keyboard.type(password, { delay: 20 + Math.random() * 35 });
    await humanDelay(800, 1500);

    // Submit by pressing Enter
    await currentPage.keyboard.press("Enter");
    logger.info("[Browser/Upwork] Pressed Enter to submit login");

    await currentPage.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => {});
    await humanDelay(2000, 4000);

    await currentPage.screenshot({ path: "debug-login-after.png" }).catch(() => {});

    const currentUrl = currentPage.url();
    if (currentUrl.includes("login") || currentUrl.includes("account-security")) {
      logger.warn(`[Browser/Upwork] Still on login page — URL: ${currentUrl}`);
      return false;
    }

    logger.info("[Browser/Upwork] Login successful");
    return true;
  } catch (e) {
    logger.error(`[Browser/Upwork] Login error: ${(e as Error).message}`);
    await page.screenshot({ path: "debug-login-error.png" }).catch(() => {});
    return false;
  }
}

/**
 * Scrape job listings from the current page.
 */
async function scrapeCurrentPage(page: Page, limit: number): Promise<ScrapedJob[]> {
  // Wait for job article cards to load
  await page.waitForSelector(
    'article.job-tile, article[data-ev-job-uid], a[href*="/jobs/"]',
    { timeout: 15000 }
  ).catch(() => {
    logger.warn("[Browser/Upwork] No job elements found on page");
  });

  const jobs = await page.evaluate((lim: number) => {
    const results: any[] = [];
    const seen = new Set<string>();

    // Strategy 1: Use article elements with job UIDs (most reliable)
    const articles = Array.from(document.querySelectorAll('article[data-ev-job-uid], article.job-tile'));
    for (const article of articles) {
      if (results.length >= lim) break;

      // Get job ID from data attribute or link
      let id = article.getAttribute('data-ev-job-uid') || '';
      const jobLink = article.querySelector('a[href*="/jobs/"]') as HTMLAnchorElement | null;
      const href = jobLink?.href || '';

      if (!id) {
        const idMatch = href.match(/~0?([a-f0-9]{10,})/);
        id = idMatch ? idMatch[1] : '';
      }
      if (!id || seen.has(id)) continue;
      seen.add(id);

      // Title from the first link in the article
      const title = jobLink?.textContent?.trim() || '';
      if (!title || title.length < 5) continue;

      // Description - look for paragraph or description element
      let desc = '';
      const descEl = article.querySelector('p, [data-test="job-description-text"], .text-body-sm, span.up-line-clamp-v2, [class*="description"]');
      desc = descEl?.textContent?.trim().slice(0, 500) || '';

      // Budget
      let budget = '';
      const budgetEl = article.querySelector('[data-test="budget"], [data-test="is-fixed-price"], [class*="budget"]');
      budget = budgetEl?.textContent?.trim() || '';
      // Also check for budget in general text
      if (!budget) {
        const allText = article.textContent || '';
        const budgetMatch = allText.match(/\$[\d,.]+(?:\s*-\s*\$[\d,.]+)?(?:\s*\/\s*hr)?/);
        budget = budgetMatch ? budgetMatch[0] : '';
      }

      // Posted time
      let posted = '';
      const timeEl = article.querySelector('small, time, [data-test="posted-on"], span[data-test="posted-on"]');
      posted = timeEl?.textContent?.trim() || '';

      // Proposals count
      let proposals = '';
      const allText = article.textContent || '';
      const proposalMatch = allText.match(/(\d+)\s*to\s*(\d+)\s*proposals?|Less than \d+ proposals?|(\d+)\+?\s*proposals?/i);
      proposals = proposalMatch ? proposalMatch[0] : '';

      // Client spend
      let clientSpend = '';
      const spendMatch = allText.match(/\$[\d,.]+[KkMm]?\+?\s*(?:spent|total)/i);
      clientSpend = spendMatch ? spendMatch[0] : '';

      // Skill tags
      const skillTags: string[] = [];
      const skillEls = article.querySelectorAll('a[data-test="skill"], span.up-skill-badge, .air3-token, [class*="skill"]');
      skillEls.forEach(s => {
        const t = s.textContent?.trim();
        if (t && t.length < 40) skillTags.push(t);
      });

      const url = href.startsWith('http') ? href.split('?')[0] : (href ? `https://www.upwork.com${href.split('?')[0]}` : `https://www.upwork.com/jobs/~0${id}`);

      results.push({
        id,
        title,
        description: desc,
        url,
        budget: budget || undefined,
        posted: posted || undefined,
        proposals: proposals || undefined,
        clientSpend: clientSpend || undefined,
        skills: skillTags.length > 0 ? skillTags : undefined,
      });
    }

    // Strategy 2: Fallback - find any links to /jobs/ pages
    if (results.length === 0) {
      const jobLinks = Array.from(document.querySelectorAll('a[href*="/jobs/"]'));
      for (const link of jobLinks) {
        if (results.length >= lim) break;
        const a = link as HTMLAnchorElement;
        const href = a.href || '';
        const idMatch = href.match(/~0?([a-f0-9]{10,})/);
        const id = idMatch ? idMatch[1] : '';
        if (!id || seen.has(id)) continue;
        seen.add(id);

        const title = a.textContent?.trim() || '';
        if (!title || title.length < 5) continue;

        const card = a.closest('article, section, div.up-card-section, [class*="card"]');
        const desc = card?.querySelector('p')?.textContent?.trim().slice(0, 500) || '';

        results.push({
          id,
          title,
          description: desc,
          url: href.split('?')[0],
        });
      }
    }

    return results;
  }, limit);

  return jobs;
}

let _loggedIn = false;

/**
 * Ensure we're logged into Upwork. Navigates to login page if needed.
 */
async function ensureLoggedIn(page: Page): Promise<boolean> {
  if (_loggedIn) return true;

  // Check if already logged in by looking for "Log in" link
  const loginLink = await page.$('a[href*="login"][data-test], a.nav-right-item[href*="login"]');
  const loginText = await page.evaluate(() => {
    const el = document.querySelector('a[href*="login"]');
    return el?.textContent?.trim() || "";
  }).catch(() => "");

  if (!loginLink && !loginText.toLowerCase().includes("log in")) {
    _loggedIn = true;
    return true;
  }

  // Try restoring saved cookies before doing a full login
  if (hasSavedCookies()) {
    logger.info("[Browser/Upwork] Attempting session restore via saved cookies...");
    const restored = await restoreCookies(page);
    if (restored) {
      // Reload page to apply cookies
      await page.goto("https://www.upwork.com", { waitUntil: "networkidle2", timeout: 30000 });
      await humanDelay(1500, 2500);
      // Check login state again
      const stillNeedsLogin = await page.evaluate(() => {
        const el = document.querySelector('a[href*="login"]');
        return el?.textContent?.trim().toLowerCase().includes("log in") || false;
      }).catch(() => true);
      if (!stillNeedsLogin) {
        logger.info("[Browser/Upwork] Session restored from cookies — no login needed!");
        _loggedIn = true;
        return true;
      }
      logger.info("[Browser/Upwork] Saved cookies expired — proceeding with full login");
    }
  }

  logger.info("[Browser/Upwork] Not logged in — navigating to login page");
  await page.goto("https://www.upwork.com/ab/account-security/login", {
    waitUntil: "networkidle2",
    timeout: 30000,
  });

  // Handle Cloudflare on login page
  const cfPassed = await waitForCloudflare(page, 90000);
  if (!cfPassed) {
    // Refresh page ref after disconnect
    const b = await launch();
    const pages = await b.pages();
    const p = pages.find(pg => pg.url().includes("upwork")) || pages[0];
    if (p) {
      await p.goto("https://www.upwork.com/ab/account-security/login", {
        waitUntil: "networkidle2",
        timeout: 30000,
      });
    }
  }

  // Refresh page ref after potential CDP reconnect
  const b = await launch();
  const allPages = await b.pages();
  const loginPage = allPages.find(p => p.url().includes("upwork")) || allPages[0];

  const ok = await handleLogin(loginPage);
  if (ok) {
    _loggedIn = true;
    logger.info("[Browser/Upwork] Login confirmed");
    // Save cookies for future sessions
    const b3 = await launch();
    const p3 = (await b3.pages()).find(p => p.url().includes("upwork")) || loginPage;
    await saveCookies(p3);
  }
  return ok;
}

/**
 * Search for jobs with a single keyword and optional filters.
 */
export async function searchJobs(
  keyword: string,
  filters: SearchFilters = {},
  limit = 20
): Promise<ScrapedJob[]> {
  let page: Page | null = null;

  try {
    page = await newPage();

    // Ensure logged in first
    await page.goto("https://www.upwork.com", { waitUntil: "networkidle2", timeout: 30000 });
    const cfPassed = await waitForCloudflare(page, 90000);

    // Refresh page ref after potential CDP reconnect
    const b = await launch();
    const allPages = await b.pages();
    page = allPages.find(p => p.url().includes("upwork")) || allPages[0];

    if (!cfPassed) {
      logger.warn("[Browser/Upwork] Cloudflare blocked on homepage");
    }

    await ensureLoggedIn(page);

    // Now navigate to search
    const url = buildSearchUrl(keyword, filters);
    logger.info(`[Browser/Upwork] Searching: "${keyword}" (${filters.sort || "recency"})`);

    // Refresh page ref again
    const b2 = await launch();
    const pages2 = await b2.pages();
    page = pages2.find(p => p.url().includes("upwork")) || pages2[0];

    await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
    await humanDelay(3000, 5000);

    // Handle Cloudflare on search page
    const searchTitle = await page.title();
    if (searchTitle.includes("Just a moment") || searchTitle.includes("Checking") || searchTitle.includes("Attention")) {
      logger.info("[Browser/Upwork] Cloudflare challenge on search page — solving...");
      await waitForCloudflare(page, 90000);
      // Re-get page after potential CDP reconnect
      const bCf = await launch();
      const cfPages = await bCf.pages();
      page = cfPages.find(p => p.url().includes("upwork")) || cfPages[0];
      // Re-navigate to search after CF
      await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
      await humanDelay(3000, 5000);
    }

    // Wait for job content to load (SPA may load async)
    await page.waitForSelector('article.job-tile, article[data-ev-job-uid], a[href*="/jobs/"]', { timeout: 15000 }).catch(() => {
      logger.warn("[Browser/Upwork] Timed out waiting for job listings to appear");
    });
    await humanDelay(1000, 2000);

    // Dismiss cookie banner if present
    const cookieBtn = await page.$('button[id*="cookie"], button.onetrust-close-btn-handler, button[aria-label="Close"]');
    if (cookieBtn) {
      await cookieBtn.click().catch(() => {});
      await humanDelay(500, 1000);
    }

    // Debug: save screenshot and check page state
    const pageTitle = await page.title();
    const pageUrl = page.url();
    logger.info(`[Browser/Upwork] Page: "${pageTitle}" | URL: ${pageUrl.slice(0, 100)}`);
    await page.screenshot({ path: `debug-search-${keyword.replace(/\s+/g, "-")}.png` }).catch(() => {});

    // Check for "can't complete" / "Log in" / empty results
    const pageText = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || "").catch(() => "");
    // Log abbreviated page text for debugging
    if (pageText.includes("can't complete") || pageText.includes("Log in to Upwork")) {
      logger.warn(`[Browser/Upwork] Page shows error or login required for "${keyword}"`);
      // Try logging in
      const loginLink = await page.$('a[href*="login"], button:has-text("Log In")');
      if (loginLink) {
        await loginLink.click().catch(() => {});
        await humanDelay(2000, 3000);
        const loginOk = await handleLogin(page);
        if (loginOk) {
          // Re-navigate after login
          await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
          await humanDelay(3000, 5000);
        }
      }
    }

    const jobs = await scrapeCurrentPage(page, limit);
    logger.info(`[Browser/Upwork] Found ${jobs.length} jobs for "${keyword}"`);
    return jobs;
  } catch (e) {
    logger.error(`[Browser/Upwork] searchJobs error: ${(e as Error).message}`);
    return [];
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/**
 * Search multiple keywords, deduplicate results.
 */
export async function scanJobs(
  keywords: string[],
  filters: SearchFilters = {},
  limit = 20
): Promise<ScrapedJob[]> {
  const allJobs: ScrapedJob[] = [];
  const seen = new Set<string>();

  for (const kw of keywords) {
    const jobs = await searchJobs(kw, filters, limit);
    for (const job of jobs) {
      if (!seen.has(job.id)) {
        seen.add(job.id);
        allJobs.push(job);
      }
    }
    // Small delay between searches to be polite
    if (keywords.indexOf(kw) < keywords.length - 1) {
      await humanDelay(3000, 5000);
    }
  }

  logger.info(`[Browser/Upwork] Total unique jobs: ${allJobs.length} across ${keywords.length} keywords`);
  return allJobs;
}

/**
 * Profile data scraped from Upwork.
 */
export interface UpworkProfile {
  name: string;
  title: string;
  hourlyRate: string;
  location: string;
  description: string;
  totalJobs: number;
  completedJobs: number;
  inProgressJobs: number;
  totalEarnings?: string;
  jobSuccessScore?: string;
  rating?: string;
  hoursPerWeek?: string;
  skills: string[];
  linkedAccounts: string[];
  availability: string;
  profileUrl: string;
  memberSince?: string;
  connects?: number;
  proposals?: { active: number; archived: number; invitations: number };
  recentFeedback: { client: string; rating: string; comment: string }[];
}

/**
 * Scrape the logged-in user's profile data.
 */
export async function getProfile(): Promise<UpworkProfile | null> {
  let page: Page | null = null;

  try {
    page = await newPage();

    // Navigate and handle CF
    await page.goto("https://www.upwork.com", { waitUntil: "networkidle2", timeout: 30000 });
    await waitForCloudflare(page, 90000);

    // Refresh page ref
    const b = await launch();
    const allPages = await b.pages();
    page = allPages.find(p => p.url().includes("upwork")) || allPages[0];

    await ensureLoggedIn(page);

    // Refresh page ref after login
    const b2 = await launch();
    const pages2 = await b2.pages();
    page = pages2.find(p => p.url().includes("upwork")) || pages2[0];

    // Find our profile URL from the nav
    const profileUrl = await page.evaluate(() => {
      const links = document.querySelectorAll('a[href*="/freelancers/~"]');
      for (const l of Array.from(links)) {
        const href = (l as HTMLAnchorElement).href;
        if (href.match(/\/freelancers\/~[a-f0-9]+$/)) return href;
      }
      return "";
    });

    if (!profileUrl) {
      logger.warn("[Browser/Upwork] Could not find profile URL");
      return null;
    }

    logger.info(`[Browser/Upwork] Profile URL: ${profileUrl}`);

    // Navigate to profile page
    await page.goto(profileUrl, { waitUntil: "networkidle2", timeout: 30000 });
    await humanDelay(3000, 5000);

    // Scrape profile data
    const profile = await page.evaluate((url: string) => {
      const text = document.body.innerText || "";

      // Name
      const nameEl = document.querySelector('h1, h2, [data-test="freelancer-name"]');
      const name = nameEl?.textContent?.trim() || "";

      // Title
      const titleEl = document.querySelector('[data-test="freelancer-title"], [class*="profile-title"]');
      const title = titleEl?.textContent?.trim() || "";

      // Hourly rate
      const rateMatch = text.match(/\$[\d,.]+\/hr/);
      const hourlyRate = rateMatch ? rateMatch[0] : "";

      // Location
      const locEl = document.querySelector('[data-test="freelancer-location"], [itemprop="address"]');
      const location = locEl?.textContent?.trim() || "";

      // Description/overview
      const descEl = document.querySelector('[data-test="freelancer-overview"], [class*="overview"] p, section p');
      const description = descEl?.textContent?.trim().slice(0, 1000) || "";

      // Job counts
      const totalMatch = text.match(/(\d+)\s*Total jobs/i);
      const completedMatch = text.match(/Completed jobs\s*\((\d+)\)/i);
      const inProgressMatch = text.match(/In progress\s*\((\d+)\)/i);

      // Rating
      const ratingMatch = text.match(/Rating is ([\d.]+) out of 5/);
      const rating = ratingMatch ? ratingMatch[1] : "";

      // Hours per week
      const hoursMatch = text.match(/(As Needed|Less than 30|More than 30)[^]*?(?:hrs\/week|Open to Offers)/i);
      const hoursPerWeek = hoursMatch ? hoursMatch[0].trim() : "";

      // Skills
      const skillEls = document.querySelectorAll('[data-test="skill"], [class*="skill"] span, .air3-token');
      const skills: string[] = [];
      skillEls.forEach(s => {
        const t = s.textContent?.trim();
        if (t && t.length < 50 && !skills.includes(t)) skills.push(t);
      });

      // If skills empty, try to find from the Skills section
      if (skills.length === 0) {
        const skillSection = text.match(/Skills\n([\s\S]*?)(?:Project catalog|Portfolio|Work history|$)/);
        if (skillSection) {
          skillSection[1].split("\n").forEach(s => {
            const t = s.trim();
            if (t && t.length > 2 && t.length < 50) skills.push(t);
          });
        }
      }

      // Linked accounts
      const linkedAccounts: string[] = [];
      const linkedSection = text.match(/Linked accounts\n([\s\S]*?)(?:Skills|Portfolio|$)/);
      if (linkedSection) {
        linkedSection[1].split("\n").forEach(l => {
          const t = l.trim();
          if (t && t.length > 3 && t.length < 60) linkedAccounts.push(t);
        });
      }

      // Recent feedback
      const recentFeedback: { client: string; rating: string; comment: string }[] = [];
      const feedbackMatches = text.matchAll(/Rating is ([\d.]+) out of 5[\s\S]*?"([^"]+)"/g);
      for (const m of feedbackMatches) {
        recentFeedback.push({ client: "", rating: m[1], comment: m[2].slice(0, 200) });
      }

      // Member since
      const sinceMatch = text.match(/Member since\s+(\w+ \d{4})/i);

      return {
        name,
        title,
        hourlyRate,
        location,
        description,
        totalJobs: totalMatch ? parseInt(totalMatch[1]) : 0,
        completedJobs: completedMatch ? parseInt(completedMatch[1]) : 0,
        inProgressJobs: inProgressMatch ? parseInt(inProgressMatch[1]) : 0,
        rating,
        hoursPerWeek,
        skills,
        linkedAccounts,
        availability: hoursPerWeek || "Unknown",
        profileUrl: url,
        memberSince: sinceMatch ? sinceMatch[1] : undefined,
        recentFeedback,
      };
    }, profileUrl);

    // Now get connects and proposals info
    await page.goto("https://www.upwork.com/nx/proposals/", { waitUntil: "networkidle2", timeout: 20000 }).catch(() => {});
    await humanDelay(2000, 3000);

    const proposalData = await page.evaluate(() => {
      const text = document.body.innerText || "";
      const activeMatch = text.match(/Active\s*(?:\((\d+)\))?/);
      const archivedMatch = text.match(/Archived\s*(?:\((\d+)\))?/);
      const invitationsMatch = text.match(/Invitations?\s*(?:to interview)?\s*\((\d+)\)/i);
      const connectsMatch = text.match(/Available connects:\s*(\d+)|(\d+)\s*(?:available\s+)?connects/i);
      return {
        active: activeMatch ? parseInt(activeMatch[1] || "0") : 0,
        archived: archivedMatch ? parseInt(archivedMatch[1] || "0") : 0,
        invitations: invitationsMatch ? parseInt(invitationsMatch[1]) : 0,
        connects: connectsMatch ? parseInt(connectsMatch[1] || connectsMatch[2] || "0") : undefined,
      };
    }).catch(() => ({ active: 0, archived: 0, invitations: 0, connects: undefined }));

    const result: UpworkProfile = {
      ...profile,
      connects: proposalData.connects,
      proposals: {
        active: proposalData.active,
        archived: proposalData.archived,
        invitations: proposalData.invitations,
      },
    };

    logger.info(`[Browser/Upwork] Profile scraped: ${result.name} | ${result.title} | ${result.hourlyRate} | ${result.totalJobs} jobs | ${result.skills.length} skills`);
    return result;
  } catch (e) {
    logger.error(`[Browser/Upwork] getProfile error: ${(e as Error).message}`);
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/**
 * Get an active Upwork page that's logged in.
 * Reuses existing tabs, handles CF + login as needed.
 */
async function getActiveUpworkPage(): Promise<Page> {
  const b = await launch();
  let pages = await b.pages();

  // Try to find an existing Upwork page that's logged in
  let page = pages.find(p => {
    const url = p.url();
    return url.includes("upwork.com") && !url.includes("/login") && !url.includes("about:blank");
  });

  if (page) {
    logger.info(`[Browser/Upwork] Reusing existing page: ${page.url().slice(0, 60)}`);
    return page;
  }

  // No active Upwork page — try restoring cookies first, then navigate
  page = pages.length > 0 ? pages[0] : await b.newPage();
  if (hasSavedCookies()) {
    await restoreCookies(page);
  }
  await page.goto("https://www.upwork.com", { waitUntil: "networkidle2", timeout: 30000 });
  await waitForCloudflare(page, 90000);

  // After CF, browser might have reconnected — re-get pages
  const b2 = await launch();
  const pages2 = await b2.pages();
  page = pages2.find(p => p.url().includes("upwork")) || pages2[0];

  await ensureLoggedIn(page);

  // After login, re-get page reference
  const b3 = await launch();
  const pages3 = await b3.pages();
  page = pages3.find(p => p.url().includes("upwork") && !p.url().includes("/login")) || pages3[0];

  return page;
}

/**
 * Wait for Upwork SPA content to actually render on page.
 * Polls for visible text content (not just the shell).
 */
async function waitForContent(page: Page, maxWaitMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const hasContent = await page.evaluate(() => {
      const text = document.body.innerText || "";
      // Check for signs of rendered content (not just the shell/header)
      return text.length > 200 && (
        text.includes("Posted") ||
        text.includes("Budget") ||
        text.includes("Description") ||
        text.includes("Skills") ||
        text.includes("proposals") ||
        text.includes("Apply") ||
        text.includes("Submit") ||
        text.includes("Hourly") ||
        text.includes("Fixed")
      );
    }).catch(() => false);

    if (hasContent) {
      logger.info("[Browser/Upwork] Page content rendered");
      return;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  // Log what we actually see for debugging
  const bodyLen = await page.evaluate(() => (document.body.innerText || "").length).catch(() => 0);
  logger.warn(`[Browser/Upwork] Content wait timed out. Body text length: ${bodyLen}`);
}

/**
 * Scrape detailed job info from a single job page.
 */
export interface JobDetails {
  id: string;
  title: string;
  description: string;
  url: string;
  budget?: string;
  jobType?: string;           // "Fixed-price" or "Hourly"
  experienceLevel?: string;   // "Entry", "Intermediate", "Expert"
  estimatedTime?: string;     // "1 to 3 months"
  hoursPerWeek?: string;      // "30+ hrs/week"
  projectLength?: string;
  skills: string[];
  proposals?: string;         // "10 to 15"
  connectsRequired?: number;
  clientInfo: {
    name?: string;
    location?: string;
    rating?: string;
    totalSpent?: string;
    hires?: string;
    activeJobs?: string;
    paymentVerified?: boolean;
    memberSince?: string;
  };
  posted?: string;
  attachments?: string[];
  questions?: string[];       // screening questions
}

export async function getJobDetails(jobUrl: string): Promise<JobDetails | null> {
  let page: Page | null = null;

  try {
    // Get active logged-in page
    page = await getActiveUpworkPage();

    // Navigate to job
    logger.info(`[Browser/Upwork] Navigating to job: ${jobUrl.slice(0, 80)}`);
    await page.goto(jobUrl, { waitUntil: "networkidle2", timeout: 30000 });
    await humanDelay(2000, 3000);

    // Wait for SPA content to render
    await waitForContent(page);
    await page.screenshot({ path: "debug-job-details.png" }).catch(() => {});

    const details = await page.evaluate((url: string) => {
      const text = document.body.innerText || "";

      // ID from URL
      const idMatch = url.match(/~0?([a-f0-9]{10,})/);
      const id = idMatch ? idMatch[1] : "";

      // Title — find the main heading (skip nav/logo h1s)
      let title = "";
      const headings = document.querySelectorAll("h1, h2, [data-test='job-title']");
      for (const h of Array.from(headings)) {
        const t = h.textContent?.trim() || "";
        if (t.length > 10 && !t.toLowerCase().includes("upwork")) {
          title = t;
          break;
        }
      }

      // Description — try multiple selectors, fall back to body text extraction
      let description = "";
      const descEl = document.querySelector('[data-test="description"], [class*="description"] p, [class*="job-description"], section p');
      if (descEl) {
        description = descEl.textContent?.trim().slice(0, 2000) || "";
      }
      if (!description) {
        // Extract from body text between "Summary" and next section
        const summaryIdx = text.indexOf("Summary");
        if (summaryIdx > -1) {
          const afterSummary = text.slice(summaryIdx + 7, summaryIdx + 2007);
          const endIdx = afterSummary.search(/\n(Skills and Expertise|Activity on this job|About the client)/);
          description = afterSummary.slice(0, endIdx > 0 ? endIdx : 1000).trim();
        }
      }

      // Budget / rate
      const budgetMatch = text.match(/Est\. budget:\s*\$[\d,.]+|\$[\d,.]+\s*-\s*\$[\d,.]+\s*\/hr|Fixed[- ]price\s*\$[\d,.]+/i);
      const budget = budgetMatch ? budgetMatch[0] : "";

      // Job type
      const jobType = text.includes("Hourly") ? "Hourly" : text.includes("Fixed") ? "Fixed-price" : "";

      // Experience level
      const expMatch = text.match(/(Entry Level|Intermediate|Expert)/i);
      const experienceLevel = expMatch ? expMatch[1] : "";

      // Time/duration
      const timeMatch = text.match(/Est\. time:\s*([^\n]+)/i);
      const estimatedTime = timeMatch ? timeMatch[1].trim() : "";

      // Hours per week
      const hoursMatch = text.match(/(\d+\+?\s*hrs\/week|Less than \d+ hrs\/week)/i);
      const hoursPerWeek = hoursMatch ? hoursMatch[0] : "";

      // Skills
      const skills: string[] = [];
      document.querySelectorAll('[data-test="skill"], .air3-token, a[href*="skill"]').forEach(s => {
        const t = s.textContent?.trim();
        if (t && t.length < 50 && !skills.includes(t)) skills.push(t);
      });

      // Proposals
      const proposalMatch = text.match(/Proposals:\s*([^\n]+)/i) || text.match(/(\d+ to \d+) proposals?/i);
      const proposals = proposalMatch ? proposalMatch[1].trim() : "";

      // Connects required
      const connectsMatch = text.match(/(\d+)\s*Connects?\s*(?:required|to submit)/i) || text.match(/Send a proposal for:?\s*(\d+)\s*Connects/i) || text.match(/for:?\s*(\d+)\s*Connects/i);
      const connectsRequired = connectsMatch ? parseInt(connectsMatch[1]) : undefined;

      // Client info
      const paymentVerified = text.includes("Payment verified");
      const ratingMatch = text.match(/Rating is ([\d.]+) out of 5/);
      const spentMatch = text.match(/\$([\d,.]+[KkMm]?\+?)\s*(?:total )?spent/i);
      const hiresMatch = text.match(/(\d+)\s*hires?/i);
      const locationMatch = text.match(/Location\s*\n?\s*([A-Z][a-zA-Z\s,]+)/);
      const memberMatch = text.match(/Member since\s*\n?\s*(\w+ \d{1,2},?\s*\d{4})/i);

      // Posted time
      const postedMatch = text.match(/Posted\s+(\w+ ago|\d+ \w+ ago|yesterday|today)/i);

      // Screening questions
      const questions: string[] = [];
      const qSection = text.match(/Screening questions[\s\S]*?(?:About the client|Activity on this job|$)/i);
      if (qSection) {
        qSection[0].split("\n").forEach(line => {
          const q = line.trim();
          if (q.endsWith("?") && q.length > 10) questions.push(q);
        });
      }

      return {
        id,
        title,
        description,
        url,
        budget,
        jobType,
        experienceLevel,
        estimatedTime,
        hoursPerWeek,
        skills,
        proposals,
        connectsRequired,
        clientInfo: {
          location: locationMatch ? locationMatch[1].trim() : undefined,
          rating: ratingMatch ? ratingMatch[1] : undefined,
          totalSpent: spentMatch ? "$" + spentMatch[1] : undefined,
          hires: hiresMatch ? hiresMatch[1] : undefined,
          paymentVerified,
          memberSince: memberMatch ? memberMatch[1] : undefined,
        },
        posted: postedMatch ? postedMatch[1] : undefined,
        questions,
      };
    }, jobUrl);

    logger.info(`[Browser/Upwork] Job details: "${details.title}" | ${details.budget} | ${details.proposals} proposals | ${details.connectsRequired || "?"} connects`);
    return details;
  } catch (e) {
    logger.error(`[Browser/Upwork] getJobDetails error: ${(e as Error).message}`);
    return null;
  }
}

export async function submitProposal(
  jobUrl: string,
  coverLetter: string,
  options?: {
    dryRun?: boolean;              // fill form but don't click submit
    answerQuestions?: Record<string, string>;  // screening question answers
    attachments?: string[];        // file paths to attach
    boostConnects?: number;        // extra connects to boost ranking (0 = no boost)
    paymentMode?: "milestone" | "project"; // "By milestone" or "By project"
    milestones?: { description: string; amount: number; dueDate?: string }[];
    duration?: string;             // e.g. "1 to 3 months", "Less than 1 month"
    specializedProfile?: string;   // profile name to select from combobox
    hourlyRate?: number;           // for hourly jobs
  }
): Promise<boolean> {
  let page: Page | null = null;

  try {
    // Get active logged-in page
    page = await getActiveUpworkPage();

    // Navigate to job
    logger.info(`[Browser/Upwork] Navigating to job for proposal: ${jobUrl.slice(0, 80)}`);
    await page.goto(jobUrl, { waitUntil: "networkidle2", timeout: 30000 });
    await humanDelay(2000, 3000);

    // Wait for SPA content to render
    await waitForContent(page);
    await page.screenshot({ path: "debug-proposal-job.png" }).catch(() => {});

    // ── Click "Apply Now" ──────────────────────────────
    const applySelectors = [
      'button[data-test="apply-button"]',
      'a[href*="proposals/job"]',
    ];
    let applied = false;
    for (const sel of applySelectors) {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        applied = true;
        logger.info(`[Browser/Upwork] Clicked apply: ${sel}`);
        break;
      }
    }
    if (!applied) {
      applied = await page.evaluate(() => {
        const buttons = document.querySelectorAll("button, a");
        for (const b of Array.from(buttons)) {
          const t = (b.textContent?.trim() || "").toLowerCase();
          if (t.includes("apply now") || t.includes("submit a proposal") || t.includes("submit proposal")) {
            (b as HTMLElement).click();
            return true;
          }
        }
        return false;
      });
      if (applied) logger.info("[Browser/Upwork] Clicked apply via text search");
    }

    if (!applied) {
      logger.error("[Browser/Upwork] Could not find Apply button on job page");
      await page.screenshot({ path: "debug-proposal-no-apply.png" }).catch(() => {});
      return false;
    }

    // Wait for navigation to proposal form
    await Promise.race([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {}),
      humanDelay(5000, 7000),
    ]);

    // Re-get page if navigated to new tab
    const bNav = await launch();
    const navPages = await bNav.pages();
    const proposalPage = navPages.find(p => p.url().includes("proposals")) || page;
    if (proposalPage !== page) {
      page = proposalPage;
      logger.info(`[Browser/Upwork] Switched to proposal page: ${page.url().slice(0, 80)}`);
    }

    await waitForContent(page);
    await page.screenshot({ path: "debug-proposal-form.png" }).catch(() => {});

    // Log form inventory
    const formInfo = await page.evaluate(() => {
      return {
        textareas: document.querySelectorAll("textarea").length,
        textInputs: document.querySelectorAll('input[type="text"], input:not([type])').length,
        numberInputs: document.querySelectorAll('input[type="number"]').length,
        radios: document.querySelectorAll('input[type="radio"]').length,
        comboboxes: document.querySelectorAll('[role="combobox"]').length,
        url: window.location.href,
      };
    });
    logger.info(`[Browser/Upwork] Form: ${formInfo.textareas} textareas, ${formInfo.textInputs} text, ${formInfo.numberInputs} number, ${formInfo.radios} radios, ${formInfo.comboboxes} comboboxes | ${formInfo.url.slice(0, 80)}`);

    // ── 1. Specialized profile (custom combobox) ───────
    if (options?.specializedProfile) {
      logger.info(`[Browser/Upwork] Setting specialized profile: ${options.specializedProfile}`);
      const clicked = await page.evaluate(() => {
        const combos = document.querySelectorAll('[role="combobox"]');
        for (const c of Array.from(combos)) {
          const parent = c.closest("div, section");
          const txt = parent?.textContent?.toLowerCase() || "";
          if (txt.includes("specialized profile") || txt.includes("propose with")) {
            (c as HTMLElement).click();
            return true;
          }
        }
        return false;
      });
      if (clicked) {
        await humanDelay(500, 800);
        await page.evaluate((name: string) => {
          const items = document.querySelectorAll('[role="option"], li');
          for (const item of Array.from(items)) {
            if (item.textContent?.toLowerCase().includes(name.toLowerCase())) {
              (item as HTMLElement).click();
              return true;
            }
          }
          return false;
        }, options.specializedProfile);
        logger.info(`[Browser/Upwork] Selected profile: ${options.specializedProfile}`);
      }
      await humanDelay(300, 500);
    }

    // ── 2. Payment mode (By milestone / By project) ────
    if (options?.paymentMode) {
      const radioValue = options.paymentMode === "milestone" ? "milestone" : "default";
      await page.evaluate((val: string) => {
        const radios = document.querySelectorAll('input[name="milestoneMode"]');
        for (const r of Array.from(radios)) {
          if ((r as HTMLInputElement).value === val) {
            (r as HTMLElement).click();
            return true;
          }
        }
        return false;
      }, radioValue);
      logger.info(`[Browser/Upwork] Set payment mode: ${options.paymentMode}`);
      await humanDelay(500, 800);
    }

    // ── 3. Milestones (fixed-price: description, due date, amount) ──
    if (options?.milestones?.length) {
      // First ensure we're in milestone mode
      await page.evaluate(() => {
        const radio = document.querySelector('input[name="milestoneMode"][value="milestone"]') as HTMLInputElement;
        if (radio && !radio.checked) radio.click();
      });
      await humanDelay(300, 500);

      for (let i = 0; i < options.milestones.length; i++) {
        const ms = options.milestones[i];

        // Need to add extra milestones beyond the first
        if (i > 0) {
          const addClicked = await page.evaluate(() => {
            const btns = document.querySelectorAll("button");
            for (const b of Array.from(btns)) {
              if (b.textContent?.toLowerCase().includes("add milestone")) {
                b.click();
                return true;
              }
            }
            return false;
          });
          if (addClicked) {
            await humanDelay(500, 800);
            logger.info(`[Browser/Upwork] Added milestone row ${i + 1}`);
          }
        }

        // Find all milestone description inputs (text inputs in milestone rows)
        // Milestone rows: each has Description (text), Due date (button), Amount (text with $)
        const descFilled = await page.evaluate((idx: number, desc: string) => {
          // Get all visible text inputs that are in the milestone section
          const milestoneSection = document.body.innerText.toLowerCase().includes("how many milestones");
          if (!milestoneSection) return false;

          // Description inputs: text inputs without $ placeholder
          const allInputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
          const descInputs = allInputs.filter(inp => {
            const input = inp as HTMLInputElement;
            if (input.type === "hidden") return false;
            const ph = input.placeholder || "";
            // Description inputs don't have $ or amount
            return !ph.includes("$") && !ph.includes("amount");
          });

          if (descInputs[idx]) {
            const el = descInputs[idx] as HTMLInputElement;
            el.focus();
            el.value = desc;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
          }
          return false;
        }, i, ms.description);

        if (!descFilled) {
          // Fallback: type into nth description-like input
          const descInputs = await page.$$('input[type="text"]:not([placeholder*="$"])');
          if (descInputs[i]) {
            await descInputs[i].focus();
            await page.keyboard.down("Control");
            await page.keyboard.press("a");
            await page.keyboard.up("Control");
            await page.keyboard.type(ms.description, { delay: 15 });
          }
        }

        // Amount input: inputs with $ placeholder
        const amtFilled = await page.evaluate((idx: number, amt: number) => {
          const amtInputs = Array.from(document.querySelectorAll('input')).filter(inp => {
            return inp.placeholder?.includes("$") || inp.id?.includes("milestone-amount");
          });
          if (amtInputs[idx]) {
            const el = amtInputs[idx] as HTMLInputElement;
            el.focus();
            el.select();
            el.value = String(amt);
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
          }
          return false;
        }, i, ms.amount);

        if (!amtFilled) {
          // Fallback: find by milestone-amount id pattern
          const amtInput = await page.$(`#milestone-amount-${i + 1}`);
          if (amtInput) {
            await amtInput.focus();
            await page.keyboard.down("Control");
            await page.keyboard.press("a");
            await page.keyboard.up("Control");
            await page.keyboard.type(String(ms.amount), { delay: 30 });
          }
        }

        // Due date (optional): click the date picker button, type date
        if (ms.dueDate) {
          const dateBtns = await page.$$('button[data-test="button"]');
          if (dateBtns[i]) {
            await dateBtns[i].click();
            await humanDelay(300, 500);
            // Type date into whatever input appears
            await page.keyboard.type(ms.dueDate, { delay: 30 });
            await page.keyboard.press("Enter");
            await humanDelay(300, 500);
          }
        }

        logger.info(`[Browser/Upwork] Milestone ${i + 1}: "${ms.description}" $${ms.amount}${ms.dueDate ? ` due ${ms.dueDate}` : ""}`);
        await humanDelay(300, 500);
      }

      // Verify total
      const total = await page.evaluate(() => {
        const text = document.body.innerText;
        const match = text.match(/Total price of project\s*\$?([\d,.]+)/i);
        return match ? match[1] : "";
      });
      if (total) logger.info(`[Browser/Upwork] Total project price: $${total}`);
    }

    // ── 4. Hourly rate (for hourly jobs) ───────────────
    if (options?.hourlyRate) {
      const rateInput = await page.$('input[aria-label*="rate" i]') || await page.$('input[data-test*="rate"]');
      if (rateInput) {
        await rateInput.focus();
        await page.keyboard.down("Control");
        await page.keyboard.press("a");
        await page.keyboard.up("Control");
        await page.keyboard.type(String(options.hourlyRate), { delay: 40 });
        logger.info(`[Browser/Upwork] Set hourly rate: $${options.hourlyRate}/hr`);
      }
      await humanDelay(300, 500);
    }

    // ── 5. Duration dropdown (custom combobox) ─────────
    if (options?.duration) {
      logger.info(`[Browser/Upwork] Setting duration: ${options.duration}`);
      // Upwork uses a custom combobox for duration, not a native <select>
      const opened = await page.evaluate(() => {
        const combos = document.querySelectorAll('[role="combobox"]');
        for (const c of Array.from(combos)) {
          const parent = c.closest("div, section");
          const txt = parent?.textContent?.toLowerCase() || "";
          if (txt.includes("how long") || txt.includes("duration") || txt.includes("project take")) {
            (c as HTMLElement).click();
            return true;
          }
        }
        return false;
      });

      if (opened) {
        await humanDelay(500, 800);
        const selected = await page.evaluate((dur: string) => {
          const items = document.querySelectorAll('[role="option"], li[id]');
          for (const item of Array.from(items)) {
            if (item.textContent?.toLowerCase().includes(dur.toLowerCase())) {
              (item as HTMLElement).click();
              return item.textContent?.trim() || "";
            }
          }
          return "";
        }, options.duration);
        if (selected) {
          logger.info(`[Browser/Upwork] Duration set: "${selected}"`);
        } else {
          // Log available options for debugging
          const opts = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('[role="option"], li[id]'))
              .map(el => el.textContent?.trim())
              .filter(Boolean);
          });
          logger.warn(`[Browser/Upwork] Duration "${options.duration}" not found. Available: ${opts.join(", ")}`);
        }
      } else {
        logger.warn("[Browser/Upwork] Duration combobox not found");
      }
      await humanDelay(300, 500);
    }

    // ── 6. Cover letter ────────────────────────────────
    const coverSelectors = [
      'textarea[data-test="cover-letter"]',
      'textarea[aria-label*="cover" i]',
      'textarea[placeholder*="cover" i]',
      "textarea",
    ];
    for (const sel of coverSelectors) {
      const textarea = await page.$(sel);
      if (textarea) {
        await textarea.focus();
        await page.keyboard.down("Control");
        await page.keyboard.press("a");
        await page.keyboard.up("Control");
        await humanDelay(200, 400);
        // Type with human-like variable delay
        await page.keyboard.type(coverLetter, { delay: 5 + Math.random() * 10 });
        logger.info(`[Browser/Upwork] Cover letter: ${coverLetter.length} chars via ${sel}`);
        break;
      }
    }
    await humanDelay(500, 800);

    // ── 7. Screening questions ─────────────────────────
    if (options?.answerQuestions && Object.keys(options.answerQuestions).length > 0) {
      const questionBlocks = await page.$$('[data-test*="question"], [class*="question"], fieldset');
      for (const block of questionBlocks) {
        const qText = await block.evaluate(el => el.textContent?.trim().slice(0, 300) || "");
        for (const [question, answer] of Object.entries(options.answerQuestions)) {
          if (qText.toLowerCase().includes(question.toLowerCase())) {
            const input = await block.$("textarea, input[type='text']");
            if (input) {
              await input.focus();
              await page.keyboard.type(answer, { delay: 12 });
              logger.info(`[Browser/Upwork] Answered: "${question.slice(0, 50)}..."`);
            }
            break;
          }
        }
      }
      await humanDelay(500, 800);
    }

    // ── 8. Attachments ─────────────────────────────────
    if (options?.attachments?.length) {
      const fileInput = await page.$('input[type="file"]');
      if (fileInput) {
        await fileInput.uploadFile(...options.attachments);
        logger.info(`[Browser/Upwork] Attached ${options.attachments.length} file(s)`);
        await humanDelay(1000, 2000);
      }
    }

    // ── 9. Boost proposal (connects bidding) ───────────
    if (options?.boostConnects && options.boostConnects > 0) {
      // The boost section has a number input for extra connects and a "Set bid" button
      const boostInput = await page.$('input[type="number"]');
      if (boostInput) {
        await boostInput.focus();
        await page.keyboard.down("Control");
        await page.keyboard.press("a");
        await page.keyboard.up("Control");
        await humanDelay(200, 300);
        await page.keyboard.type(String(options.boostConnects), { delay: 40 });
        logger.info(`[Browser/Upwork] Boost bid: ${options.boostConnects} connects`);

        // Click "Set bid" button
        const setBidClicked = await page.evaluate(() => {
          const btns = document.querySelectorAll("button");
          for (const b of Array.from(btns)) {
            if (b.textContent?.trim().toLowerCase() === "set bid") {
              b.click();
              return true;
            }
          }
          return false;
        });
        if (setBidClicked) {
          logger.info("[Browser/Upwork] Clicked 'Set bid' for boost");
          await humanDelay(500, 800);
        }

        // Log the connects summary
        const summary = await page.evaluate(() => {
          const text = document.body.innerText;
          const bidToBoost = text.match(/Bid to boost:\s*(\d+\s*Connects)/i);
          const required = text.match(/Required for proposal:\s*(\d+\s*Connects)/i);
          const total = text.match(/Total:\s*(\d+\s*Connects)/i);
          return {
            boost: bidToBoost?.[1] || "",
            required: required?.[1] || "",
            total: total?.[1] || "",
          };
        });
        if (summary.total) {
          logger.info(`[Browser/Upwork] Connects: boost=${summary.boost}, required=${summary.required}, total=${summary.total}`);
        }
      }
    }

    await page.screenshot({ path: "debug-proposal-filled.png" }).catch(() => {});

    // ── DRY RUN — stop here ────────────────────────────
    if (options?.dryRun) {
      // Log final form summary
      const finalInfo = await page.evaluate(() => {
        const text = document.body.innerText;
        return {
          totalPrice: (text.match(/Total price of project\s*\$?([\d,.]+)/i) || [])[1] || "",
          youReceive: (text.match(/You.ll Receive[\s\S]*?\$([\d,.]+)/i) || [])[1] || "",
          connectsTotal: (text.match(/Total:\s*(\d+\s*Connects)/i) || [])[1] || "",
          submitBtn: (text.match(/(Send for \d+ Connects)/i) || [])[1] || "",
        };
      });
      logger.info(`[Browser/Upwork] DRY RUN COMPLETE — total=$${finalInfo.totalPrice || "?"}, receive=$${finalInfo.youReceive || "?"}, ${finalInfo.connectsTotal || "? connects"}`);
      logger.info(`[Browser/Upwork] Submit button: "${finalInfo.submitBtn}"`);
      return true;
    }

    // ── Submit ─────────────────────────────────────────
    let submitted = false;
    // Primary: find the green "Send for X Connects" button
    submitted = await page.evaluate(() => {
      const btns = document.querySelectorAll("button");
      for (const b of Array.from(btns)) {
        const t = b.textContent?.trim().toLowerCase() || "";
        if (t.includes("send for") && t.includes("connects") && !b.disabled) {
          b.click();
          return true;
        }
      }
      return false;
    });
    if (submitted) {
      logger.info("[Browser/Upwork] Clicked 'Send for X Connects'");
    } else {
      // Fallback selectors
      for (const sel of ['button[data-test="submit-proposal"]', 'button[type="submit"]']) {
        const btn = await page.$(sel);
        if (btn) {
          const vis = await page.evaluate((el: Element) => el.getBoundingClientRect().width > 0, btn);
          if (vis) { await btn.click(); submitted = true; break; }
        }
      }
    }

    await humanDelay(3000, 5000);
    await page.screenshot({ path: "debug-proposal-submitted.png" }).catch(() => {});

    const resultText = await page.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => "");
    if (resultText.includes("submitted") || resultText.includes("Proposal sent") || resultText.includes("Success")) {
      logger.info("[Browser/Upwork] Proposal submitted successfully!");
      return true;
    }

    logger.warn(`[Browser/Upwork] Submission status unclear — URL: ${page.url()}`);
    return true;
  } catch (e) {
    logger.error(`[Browser/Upwork] submitProposal error: ${(e as Error).message}`);
    return false;
  }
}
