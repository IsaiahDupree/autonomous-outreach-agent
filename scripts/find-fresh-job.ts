/**
 * scripts/find-fresh-job.ts — finds a still-live Upwork job URL using the user's headed Chrome.
 *
 * Used by the smoke-dry-run flow to seed a guaranteed-fresh proposal candidate, since scraped
 * jobs from cron scans can expire between the scrape and the dry-run.
 *
 * Run: npx ts-node scripts/find-fresh-job.ts [keyword]
 *   eg: npx ts-node scripts/find-fresh-job.ts "AI automation"
 */
import puppeteer, { type Browser, type Page } from "puppeteer";

const KEYWORD = process.argv[2] || "AI automation";
const CDP_URL = "http://127.0.0.1:9223";

async function main() {
  const browser: Browser = await puppeteer.connect({
    browserURL: CDP_URL,
    defaultViewport: null,
  } as any);

  const pages = await browser.pages();
  let page: Page = pages.find(p => p.url().includes("upwork.com")) || await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 }).catch(() => {});

  const searchUrl = `https://www.upwork.com/nx/search/jobs/?sort=recency&q=${encodeURIComponent(KEYWORD)}`;
  console.log(`Searching: ${searchUrl}`);

  await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 30000 });
  await new Promise(r => setTimeout(r, 4000));

  // Pull the first 5 job tile links — Upwork uses `a[href^="/jobs/"]` with title/byline structure
  const jobs = await page.evaluate(() => {
    const tiles = Array.from(document.querySelectorAll('article')) as HTMLElement[];
    const out: Array<{ id: string; url: string; title: string; budget: string; posted: string }> = [];
    for (const tile of tiles.slice(0, 5)) {
      const link = tile.querySelector('a[href*="/jobs/"]') as HTMLAnchorElement | null;
      if (!link) continue;
      const href = link.href;
      const idMatch = href.match(/~(\w+)/);
      if (!idMatch) continue;
      const title = (link.textContent || "").trim().slice(0, 100);
      const budgetEl = tile.querySelector('[data-test*="budget"]') || tile.querySelector('[class*="budget"]');
      const postedEl = tile.querySelector('[data-test*="posted"]') || tile.querySelector('[class*="posted"]');
      out.push({
        id: idMatch[1],
        url: href.split("?")[0],
        title,
        budget: ((budgetEl?.textContent) || "").trim().slice(0, 50),
        posted: ((postedEl?.textContent) || "").trim().slice(0, 50),
      });
    }
    return out;
  });

  if (jobs.length === 0) {
    console.error("No jobs scraped from search page. Possible Cloudflare or DOM change.");
    process.exit(1);
  }

  console.log(`\nFound ${jobs.length} fresh jobs:\n`);
  for (const j of jobs) {
    console.log(`  ${j.id}`);
    console.log(`    url:    ${j.url}`);
    console.log(`    title:  ${j.title}`);
    console.log(`    budget: ${j.budget || "—"}`);
    console.log(`    posted: ${j.posted || "—"}\n`);
  }

  // Print the top one in a parseable format for shell pipelines
  console.log(`TOP_JOB_ID=${jobs[0].id}`);
  console.log(`TOP_JOB_URL=${jobs[0].url}`);
  console.log(`TOP_JOB_TITLE=${jobs[0].title}`);

  await browser.disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
