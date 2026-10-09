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

test('sidebar conversations show compact relative creation ages before the title', async () => {
  const now = Date.UTC(2026, 9, 7, 12);
  const day = 24 * 60 * 60 * 1000;
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
            { id: 'alpha', title: 'Alpha', create_time: new Date(now - (2 * day)).toISOString() },
            { id: 'today', title: 'Today', create_time: new Date(now - (60 * 60 * 1000)).toISOString() },
            { id: 'beta', title: 'Beta', create_time: new Date(now - (62 * day)).toISOString() },
            { id: 'gamma', title: 'Gamma', create_time: new Date(now - (800 * day)).toISOString() },
          ],
          total: 4,
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
  await page.evaluate((fixedNow) => {
    Date.now = () => fixedNow;
    window.chrome = { runtime: { id: 'fixture' }, storage: { local: {} } };
  }, now);
  await page.addStyleTag({ content: read('css/sidebar-chat-dates.css') });
  await page.addScriptTag({ content: read('js/sidebar-chat-dates-main.js') });
  await page.addScriptTag({ content: read('js/extension-context.js') });
  await page.addScriptTag({ content: read('js/sidebar-chat-dates.js') });

  await page.evaluate(() => fetch('/backend-api/conversations?offset=0&limit=100&order=updated'));
  await page.waitForFunction(() => document.querySelector('a[href="/c/alpha"] > .ghrc-chat-date')?.textContent === '2d');

  const alpha = page.locator('a[href="/c/alpha"]');
  assert.equal(await alpha.locator(':scope > .ghrc-chat-date').textContent(), '2d');
  assert.equal(await alpha.evaluate(link => link.firstElementChild?.className), 'ghrc-chat-date');
  assert.equal(await alpha.locator(':scope > .ghrc-chat-date').getAttribute('title'), 'Created 5 Oct');

  await page.evaluate(() => {
    for (const [id, title] of [['today', 'Today'], ['beta', 'Beta'], ['gamma', 'Gamma']]) {
      const link = document.createElement('a');
      link.href = `/c/${id}`;
      link.innerHTML = `<span>${title}</span>`;
      document.getElementById('sidebar').append(link);
    }
  });
  await page.waitForFunction(() => document.querySelector('a[href="/c/gamma"] > .ghrc-chat-date'));
  assert.equal(await page.locator('a[href="/c/today"] > .ghrc-chat-date').textContent(), '🆕');
  assert.equal(await page.locator('a[href="/c/today"] > .ghrc-chat-date').getAttribute('title'), 'Created 7 Oct');
  assert.equal(await page.locator('a[href="/c/today"] > .ghrc-chat-date').evaluate(el => el.classList.contains('ghrc-chat-date--new')), true);
  assert.equal(await page.locator('a[href="/c/beta"] > .ghrc-chat-date').textContent(), '2mo');
  assert.equal(await page.locator('a[href="/c/gamma"] > .ghrc-chat-date').textContent(), '2y');
  assert.deepEqual(errors, []);

  await context.close();
});
