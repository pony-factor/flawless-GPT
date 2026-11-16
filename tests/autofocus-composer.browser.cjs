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
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../js/composer/autofocus-composer.js'), 'utf8') });
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

test('dashboard search fields keep their cursor during composer autofocus and route changes', async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(`
      <div data-composer-markdown contenteditable="true"></div>
      <div id="github-repositories-for-chatgpt">
        <label class="ghrc-search"><input id="repo-search" type="search"></label>
        <form class="ghrc-search-override-form"><input id="custom-repo-search" type="text"></form>
        <form class="ghrc-wooten-link-search"><input id="wooten-search" type="search"></form>
        <form class="ghrc-youtube-search"><input id="youtube-search" type="search"></form>
      </div>
      <button id="ask">Ask ChatGPT</button>
    `);
    await page.evaluate(() => {
      window.chrome = { storage: {
        local: { get: async defaults => defaults },
        onChanged: { addListener: () => {} },
      } };
    });

    // An input focused before extension startup must also remain focused.
    await page.locator('#repo-search').focus();
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../js/composer/autofocus-composer.js'), 'utf8') });
    await page.waitForTimeout(1950);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'repo-search');

    for (const id of ['repo-search', 'custom-repo-search', 'wooten-search', 'youtube-search']) {
      const input = page.locator(`#${id}`);
      await input.focus();
      await page.evaluate(() => window.dispatchEvent(new Event('ghrc:route-change')));
      await input.pressSequentially('pony');
      // Includes the final delayed retry, which must not redirect keystrokes.
      await page.waitForTimeout(1950);
      assert.equal(await page.evaluate(() => document.activeElement.id), id);
      assert.equal(await input.inputValue(), 'pony');
      await input.fill('');
    }

    // A deliberate ChatGPT action still restores composer focus.
    await page.locator('#ask').click();
    await page.waitForFunction(() => document.activeElement.matches('[data-composer-markdown]'));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
