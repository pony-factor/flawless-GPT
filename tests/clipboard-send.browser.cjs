const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

test('Paste Link and Spellcheck join the composer before + in narrow viewports', async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
    await page.route('https://chatgpt.com/**', route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<main>
        <form style="position:relative;width:min(500px,calc(100vw - 32px));height:72px;margin:100px auto">
          <textarea id="prompt-textarea"></textarea>
          <div id="toolbar" style="display:flex;align-items:center;gap:4px">
            <button id="plus" type="button" data-testid="composer-plus-btn" aria-label="Add files and more">+</button>
            <button id="ghrc-message-interrupt-button" type="button">Dashie</button>
            <button id="send" type="button">Send</button>
          </div>
        </form>
      </main>`,
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
        runtime: { getURL: file => file },
        storage: {
          local: {
            get: async defaults => ({
              ...defaults,
              showClipboardSendButton: true,
              showSpellcheckGptLauncher: true,
            }),
            remove: async () => {},
          },
          onChanged: { addListener: () => {} },
        },
      };
    });

    for (const css of ['clipboard-send.css', 'spellcheck-launcher.css']) {
      await page.addStyleTag({ content: fs.readFileSync(path.join(__dirname, '../css', css), 'utf8') });
    }
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../js/composer/clipboard-send.js'), 'utf8') });
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../js/launchers/spellcheck-launcher.js'), 'utf8') });

    const ids = () => page.locator('#toolbar > button').evaluateAll(buttons => buttons.map(button => button.id));
    await page.waitForSelector('#ghrc-clipboard-open-url-button[data-ghrc-beside-spellcheck]');
    await page.waitForSelector('#ghrc-spellcheck-gpt-launcher');
    assert.deepEqual(await ids(), ['plus', 'ghrc-clipboard-send-button', 'ghrc-message-interrupt-button', 'send']);

    const desktopLink = await page.locator('#ghrc-clipboard-open-url-button').boundingBox();
    const desktopSpellcheck = await page.locator('#ghrc-spellcheck-gpt-launcher').boundingBox();
    assert.equal(desktopLink.x + desktopLink.width + 8, desktopSpellcheck.x);
    assert.equal(desktopLink.y, desktopSpellcheck.y);

    for (const width of [600, 480, 320]) {
      await page.setViewportSize({ width, height: 600 });
      await page.waitForFunction(() => {
        const link = document.querySelector('#ghrc-clipboard-open-url-button');
        const spellcheck = document.querySelector('#ghrc-spellcheck-gpt-launcher');
        const plus = document.querySelector('#plus');
        return link?.nextElementSibling === spellcheck
          && spellcheck?.nextElementSibling === plus
          && link.parentElement === plus.parentElement
          && link.hasAttribute('data-ghrc-inline-before-plus')
          && spellcheck.hasAttribute('data-ghrc-inline-before-plus');
      });
      assert.deepEqual((await ids()).slice(0, 3), [
        'ghrc-clipboard-open-url-button', 'ghrc-spellcheck-gpt-launcher', 'plus',
      ]);
      const [link, spellcheck, plus] = await Promise.all([
        page.locator('#ghrc-clipboard-open-url-button').boundingBox(),
        page.locator('#ghrc-spellcheck-gpt-launcher').boundingBox(),
        page.locator('#plus').boundingBox(),
      ]);
      assert.ok(link.x + link.width <= spellcheck.x, 'Paste Link stays ahead of Spellcheck');
      assert.ok(spellcheck.x + spellcheck.width <= plus.x, 'Spellcheck stays ahead of +');
      assert.equal(link.y, spellcheck.y);
      assert.ok(Math.abs((spellcheck.y + spellcheck.height / 2) - (plus.y + plus.height / 2)) <= 1,
        'Spellcheck stays vertically centered with the native + button');
    }

    await page.setViewportSize({ width: 1000, height: 600 });
    await page.waitForSelector('#ghrc-clipboard-open-url-button[data-ghrc-beside-spellcheck]');
    await page.waitForFunction(() =>
      document.querySelector('#ghrc-spellcheck-gpt-launcher')?.parentElement?.tagName === 'FORM'
      && !document.querySelector('#ghrc-spellcheck-gpt-launcher')?.hasAttribute('data-ghrc-inline-before-plus'));
    assert.deepEqual(await ids(), ['plus', 'ghrc-clipboard-send-button', 'ghrc-message-interrupt-button', 'send']);

    await page.evaluate(() => {
      history.pushState({}, '', '/c/example');
      window.dispatchEvent(new Event('ghrc:route-change'));
    });
    await page.waitForFunction(() => !document.querySelector('#ghrc-clipboard-open-url-button'));
    assert.deepEqual(await ids(), ['plus', 'ghrc-clipboard-send-button', 'ghrc-message-interrupt-button', 'send']);

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
