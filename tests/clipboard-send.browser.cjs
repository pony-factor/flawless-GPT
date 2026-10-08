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
      body: '<main><textarea id="prompt-textarea"></textarea><button id="ghrc-message-interrupt-button">Dashie</button><button id="send">Send</button></main>',
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
          local: { get: async defaults => ({ ...defaults, showClipboardSendButton: true }) },
          onChanged: { addListener: () => {} },
        },
      };
    });

    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../js/clipboard-send.js'), 'utf8') });

    await page.waitForSelector('#ghrc-clipboard-open-url-button');
    assert.equal(await page.locator('#ghrc-clipboard-open-url-button').count(), 1);
    assert.deepEqual(
      await page.locator('main > button').evaluateAll(buttons => buttons.map(button => button.id)),
      [
        'ghrc-clipboard-send-button',
        'ghrc-clipboard-open-url-button',
        'ghrc-message-interrupt-button',
        'send',
      ],
    );

    // Dash's launcher lives outside the toolbar. Check visual placement, not
    // just the order of toolbar buttons (the hat is a separate Send control).
    await page.addStyleTag({ content: fs.readFileSync(path.join(__dirname, '../css/clipboard-send.css'), 'utf8') });
    await page.addStyleTag({ content: fs.readFileSync(path.join(__dirname, '../css/spellcheck-launcher.css'), 'utf8') });
    await page.evaluate(() => {
      const host = document.createElement('form');
      host.style.cssText = 'position:relative;margin:100px;width:500px;height:60px';
      host.setAttribute('data-ghrc-spellcheck-launcher-host', 'true');
      const launcher = document.createElement('button');
      launcher.id = 'ghrc-spellcheck-gpt-launcher';
      launcher.textContent = 'Dash';
      document.querySelector('main').append(host);
      host.append(launcher);
    });
    await page.waitForSelector('#ghrc-clipboard-open-url-button[data-ghrc-beside-spellcheck]');
    for (const width of [1000, 600]) {
      await page.setViewportSize({ width, height: 600 });
      const link = await page.locator('#ghrc-clipboard-open-url-button').boundingBox();
      const dash = await page.locator('#ghrc-spellcheck-gpt-launcher').boundingBox();
      assert.equal(link.x + link.width + 8, dash.x);
      assert.equal(link.y, dash.y);
    }
    await page.evaluate(() => document.querySelector('#ghrc-spellcheck-gpt-launcher').parentElement.remove());
    await page.waitForFunction(() => {
      const button = document.querySelector('#ghrc-clipboard-open-url-button');
      return button && !button.hasAttribute('data-ghrc-beside-spellcheck');
    });

    await page.evaluate(() => {
      history.pushState({}, '', '/c/example');
      window.dispatchEvent(new Event('ghrc:route-change'));
    });
    await page.waitForFunction(() => !document.querySelector('#ghrc-clipboard-open-url-button'));
    assert.deepEqual(
      await page.locator('main > button').evaluateAll(buttons => buttons.map(button => button.id)),
      ['ghrc-clipboard-send-button', 'ghrc-message-interrupt-button', 'send'],
    );

    await page.evaluate(() => {
      history.pushState({}, '', '/');
      window.dispatchEvent(new Event('ghrc:route-change'));
    });
    await page.waitForSelector('#ghrc-clipboard-open-url-button');
    assert.equal(await page.locator('#ghrc-clipboard-open-url-button').count(), 1);
    assert.deepEqual(
      await page.locator('main > button').evaluateAll(buttons => buttons.map(button => button.id)),
      [
        'ghrc-clipboard-send-button',
        'ghrc-clipboard-open-url-button',
        'ghrc-message-interrupt-button',
        'send',
      ],
    );
  } finally {
    await browser.close();
  }
});
