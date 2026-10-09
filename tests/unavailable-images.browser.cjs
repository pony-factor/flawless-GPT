const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

test('recover only source-backed mascot images; retain failed placeholders and restore on stop', async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
  const page = await browser.newPage();
  try {
    await page.route('https://mascots.pone.voyage/**', route => {
      if (route.request().url().includes('image01')) return route.abort();
      return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') });
    });
    const row = (id, name) => `<div data-d-component="row"><div id="${id}" role="img" aria-label="Image unavailable" style="width:112px;height:112px"><svg></svg></div><p>${name} — Description</p></div>`;
    await page.setContent(`<div data-dil-message-id="1"><a href="https://mascots.pone.voyage/">Source</a>${row('clipper', 'Clipper Ship')}${row('treasure', 'Treasure Trove')}${row('unknown', 'Other Pony')}</div><div data-dil-message-id="2">${row('uncited', 'Sunkissed')}</div>`);
    await page.evaluate(() => {
      window.active = true;
      window.__ghrcExtensionContext = { active: () => window.active, onStop: fn => { window.stop = fn; } };
      window.chrome = { runtime: { sendMessage: async () => ({ ok: true, url: 'https://mascots.pone.voyage/', html: '<section><h2>Clipper Ship</h2><img data-src="assets/images/image02.png"><img src="symbol.png"></section><section><h2>Treasure Trove</h2><img src="assets/images/image01.png"></section>' }) } };
    });
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../js/unavailable-images.js'), 'utf8') });
    await page.waitForFunction(() => document.querySelector('#clipper').getAttribute('aria-label') === 'Clipper Ship');
    await page.waitForFunction(() => !document.querySelector('#treasure img'));
    assert.equal(await page.locator('#clipper img').evaluate(img => img.naturalWidth), 1);
    assert.equal(await page.locator('#treasure').getAttribute('aria-label'), 'Image unavailable');
    assert.equal(await page.locator('#unknown img, #uncited img').count(), 0);
    await page.evaluate(() => { window.active = false; window.stop(); });
    assert.equal(await page.locator('#clipper img').count(), 0);
    assert.equal(await page.locator('#clipper').getAttribute('aria-label'), 'Image unavailable');
    assert.equal(await page.locator('#clipper svg').evaluate(icon => icon.style.display), '');
  } finally { await browser.close(); }
});

test('recover arbitrary captions and original proxy URLs without replacing healthy or ambiguous images', async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
  const page = await browser.newPage();
  try {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
    await page.route('https://pictures.example/**', route => route.fulfill({ contentType: 'image/png', body: png }));
    await page.route('https://proxy.example/**', route => route.fulfill({ status: 404, body: '' }));
    const row = (id, label) => `<div data-d-component="row"><div id="${id}" role="img" aria-label="Image unavailable"><svg></svg></div><p><strong>${label}</strong> — Description</p></div>`;
    await page.setContent(`<div data-dil-message-id="arbitrary"><a href="https://catalog.example/photos/">Source</a>${row('garden', 'Moon Garden')}${row('ambiguous', 'Blue Lake')}<img id="proxy" alt="Original photo" width="112" height="112" src="https://proxy.example/image?url=https%3A%2F%2Fpictures.example%2Foriginal.png"><img id="healthy" src="https://pictures.example/healthy.png"></div>`);
    await page.evaluate(() => {
      window.calls = 0;
      window.active = true;
      window.__ghrcExtensionContext = { active: () => window.active, onStop: fn => { window.stop = fn; } };
      window.chrome = { runtime: { sendMessage: async () => {
        window.calls++;
        return { ok: true, url: 'https://pictures.example/catalog/', html: '<img alt="Moon Garden" src="../garden.png"><img alt="Blue Lake" src="lake1.png"><img alt="Blue Lake" src="lake2.png">' };
      } } };
    });
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../js/unavailable-images.js'), 'utf8') });
    await page.waitForFunction(() => document.querySelector('#garden img')?.naturalWidth === 1 && document.querySelector('#proxy').style.visibility === 'hidden');
    assert.equal(await page.locator('#garden img').getAttribute('src'), 'https://pictures.example/garden.png');
    assert.equal(await page.locator('#ambiguous img').count(), 0);
    assert.equal(await page.locator('#healthy').evaluate(img => img.style.visibility), '');
    assert.equal(await page.evaluate(() => window.calls), 1);
    assert.equal(await page.locator('#proxy').evaluate(img => img.parentElement.querySelector('img:last-child').src), 'https://pictures.example/original.png');
    await page.evaluate(() => { window.active = false; window.stop(); });
    assert.equal(await page.locator('#proxy').evaluate(img => img.style.visibility), '');
  } finally { await browser.close(); }
});

test('recover original image URLs from image renderer metadata', async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent('<div id="image" role="img" aria-label="Image unavailable"></div>');
    await page.evaluate(() => {
      document.querySelector('#image').__reactFiber$fixture = { memoizedProps: {}, return: { memoizedProps: { resetKey: { props: { src: 'https://pictures.example/renderer.png' } } } } };
    });
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../js/image-recovery-main.js'), 'utf8') });
    await page.evaluate(() => document.querySelector('#image').dispatchEvent(new Event('ghrc-resolve-image-source', { bubbles: true })));
    assert.equal(await page.locator('#image').getAttribute('data-ghrc-original-image'), 'https://pictures.example/renderer.png');
  } finally { await browser.close(); }
});
