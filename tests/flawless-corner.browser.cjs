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
  await page.setContent('<style>body{margin:0}aside{position:fixed;left:0;top:0;width:260px;height:100vh;background:#eee}svg{width:24px;height:24px}button{display:flex;align-items:center}button[aria-label="Show sidebar"]{position:absolute;left:7px;top:12px;width:44px;height:44px}</style><aside><button aria-label="Show sidebar" onclick="window.sidebarClicks=(window.sidebarClicks||0)+1"><svg></svg></button><button aria-label="New chat" onclick="window.newChats=(window.newChats||0)+1"><svg></svg><span>New chat</span></button><p>ChatGPT</p></aside><main></main>');
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

test('one mascot starts native New chat without opening the sidebar', async () => {
  const page = await fixture();
  const mascot = page.locator('#ghrc-flawless-corner');
  assert.equal(await mascot.count(), 1);
  assert.equal(await mascot.getAttribute('aria-label'), 'New chat');
  assert.match(await mascot.locator('img').getAttribute('src'), /artwork\/squeaky-belle-full\.webp$/);
  const bounds = await mascot.boundingBox();
  assert.equal(bounds.width, 33);
  assert.equal(bounds.height, 33);
  assert.deepEqual(bounds, { x: 13, y: 18, width: 33, height: 33 });
  // Recenter when ChatGPT changes sidebar padding or the control moves.
  await page.evaluate(() => {
    const button = document.querySelector('button[aria-label="Show sidebar"]');
    button.style.left = '27px';
    button.style.top = '30px';
    window.dispatchEvent(new Event('resize'));
  });
  assert.deepEqual(await mascot.boundingBox(), { x: 33, y: 36, width: 33, height: 33 });
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('ghrc-flawless-corner')).borderTopLeftRadius), '4px');
  assert.equal(await page.getByRole('button', { name: 'New chat', exact: true }).count(), 0);
  await mascot.click();
  assert.equal(await page.evaluate(() => window.newChats), 1);
  assert.equal(await page.evaluate(() => window.sidebarClicks || 0), 0);
  await page.evaluate(() => {
    document.querySelector('button[aria-label="Show sidebar"]').setAttribute('aria-label', 'Hide sidebar');
  });
  await page.waitForFunction(() => !document.querySelector('.ghrc-flawless-hidden-new-chat'));
  assert.equal(await mascot.count(), 1);
  await mascot.click();
  assert.equal(await page.evaluate(() => window.newChats), 2);
  await page.evaluate(() => document.getElementById('ghrc-flawless-corner').remove());
  await page.waitForFunction(() => !!document.getElementById('ghrc-flawless-corner'));
  assert.equal(await mascot.count(), 1);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('native controls return when extension stops', async () => {
  const page = await fixture();
  await page.setViewportSize({ width: 320, height: 600 });
  const bounds = await page.locator('#ghrc-flawless-corner').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 320);
  await page.evaluate(() => {
    chrome.runtime = undefined;
    __ghrcExtensionContext.active();
  });
  assert.equal(await page.locator('#ghrc-flawless-corner').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Show sidebar', exact: true }).locator('svg').isVisible(), true);
  assert.equal(await page.getByRole('button', { name: 'New chat', exact: true }).isVisible(), true);
  assert.deepEqual(page.errors, []);
  await page.close();
});
