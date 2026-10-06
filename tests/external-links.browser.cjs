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
async function fixture(settings = {}, previewResponse = null) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: '<style>body{margin:0}main{width:100%;height:100vh}</style><main><a id="source" href="https://example.org/source?utm_source=chatgpt&keep=1#section">Source reference</a><a id="internal" href="/c/another">Another chat</a></main>' }));
  await page.route('https://example.org/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Source content</h1>' }));
  await page.goto('https://chatgpt.com/c/example');
  await page.evaluate(({ settings, previewResponse }) => {
    window.settingsListeners = [];
    window.runtimeListeners = [];
    window.previewRequests = [];
    window.openedLinks = [];
    window.copiedLinks = [];
    window.open = (...args) => openedLinks.push(args);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async value => copiedLinks.push(value) },
    });
    window.chrome = { runtime: { onMessage: { addListener: fn => runtimeListeners.push(fn) }, sendMessage: async message => { window.previewRequest = message; previewRequests.push(message); return previewResponse; } }, storage: { local: { get: async defaults => ({ ...defaults, ...settings }) }, onChanged: { addListener: listener => settingsListeners.push(listener) } } };
  }, { settings, previewResponse });
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

test('GitHub links request native split view without an embedded preview', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true }, { ok: true });
  await page.locator('#source').evaluate(link => { link.href = 'https://github.com/owner/repo/pull/42'; });
  await page.locator('#source').click();
  assert.deepEqual(await page.evaluate(() => previewRequest), { type: 'open-native-split-view', url: 'https://github.com/owner/repo/pull/42' });
  assert.equal(await page.locator('#ghrc-link-preview').count(), 0);
  assert.deepEqual(await page.evaluate(() => openedLinks), []);
  await page.close();
});
test('older browsers offer the actual GitHub link for native context-menu splitting', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true }, { ok: false, unavailable: true });
  await page.locator('#source').evaluate(link => { link.href = 'https://github.com/owner/repo/pull/42'; });
  await page.locator('#source').click();
  await page.locator('.ghrc-preview-content h2').waitFor();
  assert.match(await page.locator('.ghrc-preview-content').textContent(), /Open link in split view/);
  assert.equal(await page.locator('#ghrc-link-preview iframe').count(), 0);
  assert.equal(await page.locator('.ghrc-preview-content a').getAttribute('href'), 'https://github.com/owner/repo/pull/42');
  await page.getByRole('link', { name: 'Open in new tab' }).click();
  assert.deepEqual(await page.evaluate(() => openedLinks), [['https://github.com/owner/repo/pull/42', '_blank', 'noopener,noreferrer']]);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#ghrc-link-preview').count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'source');
  await page.close();
});

test('native split domain list is ignored when side view is disabled', async () => {
  const page = await fixture({ openExternalLinksInSplitView: false, nativeSplitViewDomains: ['github.com'] }, { ok: true });
  await page.locator('#source').evaluate(link => { link.href = 'https://github.com/owner/repo/pull/42'; });
  await page.locator('#source').click();
  assert.deepEqual(await page.evaluate(() => previewRequests), []);
  assert.equal(await page.locator('#ghrc-link-preview').count(), 0);
  assert.deepEqual(await page.evaluate(() => openedLinks), [['https://github.com/owner/repo/pull/42', '_blank', 'noopener,noreferrer']]);
  await page.close();
});
test('opt-in domain list includes subdomains but not similar unrelated domains', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true, nativeSplitViewDomains: ['example.org'] }, { ok: true });
  await page.locator('#source').evaluate(link => { link.href = 'https://docs.example.org/article'; });
  await page.locator('#source').click();
  assert.equal((await page.evaluate(() => previewRequest)).type, 'open-native-split-view');
  await page.locator('#source').evaluate(link => { link.href = 'https://notexample.org/article'; });
  await page.locator('#source').click();
  assert.equal((await page.evaluate(() => openedLinks))[0][0], 'https://notexample.org/article');
  await page.close();
});
test('blocked embedded previews fall back to native and stale errors are ignored', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true, nativeSplitViewDomains: [] }, { ok: true });
  await page.locator('#source').click();
  await page.frameLocator('#ghrc-link-preview iframe').locator('h1').waitFor();
  const watch = await page.evaluate(() => previewRequests.find(message => message.type === 'watch-link-preview'));
  await page.evaluate(watch => runtimeListeners.forEach(fn => fn({ type: 'link-preview-navigation-error', previewId: 'old', url: watch.url })), watch);
  assert.equal(await page.locator('#ghrc-link-preview iframe').count(), 1);
  await page.evaluate(watch => runtimeListeners.forEach(fn => fn({ type: 'link-preview-navigation-error', previewId: watch.previewId, url: watch.url })), watch);
  await page.waitForFunction(() => previewRequests.some(message => message.type === 'open-native-split-view'));
  assert.equal(await page.locator('#ghrc-link-preview').count(), 0);
  await page.close();
});
test('editing the opt-in list updates handling immediately and an empty list permits GitHub framing', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true }, { ok: true });
  await page.evaluate(() => settingsListeners.forEach(fn => fn({ nativeSplitViewDomains: { newValue: [] } }, 'local')));
  await page.locator('#source').evaluate(link => { link.href = 'https://github.com/owner/repo'; });
  await page.route('https://github.com/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Fixture page</h1>' }));
  await page.locator('#source').click();
  await page.frameLocator('#ghrc-link-preview iframe').locator('h1').waitFor();
  assert.equal((await page.evaluate(() => previewRequests))[0].type, 'watch-link-preview');
  await page.close();
});
