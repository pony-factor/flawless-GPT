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
