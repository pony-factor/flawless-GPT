const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

test('clipboard URL button only appears on the New Chat route', async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://chatgpt.com/**', route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<main><textarea id="prompt-textarea"></textarea><button id="send">Send</button></main>',
    }));
    await page.goto('https://chatgpt.com/');

    await page.evaluate(() => {
      window.__ghrcExtensionContext = {
        active: () => true,
        handleError: error => { throw error; },
        run: async callback => callback(),
        onStop: () => {},
      };
      window.__ghrcMessageQueue = {
        findComposerInput: () => document.querySelector('#prompt-textarea'),
        findActionButton: () => document.querySelector('#send'),
      };
      window.chrome = {
        storage: {
          local: { get: async defaults => defaults },
          onChanged: { addListener: () => {} },
        },
      };
    });

    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../js/clipboard-send.js'), 'utf8') });

    await page.waitForSelector('#ghrc-clipboard-open-url-button');
    assert.equal(await page.locator('#ghrc-clipboard-open-url-button').count(), 1);

    await page.evaluate(() => {
      history.pushState({}, '', '/c/example');
      window.dispatchEvent(new Event('ghrc:route-change'));
    });
    await page.waitForFunction(() => !document.querySelector('#ghrc-clipboard-open-url-button'));

    await page.evaluate(() => {
      history.pushState({}, '', '/');
      window.dispatchEvent(new Event('ghrc:route-change'));
    });
    await page.waitForSelector('#ghrc-clipboard-open-url-button');
    assert.equal(await page.locator('#ghrc-clipboard-open-url-button').count(), 1);
  } finally {
    await browser.close();
  }
});
