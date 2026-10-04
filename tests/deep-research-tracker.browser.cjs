const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

test('mounts, reads native usage, excludes messages, and cleans up on extension reload', async () => {
  const browser = await chromium.launch({
    executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true,
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<main>Deep research: 999 full reports remaining</main><section><form><div id="prompt-textarea" contenteditable="true">Keep my draft</div><button type="button" aria-label="Add files and more">+</button></form></section>');
    await page.evaluate(() => {
      window.__ghrcExtensionContext = { active: () => true, onStop: cleanup => { window.cleanup = cleanup; } };
      window.submits = 0;
      document.querySelector('form').addEventListener('submit', event => { event.preventDefault(); window.submits++; });
      document.querySelector('button').onclick = () => {
        const menu = document.createElement('div');
        menu.setAttribute('role', 'menu');
        menu.innerHTML = '<button role="menuitem" aria-describedby="quota">Deep research</button><div id="quota">0 full reports remaining\n10 lightweight reports remaining\nResets on October 20</div>';
        document.body.append(menu);
      };
    });
    await page.addStyleTag({ content: fs.readFileSync(path.join(__dirname, '../css/deep-research-tracker.css'), 'utf8') });
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../js/deep-research-tracker.js'), 'utf8') });
    const widget = page.locator('#ghrc-deep-research-tracker');
    await widget.waitFor();
    assert.match(await widget.innerText(), /Check allowance/);
    await widget.click();
    await page.waitForFunction(() => document.getElementById('ghrc-deep-research-tracker').textContent.includes('Full reports: 0 remaining'));
    assert.match(await widget.innerText(), /Resets on October 20/);
    assert.equal(await page.locator('#prompt-textarea').innerText(), 'Keep my draft');
    assert.equal(await page.evaluate(() => window.submits), 0);
    assert.equal(await widget.count(), 1);
    await page.evaluate(() => window.cleanup());
    assert.equal(await widget.count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('native initialization fills the tracker automatically and clicking refreshes without submitting a prompt', async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
  try {
    const page = await browser.newPage({ timezoneId: 'America/New_York' });
    let remaining = 13;
    let requests = 0;
    await page.route('https://research.test/**', route => {
      if (route.request().url().endsWith('/backend-api/conversation/init')) {
        requests++;
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
          limits_progress: [{ feature_name: 'deep_research', remaining, reset_after: '2099-10-21T17:43:43Z' }],
          unrelated_private_field: 'must stay in page response',
        }) });
      }
      return route.fulfill({ contentType: 'text/html', body: '<section><form><div id="prompt-textarea" contenteditable="true">My draft</div></form></section>' });
    });
    await page.goto('https://research.test/');
    await page.evaluate(() => { window.__ghrcExtensionContext = { active: () => true, onStop() {} }; });
    for (const file of ['deep-research-usage.js', 'deep-research-tracker.js']) {
      await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../js', file), 'utf8') });
    }
    const response = await page.evaluate(async () => (await fetch('/backend-api/conversation/init', { method: 'POST', body: '{}' })).json());
    assert.equal(response.unrelated_private_field, 'must stay in page response');
    await page.waitForFunction(() => document.getElementById('ghrc-deep-research-tracker')?.textContent.includes('13 reports remaining'));
    const widget = page.locator('#ghrc-deep-research-tracker');
    assert.match(await widget.innerText(), /Resets Oct 21, 1:43 PM EDT/);
    const exposed = await page.evaluate(() => JSON.parse(document.documentElement.getAttribute('data-ghrc-deep-research-usage')));
    assert.deepEqual(Object.keys(exposed).sort(), ['observedAt', 'remaining', 'resetAt']);
    remaining = 0;
    await widget.click();
    await page.waitForFunction(() => document.getElementById('ghrc-deep-research-tracker').textContent.includes('0 reports remaining'));
    assert.equal(requests, 2);
    assert.equal(await page.locator('#prompt-textarea').innerText(), 'My draft');
  } finally { await browser.close(); }
});
