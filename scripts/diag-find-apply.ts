/**
 * scripts/diag-find-apply.ts — sniff the actual Upwork apply-button selector.
 *
 * Hits a fresh job page (via real click), then enumerates all buttons + apply-related anchors
 * with their attributes so we can update the agent's submitProposal selector list.
 */
import puppeteer, { type Browser, type Page } from "puppeteer";

const KEYWORD = process.argv[2] || "AI automation";
const CDP_URL = "http://127.0.0.1:9223";

async function main() {
  const browser: Browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null } as any);
  const pages = await browser.pages();
  let page: Page = pages.find(p => p.url().includes("upwork.com")) || await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 }).catch(() => {});

  // Navigate to search → click first tile (works per previous diag)
  await page.goto(`https://www.upwork.com/nx/search/jobs/?sort=recency&q=${encodeURIComponent(KEYWORD)}`, { waitUntil: "networkidle2", timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {}),
    page.evaluate(() => {
      const tile = document.querySelector('article a[href*="/jobs/"]') as HTMLAnchorElement | null;
      tile?.click();
    }),
  ]);
  await new Promise(r => setTimeout(r, 4000));
  console.log(`URL after click: ${page.url()}`);

  // Enumerate everything that contains "Apply" or looks like a submit button
  const findings = await page.evaluate(() => {
    const out: Array<{ tag: string; text: string; attrs: Record<string, string>; visible: boolean }> = [];
    const all = Array.from(document.querySelectorAll('button, a')) as HTMLElement[];
    for (const el of all) {
      const text = (el.textContent || "").trim().slice(0, 80);
      const lower = text.toLowerCase();
      if (!lower.includes("apply") && !lower.includes("submit a proposal")) continue;
      const attrs: Record<string, string> = {};
      for (const a of Array.from(el.attributes)) attrs[a.name] = a.value.slice(0, 100);
      const visible = !!(el.offsetParent || el.getClientRects().length > 0);
      out.push({ tag: el.tagName.toLowerCase(), text, attrs, visible });
    }
    return out;
  });

  console.log(`\nFound ${findings.length} apply/submit-like elements:\n`);
  for (const f of findings) {
    console.log(`  <${f.tag}> "${f.text}" visible=${f.visible}`);
    for (const [k, v] of Object.entries(f.attrs)) {
      console.log(`    ${k}="${v}"`);
    }
    console.log();
  }

  // Also surface useful selectors observed
  const selectors = await page.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll('[data-test]').forEach(el => {
      const dt = el.getAttribute('data-test') || '';
      if (dt.toLowerCase().includes('apply') || dt.toLowerCase().includes('submit')) {
        out.push(`[data-test="${dt}"] (${el.tagName.toLowerCase()})`);
      }
    });
    return out.slice(0, 20);
  });
  console.log(`\ndata-test attrs containing "apply" or "submit":`);
  selectors.forEach(s => console.log(`  ${s}`));

  await browser.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
