const p = require('puppeteer-core');
(async()=>{
  const b = await p.connect({browserURL:'http://127.0.0.1:9223',defaultViewport:null});
  const pages = await b.pages();
  const pg = pages.find(x=>x.url().includes('apply')) || pages[pages.length-1];
  const inputs = await pg.evaluate(()=>{
    return Array.from(document.querySelectorAll('input')).filter(i => {
      return i.type !== 'hidden' && i.type !== 'checkbox' && i.type !== 'radio' && i.type !== 'file';
    }).map((el,i)=>({
      i, type:el.type, value:el.value,
      label: (el.getAttribute('aria-label') || '').slice(0,40),
      name: el.name,
      parentText: (el.closest('div')?.textContent || '').trim().slice(0,80)
    }));
  });
  inputs.forEach(i=>console.log(JSON.stringify(i)));
  await b.disconnect();
})();
