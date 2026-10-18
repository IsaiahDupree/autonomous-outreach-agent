/**
 * scripts/diag-click-flow.ts — mimics a real user click flow.
 *
 * Goes to search → clicks the first job tile (real anchor element) → reports the resulting URL
 * and body markers. If THIS produces a working job page, then bare /jobs/~ID URLs are the bug
 * and the agent should follow human navigation patterns instead.
 */
import puppeteer, { type Browser, type Page } from "puppeteer";

const KEYWORD = process.argv[2] || "AI automation";
const CDP_URL = "http://127.0.0.1:9223";

const MARKERS = ["Posted", "Budget", "Description", "Apply", "Submit a Proposal", "Hourly", "Fixed-price"];

async function probe(page: Page) {
  return await page.evaluate((markers: string[]) => {
    const text = document.body?.innerText || "";
    return {
      url: location.href,
      title: document.title,
      bodyLen: text.length,
      markersHit: markers.filter(m => text.includes(m)),
      hasApplyButton: !!document.querySelector('button[data-test="apply-button"]') || !!document.querySelector('a[href*="proposals/job"]'),
      preview: text.slice(0, 300).replace(/\s+/g, " "),
    };
  }, MARKERS);
}

async function main() {
  const browser: Browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null } as any);
  const pages = await browser.pages();
  let page: Page = pages.find(p => p.url().includes("upwork.com")) || await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 }).catch(() => {});

  // Step 1 — search
  const searchUrl = `https://www.upwork.com/nx/search/jobs/?sort=recency&q=${encodeURIComponent(KEYWORD)}`;
  console.log(`[1] Goto: ${searchUrl}`);
  await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));
  const search = await probe(page);
  console.log(`    body=${search.bodyLen}, markersHit=${search.markersHit.length}, url=${search.url.slice(0, 80)}`);

  // Step 2 — find the first valid job link
  const firstJobHref = await page.evaluate(() => {
    const tiles = Array.from(document.querySelectorAll('article'));
    for (const t of tiles) {
      const link = t.querySelector('a[href*="/jobs/"]') as HTMLAnchorElement | null;
      if (link && link.href.includes("~")) return link.href;
    }
    return null;
  });
  console.log(`[2] Found first tile href: ${firstJobHref?.slice(0, 110) || "(none)"}`);
  if (!firstJobHref) {
    await browser.disconnect();
    process.exit(1);
  }

  // Step 3 — click it (real DOM click, not navigation)
  console.log(`[3] Clicking the tile (real click via JS) ...`);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {}),
    page.evaluate(() => {
      const tiles = Array.from(document.querySelectorAll('article'));
      for (const t of tiles) {
        const link = t.querySelector('a[href*="/jobs/"]') as HTMLAnchorElement | null;
        if (link && link.href.includes("~")) { link.click(); return; }
      }
    }),
  ]);
  await new Promise(r => setTimeout(r, 4000));
  const clicked = await probe(page);
  console.log(`    afterClick: url=${clicked.url.slice(0, 100)}`);
  console.log(`    bodyLen=${clicked.bodyLen}  markersHit=[${clicked.markersHit.join(", ")}]  applyBtn=${clicked.hasApplyButton}`);
  console.log(`    preview: ${clicked.preview}`);

  // Step 4 — also try direct bare /jobs/~ID URL on a NEW tab to confirm the difference
  const idMatch = clicked.url.match(/~(\w+)/);
  if (idMatch) {
    const jobId = idMatch[1];
    const bareUrl = `https://www.upwork.com/jobs/~${jobId}`;
    console.log(`\n[4] Now trying bare URL on a new tab: ${bareUrl}`);
    const newTab = await browser.newPage();
    await newTab.setViewport({ width: 1366, height: 768 }).catch(() => {});
    await newTab.goto(bareUrl, { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise(r => setTimeout(r, 4000));
    const bare = await probe(newTab);
    console.log(`    afterGoto: url=${bare.url.slice(0, 100)}`);
    console.log(`    bodyLen=${bare.bodyLen}  markersHit=[${bare.markersHit.join(", ")}]  applyBtn=${bare.hasApplyButton}`);
    console.log(`    preview: ${bare.preview}`);
    await newTab.close().catch(() => {});
  }

  await browser.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
