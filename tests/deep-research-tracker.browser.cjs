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
    await page.setContent('<main>Deep research: 999 full reports remaining</main><section><form><div id="prompt-textarea" contenteditable="true">Keep my draft</div><button type="button" aria-label="Add files and more">+</button></form><section id="github-repositories-for-chatgpt">Repositories</section></section>');
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
    await page.waitForFunction(() => document.getElementById('ghrc-deep-research-tracker').textContent.includes('0 left'));
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

test('dashboard stays above Highlights on the right; plugin selection and settings control the composer copy', async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<main><section><form><div id="prompt-textarea" contenteditable="true">My draft</div></form><section id="github-repositories-for-chatgpt">Repositories</section></section></main>');
    await page.evaluate(() => {
      window.__ghrcExtensionContext = { active: () => true, onStop() {} };
      window.settings = { showDeepResearchTracker: true, highlightedPages: [{ url: 'https://example.com/', title: 'Example' }] };
      window.listeners = [];
      window.chrome = { storage: { local: { async get(defaults) { return { ...defaults, ...window.settings }; } }, onChanged: {
        addListener(listener) { window.listeners.push(listener); }, removeListener() {},
      } } };
      window.changeSetting = value => {
        window.settings.showDeepResearchTracker = value;
        window.listeners.forEach(listener => listener({ showDeepResearchTracker: { newValue: value } }, 'local'));
      };
      document.documentElement.setAttribute('data-ghrc-deep-research-usage', JSON.stringify({ remaining: 13, resetAt: Date.now() + 40 * 3600_000, observedAt: Date.now() }));
    });
    for (const file of ['styles.css', 'highlighted-pages.css', 'deep-research-tracker.css']) {
      await page.addStyleTag({ content: fs.readFileSync(path.join(__dirname, '../css', file), 'utf8') });
    }
    for (const file of ['deep-research-tracker.js', 'highlighted-pages.js']) {
      await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../js', file), 'utf8') });
    }
    await page.locator('#ghrc-highlighted-pages').waitFor();
    const layout = await page.evaluate(() => {
      const repo = document.getElementById('github-repositories-for-chatgpt');
      const row = document.getElementById('ghrc-deep-research-dashboard');
      const button = document.getElementById('ghrc-deep-research-tracker');
      const highlights = document.getElementById('ghrc-highlighted-pages');
      return {
        order: repo.nextElementSibling === row && row.nextElementSibling === highlights,
        right: Math.abs(button.getBoundingClientRect().right - repo.getBoundingClientRect().right) < 1,
        between: button.getBoundingClientRect().top >= repo.getBoundingClientRect().bottom && button.getBoundingClientRect().bottom <= highlights.getBoundingClientRect().top,
        composerCopy: !!document.getElementById('ghrc-deep-research-tracker-composer'),
      };
    });
    assert.deepEqual(layout, { order: true, right: true, between: true, composerCopy: false });
    await page.evaluate(() => {
      const mention = document.createElement('span');
      mention.contentEditable = 'false';
      mention.dataset.promptLinkHref = 'app://connector_openai_deep_research';
      mention.textContent = 'Deep research';
      document.getElementById('prompt-textarea').append(mention);
    });
    await page.locator('#ghrc-deep-research-tracker-composer').waitFor();
    assert.equal(await page.evaluate(() => document.getElementById('ghrc-deep-research-tracker-composer').nextElementSibling === document.querySelector('form')), true);
    await page.evaluate(() => window.changeSetting(false));
    await page.waitForFunction(() => document.querySelectorAll('.ghrc-deep-research-tracker').length === 0);
    assert.equal(await page.locator('#ghrc-highlighted-pages').count(), 1);
    await page.evaluate(() => window.changeSetting(true));
    await page.waitForFunction(() => document.querySelectorAll('.ghrc-deep-research-tracker').length === 2);
    await page.evaluate(() => document.querySelector('[data-prompt-link-href]').remove());
    await page.waitForFunction(() => !document.getElementById('ghrc-deep-research-tracker-composer'));
    assert.equal(await page.locator('#prompt-textarea').innerText(), 'My draft');
    const section = await page.locator('#ghrc-highlighted-pages').elementHandle();
    await page.waitForTimeout(150);
    assert.equal(await section.evaluate(element => element.isConnected), true, 'Highlights must not repeatedly remount');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('homepage only shows the remaining count in the final five days', async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<section><form><div id="prompt-textarea" contenteditable="true"><span contenteditable="false" data-prompt-link-href="app://connector_openai_deep_research">Deep research</span></div></form><section id="github-repositories-for-chatgpt">Repositories</section></section>');
    await page.evaluate(() => {
      window.__ghrcExtensionContext = { active: () => true, onStop() {} };
      const now = Date.now();
      document.documentElement.setAttribute('data-ghrc-deep-research-usage', JSON.stringify({ remaining: 13, resetAt: now + 6 * 24 * 60 * 60_000, observedAt: now }));
    });
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../js/deep-research-tracker.js'), 'utf8') });
    const dashboard = page.locator('#ghrc-deep-research-tracker');
    const composer = page.locator('#ghrc-deep-research-tracker-composer');
    await dashboard.waitFor();
    await composer.waitFor();
    assert.doesNotMatch(await dashboard.innerText(), /13 left/);
    assert.match(await dashboard.innerText(), /resets 6d/);
    assert.match(await composer.innerText(), /13 left/);

    await page.evaluate(() => {
      const now = Date.now();
      document.documentElement.setAttribute('data-ghrc-deep-research-usage', JSON.stringify({ remaining: 13, resetAt: now + 5 * 24 * 60 * 60_000, observedAt: now }));
    });
    await page.waitForFunction(() => document.getElementById('ghrc-deep-research-tracker')?.textContent.includes('13 left'));
  } finally { await browser.close(); }
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
      return route.fulfill({ contentType: 'text/html', body: '<section><form><div id="prompt-textarea" contenteditable="true">My draft</div></form><section id="github-repositories-for-chatgpt">Repositories</section></section>' });
    });
    await page.goto('https://research.test/');
    await page.evaluate(() => { window.__ghrcExtensionContext = { active: () => true, onStop() {} }; });
    for (const file of ['deep-research-usage.js', 'deep-research-tracker.js']) {
      await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../js', file), 'utf8') });
    }
    const response = await page.evaluate(async () => (await fetch('/backend-api/conversation/init', { method: 'POST', body: '{}' })).json());
    assert.equal(response.unrelated_private_field, 'must stay in page response');
    await page.waitForFunction(() => document.getElementById('ghrc-deep-research-tracker')?.textContent.includes('13 left'));
    const widget = page.locator('#ghrc-deep-research-tracker');
    assert.match(await widget.innerText(), /13 left · resets \d+d/);
    const exposed = await page.evaluate(() => JSON.parse(document.documentElement.getAttribute('data-ghrc-deep-research-usage')));
    assert.deepEqual(Object.keys(exposed).sort(), ['observedAt', 'remaining', 'resetAt']);
    remaining = 0;
    await widget.click();
    await page.waitForFunction(() => document.getElementById('ghrc-deep-research-tracker').textContent.includes('0 left'));
    assert.equal(requests, 2);
    assert.equal(await page.locator('#prompt-textarea').innerText(), 'My draft');
  } finally { await browser.close(); }
});
