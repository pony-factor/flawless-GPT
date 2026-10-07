// Run with Playwright available: node --test tests/youtube-search.browser.cjs
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const source = fs.readFileSync(path.join(__dirname, '../js/youtube-search.js'), 'utf8');
const baseStyles = fs.readFileSync(path.join(__dirname, '../css/styles.css'), 'utf8');
const wootenStyles = fs.readFileSync(path.join(__dirname, '../css/wooten-link-zipp-placeholder.css'), 'utf8');
const searchStyles = fs.readFileSync(path.join(__dirname, '../css/youtube-search.css'), 'utf8');
let browser;

before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.BROWSER_EXECUTABLE || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    headless: true,
  });
});

after(async () => { await browser?.close(); });

async function fixture(stored = {}) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  await page.route('https://youtube-search.test/**', route => route.fulfill({
    contentType: 'text/html',
    body: '<main id="github-repositories-for-chatgpt"><footer class="ghrc-dashboard-footer"><form class="ghrc-wooten-link-search"><label><img class="ghrc-wooten-link-mark" alt=""><input type="search" placeholder="hrefs"></label><button class="ghrc-wooten-link-submit" type="submit"></button></form><nav class="ghrc-pagination"></nav></footer></main>',
  }));
  await page.goto('https://youtube-search.test/');
  await page.evaluate((initial) => {
    window.storage = structuredClone(initial);
    window.storageListeners = [];
    window.opened = [];
    window.chrome = {
      runtime: {
        async sendMessage(message) {
          window.opened.push(structuredClone(message));
          return { ok: true };
        },
      },
      storage: {
        local: {
          async get(defaults) {
            return { ...defaults, ...structuredClone(window.storage) };
          },
          async set(values) {
            const changes = {};
            for (const [key, value] of Object.entries(values)) {
              changes[key] = { oldValue: window.storage[key], newValue: value };
              window.storage[key] = value;
            }
            window.storageListeners.forEach(listener => listener(changes, 'local'));
          },
        },
        onChanged: {
          addListener(listener) {
            window.storageListeners.push(listener);
          },
        },
      },
    };
  }, stored);

  await page.addStyleTag({ content: baseStyles });
  await page.addStyleTag({ content: wootenStyles });
  await page.addStyleTag({ content: searchStyles });
  await page.addScriptTag({ content: source });
  page.errors = errors;
  return page;
}

test('YouTube search is visible by default and follows its setting live', async () => {
  const page = await fixture();
  await page.locator('.ghrc-youtube-search').waitFor();

  const youtubeSubmit = page.locator('.ghrc-youtube-submit');
  assert.equal(await youtubeSubmit.getAttribute('aria-label'), 'Search YouTube');
  assert.equal(await youtubeSubmit.locator('svg.ghrc-youtube-logo').count(), 1);

  const wootenInputWidth = await page.locator('.ghrc-wooten-link-search input').evaluate(element => element.getBoundingClientRect().width);
  const youtubeInputWidth = await page.locator('.ghrc-youtube-search input').evaluate(element => element.getBoundingClientRect().width);
  assert.ok(Math.abs(wootenInputWidth - youtubeInputWidth) < 0.5);

  await page.evaluate(() => chrome.storage.local.set({ showYoutubeSearch: false }));
  await page.waitForFunction(() => !document.querySelector('.ghrc-youtube-search'));

  await page.evaluate(() => chrome.storage.local.set({ showYoutubeSearch: true }));
  await page.locator('.ghrc-youtube-search').waitFor();

  await page.locator('.ghrc-youtube-search input').fill('Sweetie Bot');
  await page.locator('.ghrc-youtube-search').evaluate(form => form.requestSubmit());
  await page.waitForFunction(() => opened.length === 1);

  const opened = await page.evaluate(() => window.opened[0]);
  assert.equal(opened.type, 'open-youtube-search');
  assert.equal(new URL(opened.url).searchParams.get('search_query'), 'Sweetie Bot');
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('stored off preference keeps YouTube search unmounted', async () => {
  const page = await fixture({ showYoutubeSearch: false });
  await page.waitForFunction(() => window.storageListeners.length === 1);
  await page.waitForTimeout(50);
  assert.equal(await page.locator('.ghrc-youtube-search').count(), 0);
  assert.deepEqual(page.errors, []);
  await page.close();
});
