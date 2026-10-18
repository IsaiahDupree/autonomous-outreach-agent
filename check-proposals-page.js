const puppeteer = require('puppeteer-core');

async function main() {
  let browser;
  try {
    browser = await puppeteer.connect({
      browserURL: 'http://127.0.0.1:9223',
      defaultViewport: null,
    });

    const pages = await browser.pages();
    // Find an existing upwork page or use first available
    let page = pages.find(p => p.url().includes('upwork.com')) || pages[0];

    console.log('Navigating to proposals page...');
    await page.goto('https://www.upwork.com/nx/proposals/', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Wait for content to load
    await new Promise(r => setTimeout(r, 3000));

    const title = await page.title();
    const url = await page.url();
    console.log('Page:', title);
    console.log('URL:', url);

    // Check if we hit Cloudflare
    if (title.includes('moment') || title.includes('Cloudflare')) {
      console.log('ERROR: Hit Cloudflare challenge on proposals page');
      return;
    }

    // Check if we need to login
    if (url.includes('login')) {
      console.log('ERROR: Not logged in — redirected to login page');
      return;
    }

    // Scrape proposal cards/rows
    const proposals = await page.evaluate(() => {
      const results = [];

      // Try various selectors for proposal items
      const selectors = [
        '[data-test="ProposalTile"]',
        '.proposal-tile',
        'article',
        '.up-card-section',
        'tr[data-test]',
        '.air3-card-section',
        '[class*="proposal"]',
        '[class*="Proposal"]',
      ];

      let items = [];
      for (const sel of selectors) {
        items = document.querySelectorAll(sel);
        if (items.length > 0) {
          console.log('Found with selector:', sel, items.length);
          break;
        }
      }

      if (items.length === 0) {
        // Fallback: get all text content from main area
        const main = document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
        return { raw: main.innerText.slice(0, 5000), selectors_tried: selectors };
      }

      items.forEach((item, i) => {
        if (i >= 30) return;
        const text = item.innerText || '';
        const links = Array.from(item.querySelectorAll('a')).map(a => ({
          text: a.innerText.trim().slice(0, 80),
          href: a.href,
        }));
        results.push({
          text: text.slice(0, 300),
          links: links.slice(0, 3),
        });
      });

      return { items: results, count: items.length };
    });

    console.log('\n=== PROPOSALS PAGE DATA ===');
    console.log(JSON.stringify(proposals, null, 2));

  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    if (browser) browser.disconnect();
  }
}

main();
