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

test('sidebar conversations show their creation date before the title', async () => {
  const context = await browser.newContext({ timezoneId: 'UTC' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  await page.route('https://chatgpt.com/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/backend-api/conversations') {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            { id: 'alpha', title: 'Alpha', create_time: '2026-10-05T12:00:00Z' },
            { id: 'beta', title: 'Beta', create_time: 1770120000 },
          ],
          total: 2,
          offset: 0,
          limit: 100,
        }),
      });
    }
    return route.fulfill({
      contentType: 'text/html',
      body: '<nav id="sidebar"><a href="/c/alpha"><span>Alpha</span></a></nav>',
    });
  });

  await page.goto('https://chatgpt.com/');
  await page.evaluate(() => {
    window.chrome = { runtime: { id: 'fixture' }, storage: { local: {} } };
  });
  await page.addStyleTag({ content: read('css/sidebar-chat-dates.css') });
  await page.addScriptTag({ content: read('js/sidebar-chat-dates-main.js') });
  await page.addScriptTag({ content: read('js/extension-context.js') });
  await page.addScriptTag({ content: read('js/sidebar-chat-dates.js') });

  await page.evaluate(() => fetch('/backend-api/conversations?offset=0&limit=100&order=updated'));
  await page.waitForFunction(() => document.querySelector('a[href="/c/alpha"] > .ghrc-chat-date')?.textContent === '05 Oct 2026');

  const alpha = page.locator('a[href="/c/alpha"]');
  assert.equal(await alpha.locator(':scope > .ghrc-chat-date').textContent(), '05 Oct 2026');
  assert.equal(await alpha.evaluate(link => link.firstElementChild?.className), 'ghrc-chat-date');

  await page.evaluate(() => {
    const link = document.createElement('a');
    link.href = '/c/beta';
    link.innerHTML = '<span>Beta</span>';
    document.getElementById('sidebar').append(link);
  });
  await page.waitForFunction(() => document.querySelector('a[href="/c/beta"] > .ghrc-chat-date'));
  assert.match(await page.locator('a[href="/c/beta"] > .ghrc-chat-date').textContent(), /^\d{2} [A-Z][a-z]{2} \d{4}$/);
  assert.deepEqual(errors, []);

  await context.close();
});
