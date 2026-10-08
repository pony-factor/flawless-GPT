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
  await page.setContent('<style>body{margin:0}aside{position:fixed;left:0;top:0;width:260px;height:100vh;background:#eee}svg{width:24px;height:24px}button{display:flex;align-items:center}</style><aside><button aria-label="Show sidebar" onclick="window.sidebarClicks=(window.sidebarClicks||0)+1"><svg></svg></button><button aria-label="New chat" onclick="window.newChats=(window.newChats||0)+1"><svg></svg><span>New chat</span></button><p>ChatGPT</p></aside><main></main>');
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

test('Flawless image replaces the OpenAI logo while preserving native actions', async () => {
  const page = await fixture();
  const button = page.getByRole('button', { name: 'Show sidebar', exact: true });
  const image = button.locator('.ghrc-flawless-logo-image');
  assert.equal(await image.count(), 1);
  assert.match(await image.getAttribute('src'), /artwork\/squeaky-belle-full\.webp$/);
  assert.equal(await button.locator('svg').isVisible(), false);
  assert.equal(await page.getByRole('button', { name: 'New chat', exact: true }).locator('svg').isVisible(), true);
  const bounds = await image.boundingBox();
  assert.equal(bounds.width, 33);
  assert.equal(bounds.height, 33);
  assert.deepEqual(await button.evaluate(element => {
    const style = getComputedStyle(element);
    return [style.padding, style.borderWidth];
  }), ['0px', '0px']);
  await image.click();
  assert.equal(await page.evaluate(() => window.sidebarClicks), 1);
  await page.evaluate(() => document.querySelector('button[aria-label="Show sidebar"]').innerHTML = '<svg></svg>');
  await page.waitForFunction(() => !!document.querySelector('.ghrc-flawless-logo-image'));
  assert.equal(await image.count(), 1);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('native icons return when the extension stops', async () => {
  const page = await fixture();
  await page.evaluate(() => {
    chrome.runtime = undefined;
    __ghrcExtensionContext.active();
  });
  assert.equal(await page.locator('.ghrc-flawless-logo-image').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Show sidebar', exact: true }).locator('svg').isVisible(), true);
  assert.deepEqual(page.errors, []);
  await page.close();
});
