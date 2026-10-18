const p = require('puppeteer-core');
(async()=>{
  const b = await p.connect({browserURL:'http://127.0.0.1:9223',defaultViewport:null});
  const pages = await b.pages();
  const pg = pages.find(x=>x.url().includes('apply')) || pages[pages.length-1];
  // Check each text input with broader parent context
  const inputs = await pg.evaluate(()=>{
    return Array.from(document.querySelectorAll('input[type="text"]')).map((el,i)=>{
      // Walk up to find containing section text
      let section = el.closest('section') || el.closest('[class*="card"]') || el.closest('[class*="terms"]');
      let container = el;
      for (let j = 0; j < 8; j++) {
        container = container.parentElement;
        if (!container) break;
        const text = container.textContent?.trim() || '';
        if (text.length > 20) {
          return {
            i, value: el.value,
            containerTag: container.tagName,
            containerCls: container.className?.toString()?.slice(0, 40),
            containerText: text.slice(0, 120),
            depth: j
          };
        }
      }
      return { i, value: el.value, containerText: 'not found' };
    });
  });
  inputs.forEach(i=>console.log(JSON.stringify(i)));
  await b.disconnect();
})();
