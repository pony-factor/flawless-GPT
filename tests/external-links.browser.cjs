const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
let browser;
before(async () => {
  browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
});
after(async () => { await browser?.close(); });
async function fixture(settings = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: '<style>body{margin:0}main{width:100%;height:100vh}</style><main><a id="source" href="https://example.org/source?utm_source=chatgpt&keep=1#section">Source reference</a><a id="internal" href="/c/another">Another chat</a></main>' }));
  await page.route('https://example.org/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Source content</h1>' }));
  await page.goto('https://chatgpt.com/c/example');
  await page.evaluate(settings => {
    window.settingsListeners = [];
    window.openedLinks = [];
    window.copiedLinks = [];
    window.open = (...args) => openedLinks.push(args);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async value => copiedLinks.push(value) },
    });
    window.chrome = { storage: { local: { get: async defaults => ({ ...defaults, ...settings }) }, onChanged: { addListener: listener => settingsListeners.push(listener) } } };
  }, settings);
  await page.addStyleTag({ content: read('css/external-links.css') });
  await page.addScriptTag({ content: read('js/external-links.js') });
  return page;
}
test('default reference click opens a clean URL in a new tab and preserves chat', async () => {
  const page = await fixture();
  await page.locator('#source').click();
  assert.deepEqual(await page.evaluate(() => openedLinks), [['https://example.org/source?keep=1#section', '_blank', 'noopener,noreferrer']]);
  assert.equal(page.url(), 'https://chatgpt.com/c/example');
  await page.close();
});
test('split preview reserves space, loads the source, and restores layout and focus on Escape', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true });
  await page.locator('#source').click();
  await page.frameLocator('#ghrc-link-preview iframe').locator('h1').waitFor();
  assert.deepEqual(await page.evaluate(() => openedLinks), []);
  const main = await page.locator('main').boundingBox();
  const preview = await page.locator('#ghrc-link-preview').boundingBox();
  assert.ok(main.x + main.width <= preview.x + 1);
  const controls = page.locator('#ghrc-link-preview .ghrc-preview-control');
  assert.equal(await controls.nth(0).getAttribute('aria-label'), 'Copy link');
  assert.equal(await controls.nth(1).getAttribute('aria-label'), 'Open in new tab');
  await controls.nth(0).click();
  assert.deepEqual(await page.evaluate(() => copiedLinks), ['https://example.org/source?keep=1#section']);
  assert.equal(await page.locator('#ghrc-link-preview a').last().getAttribute('href'), 'https://example.org/source?keep=1#section');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#ghrc-link-preview').count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'source');
  assert.equal((await page.locator('main').boundingBox()).width, 1280);
  await page.close();
});
test('settings changes apply immediately and disabling split closes its frame', async () => {
  const page = await fixture();
  await page.evaluate(() => settingsListeners.forEach(fn => fn({ openExternalLinksInSplitView: { newValue: true } }, 'local')));
  await page.locator('#source').click();
  assert.equal(await page.locator('#ghrc-link-preview').count(), 1);
  await page.evaluate(() => settingsListeners.forEach(fn => fn({ openExternalLinksInSplitView: { newValue: false } }, 'local')));
  assert.equal(await page.locator('#ghrc-link-preview').count(), 0);
  await page.locator('#source').click();
  assert.equal(await page.evaluate(() => openedLinks.length), 1);
  await page.close();
});
