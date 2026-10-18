/**
 * scripts/diag-upwork-render.ts — diagnostic for "why does Upwork render blank under Puppeteer?"
 *
 * Connects via CDP to an existing Chrome on :9223. Tries 4 different navigation strategies
 * against the same job URL and reports body length + presence of job-page markers for each.
 *
 * Run:  npx ts-node scripts/diag-upwork-render.ts <jobUrl>
 *   eg: npx ts-node scripts/diag-upwork-render.ts https://www.upwork.com/jobs/~02047410531100392026
 */
import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, Page } from "puppeteer";

puppeteerExtra.use(StealthPlugin());

const JOB_URL = process.argv[2] || "https://www.upwork.com/jobs/~02047410531100392026";
const CDP_URL = "http://127.0.0.1:9223";
const WAIT_MS = 12000;

const c = {
  cyan:  (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red:   (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim:   (s: string) => `\x1b[2m${s}\x1b[0m`,
  yellow:(s: string) => `\x1b[33m${s}\x1b[0m`,
};

const MARKERS = ["Posted", "Budget", "Description", "Apply", "Submit a Proposal", "Hourly", "Fixed-price"];

interface Probe {
  bodyLen: number;
  title: string;
  url: string;
  markersHit: string[];
  hasApplyButton: boolean;
  hasLoginRedirect: boolean;
  bodyPreview: string;
}

async function probe(page: Page): Promise<Probe> {
  return await page.evaluate((markers) => {
    const text = document.body?.innerText || "";
    const url = location.href;
    return {
      bodyLen: text.length,
      title: document.title,
      url,
      markersHit: markers.filter(m => text.includes(m)),
      hasApplyButton: !!document.querySelector('button[data-test="apply-button"]') || !!document.querySelector('a[href*="proposals/job"]'),
      hasLoginRedirect: url.includes("/login") || text.includes("Log in to Upwork"),
      bodyPreview: text.slice(0, 400).replace(/\s+/g, " "),
    };
  }, MARKERS);
}

function report(name: string, p: Probe): void {
  const ok = p.hasApplyButton && p.markersHit.length >= 3;
  console.log((ok ? c.green : c.red)(`\n── ${name} ──`));
  console.log(`  url:           ${p.url.slice(0, 100)}`);
  console.log(`  title:         ${p.title}`);
  console.log(`  body length:   ${p.bodyLen}`);
  console.log(`  markers hit:   ${p.markersHit.length > 0 ? p.markersHit.join(", ") : c.dim("(none)")}`);
  console.log(`  apply button:  ${p.hasApplyButton ? c.green("YES") : c.red("NO")}`);
  console.log(`  login redirect:${p.hasLoginRedirect ? c.red(" YES") : c.green(" NO")}`);
  console.log(`  body preview:  ${c.dim(p.bodyPreview)}`);
}

async function main() {
  console.log(c.cyan(`Diagnostic: ${JOB_URL}`));
  console.log(c.dim(`Connecting to Chrome at ${CDP_URL}...`));

  // Use the regular puppeteer (not extra) for connect — Extra's launch hooks aren't applied to attach
  const puppeteer = (await import("puppeteer")).default;
  const browser: Browser = await puppeteer.connect({
    browserURL: CDP_URL,
    defaultViewport: null,
    protocolTimeout: 60_000,
  } as any);

  const pages = await browser.pages();
  const upworkTabs = pages.filter(p => p.url().includes("upwork.com"));
  console.log(c.dim(`Found ${pages.length} tabs total, ${upworkTabs.length} on upwork.com`));

  // ── Strategy A: REUSE the user's existing logged-in Upwork tab via page.goto ────────
  if (upworkTabs.length > 0) {
    const page = upworkTabs[0];
    await page.setViewport({ width: 1366, height: 768 }).catch(() => {});
    console.log(c.cyan("\n[A] Reuse existing tab + page.goto(networkidle2)"));
    try {
      await page.goto(JOB_URL, { waitUntil: "networkidle2", timeout: 25000 });
      await new Promise(r => setTimeout(r, WAIT_MS));
      report("A: existing tab + page.goto", await probe(page));
    } catch (e) {
      console.log(c.red(`  goto failed: ${(e as Error).message}`));
    }
  }

  // ── Strategy B: NEW tab + page.goto ────────────────────────────────────────────────
  console.log(c.cyan("\n[B] New tab via b.newPage() + page.goto(networkidle2)"));
  const pageB = await browser.newPage();
  await pageB.setViewport({ width: 1366, height: 768 }).catch(() => {});
  try {
    await pageB.goto(JOB_URL, { waitUntil: "networkidle2", timeout: 25000 });
    await new Promise(r => setTimeout(r, WAIT_MS));
    report("B: new tab + page.goto", await probe(pageB));
  } catch (e) {
    console.log(c.red(`  goto failed: ${(e as Error).message}`));
  }

  // ── Strategy C: NEW tab + window.location.href + waitForNavigation ────────────────
  console.log(c.cyan("\n[C] New tab + window.location.href = url + waitForNavigation"));
  const pageC = await browser.newPage();
  await pageC.setViewport({ width: 1366, height: 768 }).catch(() => {});
  try {
    await pageC.evaluate((u: string) => { window.location.href = u; }, JOB_URL);
    await pageC.waitForNavigation({ waitUntil: "networkidle2", timeout: 25000 }).catch(() => {});
    await new Promise(r => setTimeout(r, WAIT_MS));
    report("C: new tab + window.location", await probe(pageC));
  } catch (e) {
    console.log(c.red(`  failed: ${(e as Error).message}`));
  }

  // ── Strategy D: NEW tab + cookies copied from user's tab + page.goto ──────────────
  console.log(c.cyan("\n[D] New tab + copy cookies from user's tab + page.goto"));
  const pageD = await browser.newPage();
  await pageD.setViewport({ width: 1366, height: 768 }).catch(() => {});
  try {
    if (upworkTabs.length > 0) {
      const cookies = await upworkTabs[0].cookies().catch(() => []);
      console.log(c.dim(`  copied ${cookies.length} cookies`));
      if (cookies.length > 0) await pageD.setCookie(...cookies as any);
    }
    await pageD.goto(JOB_URL, { waitUntil: "networkidle2", timeout: 25000 });
    await new Promise(r => setTimeout(r, WAIT_MS));
    report("D: new tab + cookies + page.goto", await probe(pageD));
  } catch (e) {
    console.log(c.red(`  failed: ${(e as Error).message}`));
  }

  // Cleanup the spawned tabs (don't disturb user's tab)
  await pageB.close().catch(() => {});
  await pageC.close().catch(() => {});
  await pageD.close().catch(() => {});

  await browser.disconnect();
  console.log(c.cyan("\nDone — Chrome left running."));
}

main().catch(e => {
  console.error(c.red(`Unhandled: ${(e as Error).message}`));
  console.error(c.dim((e as Error).stack || ""));
  process.exit(1);
});
