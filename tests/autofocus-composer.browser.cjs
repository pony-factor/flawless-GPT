const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

test('composer focus survives hydration and explicit chat actions without stealing other input', async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<textarea id="prompt-textarea" hidden></textarea><div data-composer-markdown contenteditable="false"></div><input id="search"><button id="ask">Ask ChatGPT</button><button id="new">New chat</button>');
    await page.evaluate(() => {
      window.preferenceListeners = [];
      window.chrome = { storage: {
        local: { get: async defaults => defaults },
        onChanged: { addListener: listener => preferenceListeners.push(listener) },
      } };
      document.querySelector('#ask').onclick = () => {
        setTimeout(() => {
          document.querySelector('[data-composer-markdown]').outerHTML = '<div data-composer-markdown contenteditable="true"><p><br></p></div>';
        }, 400);
      };
      document.querySelector('#new').onclick = () => {
        setTimeout(() => {
          document.querySelector('[data-composer-markdown]').outerHTML = '<div data-composer-markdown contenteditable="true"></div>';
        }, 400);
      };
    });
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../js/autofocus-composer.js'), 'utf8') });
    const focused = () => page.waitForFunction(() => document.activeElement.matches('[data-composer-markdown]'));
    await page.evaluate(() => document.querySelector('[data-composer-markdown]').contentEditable = 'true');
    await focused();
    await page.waitForTimeout(250);
    await page.evaluate(() => document.querySelector('[data-composer-markdown]').blur());
    await focused();
    await page.waitForTimeout(2200);
    await page.evaluate(() => {
      document.querySelector('[data-composer-markdown]').outerHTML = '<div data-composer-markdown contenteditable="true"></div>';
    });
    await focused();
    await page.locator('#search').click();
    await page.locator('#search').pressSequentially('Search draft');
    await page.waitForTimeout(2100);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'search');
    await page.evaluate(() => window.dispatchEvent(new Event('ghrc:route-change')));
    await focused();
    await page.locator('#ask').click();
    await page.waitForTimeout(700);
    await focused();
    await page.keyboard.type('Explain this');
    assert.equal(await page.locator('[data-composer-markdown]').textContent(), 'Explain this');
    await page.locator('#new').click();
    await page.waitForTimeout(700);
    await focused();
    await page.evaluate(() => {
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.innerHTML = '<input id="dialog-input">';
      document.body.append(dialog);
      document.querySelector('#dialog-input').focus();
      window.dispatchEvent(new Event('ghrc:route-change'));
    });
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'dialog-input');
    await page.evaluate(() => document.querySelector('[role="dialog"]').remove());
    await focused();
    await page.evaluate(() => preferenceListeners.forEach(listener => listener({ autoFocusComposer: { newValue: false } }, 'local')));
    await page.locator('#ask').click();
    await page.waitForTimeout(700);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'ask');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
