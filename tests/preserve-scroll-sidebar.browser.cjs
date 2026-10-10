// Run with Playwright installed: node --test tests/preserve-scroll-sidebar.browser.cjs
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const source = fs.readFileSync(path.join(__dirname, '../js/preserve-scroll-on-send.js'), 'utf8');
let browser;
before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.BROWSER_EXECUTABLE || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    headless: true,
  });
});
after(async () => { await browser?.close(); });

async function fixture(withConversation) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const links = Array.from({ length: 75 }, (_, i) =>
    `<a href="/c/history-${i}">History ${i}</a>`).join('');
  await page.route('https://chatgpt.com/**', route => route.fulfill({
    contentType: 'text/html',
    body: `
      <style>
        html, body { margin: 0; height: 100%; overflow: hidden; }
        aside { position: fixed; inset: 0 auto 0 0; width: 260px; overflow-y: auto; }
        nav a { display: block; height: 32px; }
        main { margin-left: 290px; height: 100vh; }
        #conversation-scroller { max-height: 300px; overflow-y: auto; }
        article { height: 100px; }
      </style>
      <aside id="sidebar" class="overflow-y-auto"><nav id="history">${links}</nav></aside>
      <main>
        <div id="conversation-scroller">
          ${withConversation ? Array.from({ length: 12 }, (_, i) =>
            `<article data-testid="conversation-turn-${i}"><div data-message-author-role="assistant">Reply ${i}</div></article>`).join('') : ''}
        </div>
        <button data-testid="send-button">Send</button>
      </main>
    `,
  }));
  await page.goto('https://chatgpt.com/c/sidebar-scroll-test');
  await page.evaluate(() => {
    window.chrome = {
      storage: {
        local: { async get(defaults) { return { ...defaults, preserveScrollPositionOnSend: true }; } },
        onChanged: { addListener() {} },
      },
    };
  });
  await page.addScriptTag({ content: source });
  await page.waitForTimeout(25);
  return { page, errors };
}

for (const withConversation of [false, true]) {
  test(`chat history scrolls with ${withConversation ? 'active conversation guard' : 'empty chat fallback'}`, async () => {
    const { page, errors } = await fixture(withConversation);
    if (withConversation) {
      await page.locator('[data-testid="send-button"]').click();
    }
    const history = page.locator('#sidebar');
    assert.equal(await history.evaluate(el => el.scrollTop), 0);

    // The sidebar must never have its wheel input cancelled by the
    // conversation scroll guard, even when it is the largest scroll pane.
    const cancelled = await page.locator('#history').evaluate(el => {
      const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 180 });
      el.dispatchEvent(wheel);
      return wheel.defaultPrevented;
    });
    assert.equal(cancelled, false);

    await page.mouse.move(125, 240);
    await page.mouse.wheel(0, 280);
    await page.waitForFunction(() => document.querySelector('#sidebar').scrollTop > 0);
    const afterDown = await history.evaluate(el => el.scrollTop);
    await page.mouse.wheel(0, -120);
    await page.waitForFunction(previous => document.querySelector('#sidebar').scrollTop < previous, afterDown);

    if (withConversation) {
      await page.mouse.move(400, 100);
      await page.mouse.wheel(0, 140);
      await page.waitForFunction(() => document.querySelector('#conversation-scroller').scrollTop > 0);
    }
    assert.deepEqual(errors, []);
    await page.close();
  });
}
