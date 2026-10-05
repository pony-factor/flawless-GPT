const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
let browser;
before(async () => {
  browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
});
after(async () => { await browser?.close(); });

async function fixture({ enabled = true, label = 'Work with ChatGPT', ignoreFirstClick = false } = {}) {
  const page = await browser.newPage();
  await page.setContent('<div><button id="chat" aria-pressed="false">Chat</button><button id="work" aria-pressed="true">Work</button></div><textarea id="composer">Unsent draft</textarea><button id="ordinary">Work on a document</button>');
  await page.evaluate(({ enabled, label, ignoreFirstClick }) => {
    window.listeners = [];
    window.chrome = { storage: { local: { get: async defaults => ({ ...defaults, disableWorkMode: enabled }) }, onChanged: { addListener: fn => window.listeners.push(fn) } } };
    const chat = document.getElementById('chat');
    const work = document.getElementById('work');
    const composer = document.getElementById('composer');
    composer.setAttribute('aria-label', label);
    window.clicks = 0;
    chat.onclick = () => {
      window.clicks++;
      if (ignoreFirstClick && window.clicks === 1) return;
      chat.setAttribute('aria-pressed', 'true');
      work.setAttribute('aria-pressed', 'false');
      composer.setAttribute('aria-label', 'Ask ChatGPT');
    };
  }, { enabled, label, ignoreFirstClick });
  await page.addStyleTag({ content: fs.readFileSync(path.join(__dirname, '../css/work-mode.css'), 'utf8') });
  await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../js/disable-work-mode.js'), 'utf8') });
  return page;
}

test('current Work composer switches to Chat without changing the draft', async () => {
  const page = await fixture();
  await page.waitForFunction(() => document.getElementById('chat').getAttribute('aria-pressed') === 'true');
  assert.equal(await page.locator('#composer').inputValue(), 'Unsent draft');
  assert.equal(await page.locator('#work').isVisible(), false);
  assert.equal(await page.locator('#ordinary').isVisible(), true);
  await page.close();
});

test('selected mode detects Work even when the placeholder is customized', async () => {
  const page = await fixture({ label: 'Dash', ignoreFirstClick: true });
  await page.waitForFunction(() => window.clicks === 1);
  await page.evaluate(() => document.getElementById('work').setAttribute('aria-pressed', 'true'));
  await page.waitForFunction(() => document.getElementById('chat').getAttribute('aria-pressed') === 'true');
  assert.equal(await page.evaluate(() => window.clicks), 2);
  await page.close();
});

test('attribute-only restoration of Work is corrected after initial Chat selection', async () => {
  const page = await fixture();
  await page.waitForFunction(() => window.clicks === 1);
  await page.evaluate(() => {
    document.getElementById('chat').setAttribute('aria-pressed', 'false');
    document.getElementById('work').setAttribute('aria-pressed', 'true');
    document.getElementById('composer').setAttribute('aria-label', 'Work with ChatGPT');
  });
  await page.waitForFunction(() => window.clicks === 2);
  assert.equal(await page.locator('#chat').getAttribute('aria-pressed'), 'true');
  await page.close();
});

test('disabled preference leaves Work alone and restores the switcher when toggled off', async () => {
  const page = await fixture({ enabled: false });
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.clicks), 0);
  assert.equal(await page.locator('#work').isVisible(), true);
  await page.evaluate(() => window.listeners.forEach(fn => fn({ disableWorkMode: { newValue: true } }, 'local')));
  await page.waitForFunction(() => window.clicks === 1);
  await page.evaluate(() => window.listeners.forEach(fn => fn({ disableWorkMode: { newValue: false } }, 'local')));
  assert.equal(await page.locator('#work').isVisible(), true);
  assert.equal(await page.locator('#chat').isVisible(), true);
  await page.close();
});
