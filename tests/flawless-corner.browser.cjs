const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
let browser;

before(async () => {
  browser = await chromium.launch({
    executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    headless: true,
  });
});
after(async () => { await browser?.close(); });

async function fixture() {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.errors = [];
  page.on('pageerror', error => page.errors.push(error.message));
  await page.setContent('<style>body{margin:0}aside{position:fixed;left:0;top:0;width:260px;height:100vh;background:#eee}</style><aside><button aria-label="New chat">New chat</button><p>ChatGPT</p></aside><main></main>');
  await page.evaluate(() => {
    window.chrome = {
      runtime: { id: 'fixture', getURL: file => 'chrome-extension://fixture/' + file },
      storage: { local: {} },
    };
  });
  await page.addStyleTag({ content: read('css/flawless-corner.css') });
  await page.addScriptTag({ content: read('js/extension-context.js') });
  await page.addScriptTag({ content: read('js/flawless-corner.js') });
  return page;
}

test('mascot corner is a compact flush square and links to New chat', async () => {
  const page = await fixture();
  const card = page.locator('#ghrc-flawless-corner');
  assert.equal(await card.count(), 1);
  assert.equal(await card.getAttribute('href'), '/');
  assert.equal(await card.getAttribute('aria-label'), 'New chat');
  assert.match(await card.locator('img').getAttribute('src'), /artwork\/squeaky-belle-full\.webp$/);
  const bounds = await card.boundingBox();
  assert.deepEqual(bounds, { x: 0, y: 0, width: 52, height: 52 });
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('ghrc-flawless-corner')).borderTopLeftRadius), '0px');
  await page.evaluate(() => document.getElementById('ghrc-flawless-corner').remove());
  await page.waitForFunction(() => !!document.getElementById('ghrc-flawless-corner'));
  assert.equal(await card.count(), 1);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('corner stays within narrow viewports and cleans up with extension', async () => {
  const page = await fixture();
  await page.setViewportSize({ width: 320, height: 600 });
  const bounds = await page.locator('#ghrc-flawless-corner').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 320);
  assert.deepEqual(bounds, { x: 0, y: 0, width: 52, height: 52 });
  await page.evaluate(() => {
    chrome.runtime = undefined;
    __ghrcExtensionContext.active();
  });
  assert.equal(await page.locator('#ghrc-flawless-corner').count(), 0);
  assert.deepEqual(page.errors, []);
  await page.close();
});
