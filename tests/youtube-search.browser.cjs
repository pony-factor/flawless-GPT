// Run with Playwright available: node --test tests/youtube-search.browser.cjs
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const source = fs.readFileSync(path.join(__dirname, '../js/launchers/youtube-search.js'), 'utf8');
const baseStyles = fs.readFileSync(path.join(__dirname, '../css/dashboard/styles.css'), 'utf8');
const wootenStyles = fs.readFileSync(path.join(__dirname, '../css/launchers/wooten-link-zipp.css'), 'utf8');
const searchStyles = fs.readFileSync(path.join(__dirname, '../css/launchers/youtube-search.css'), 'utf8');
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
    body: '<main id="github-repositories-for-chatgpt"><footer class="ghrc-dashboard-footer"><form class="ghrc-wooten-link-search"><a class="ghrc-wooten-link-mark-link" href="https://wooten.link/" aria-label="Open WootenLink homepage"><img class="ghrc-wooten-link-mark" alt=""></a><div class="ghrc-wooten-link-field"><input type="search" placeholder="hrefs"><button class="ghrc-wooten-link-submit" type="submit"></button></div></form><div class="ghrc-footer-navigation"><nav class="ghrc-pagination"></nav></div></footer></main>',
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

  const wootenInputWidth = await page.locator('.ghrc-wooten-link-search input').evaluate(element => element.getBoundingClientRect().width);
  const youtubeInputWidth = await page.locator('.ghrc-youtube-search input').evaluate(element => element.getBoundingClientRect().width);
  assert.ok(Math.abs(wootenInputWidth - youtubeInputWidth) < 0.5);

  await page.evaluate(() => chrome.storage.local.set({ showYoutubeSearch: false }));
  await page.waitForFunction(() => !document.querySelector('.ghrc-youtube-search'));

  await page.evaluate(() => chrome.storage.local.set({ showYoutubeSearch: true }));
  await page.locator('.ghrc-youtube-search').waitFor();

  await page.locator('.ghrc-youtube-search input').fill('Sweetie Bot');
  await youtubeSubmit.click();
  await page.waitForFunction(() => opened.length === 1);

  const opened = await page.evaluate(() => window.opened[0]);
  assert.equal(opened.type, 'open-youtube-search');
  assert.equal(new URL(opened.url).searchParams.get('search_query'), 'Sweetie Bot');
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('YouTube logo follows the theme and opens the homepage in the same tab', async () => {
  const page = await fixture();
  const homepage = page.getByRole('link', { name: 'Open YouTube homepage' });
  const logoFill = () => homepage.locator('svg rect').evaluate(rect => getComputedStyle(rect).fill);
  await page.emulateMedia({ colorScheme: 'light' });
  assert.equal(await logoFill(), 'rgb(26, 127, 55)');
  await page.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await logoFill(), 'rgb(63, 185, 80)');
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--ghrc-dashboard-accent-dark', '#49a164');
  });
  assert.equal(await logoFill(), 'rgb(73, 161, 100)');

  await page.locator('.ghrc-youtube-search input').fill('Sweetie Bot');
  await page.route('https://www.youtube.com/', route => route.fulfill({ body: 'YouTube' }));
  await Promise.all([page.waitForURL('https://www.youtube.com/'), homepage.click()]);
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
