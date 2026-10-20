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
    await page.setContent('<main>Deep research: 999 full reports remaining</main><section><form><div id="prompt-textarea" contenteditable="true">Keep my draft<span contenteditable="false" data-prompt-link-href="app://connector_openai_deep_research"></span></div><button type="button" aria-label="Add files and more">+</button></form><section id="github-repositories-for-chatgpt">Repositories<footer class="ghrc-dashboard-footer"><nav class="ghrc-pagination"><button>←</button><button>→</button></nav></footer></section></section>');
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
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../js/research/deep-research-tracker.js'), 'utf8') });
    const widget = page.locator('#ghrc-deep-research-tracker-composer');
    await widget.waitFor();
    assert.match(await widget.innerText(), /Check allowance/);
    await widget.click();
    await page.waitForFunction(() => document.getElementById('ghrc-deep-research-tracker-composer')?.textContent.includes('0 left'));
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

test('dashboard counter sits left of the game launcher; plugin selection and settings control the composer copy', async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<main><section><form><div id="prompt-textarea" contenteditable="true">My draft</div></form><section id="github-repositories-for-chatgpt">Repositories<footer class="ghrc-dashboard-footer"><nav class="ghrc-pagination"><button>←</button><button>→</button></nav></footer></section></section></main>');
    await page.evaluate(() => {
      window.__ghrcExtensionContext = { active: () => true, onStop() {} };
      window.settings = { show2048Launcher: true, showDeepResearchTracker: true, highlightedPages: [{ url: 'https://example.com/', title: 'Example' }] };
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
    for (const file of ['styles.css', '2048.css', 'highlighted-pages.css', 'deep-research-tracker.css']) {
      await page.addStyleTag({ content: fs.readFileSync(path.join(__dirname, '../css', file), 'utf8') });
    }
    for (const file of ['games/2048.js', 'research/deep-research-tracker.js', 'dashboard/highlighted-pages.js']) {
      await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../js', file), 'utf8') });
    }
    await page.locator('#ghrc-highlighted-pages').waitFor();
    const layout = await page.evaluate(() => {
      const repo = document.getElementById('github-repositories-for-chatgpt');
      const row = document.getElementById('ghrc-deep-research-dashboard');
      const button = document.getElementById('ghrc-deep-research-tracker');
      const highlights = document.getElementById('ghrc-highlighted-pages');
      const game = document.getElementById('ghrc-2048-launcher');
      return {
        order: repo.nextElementSibling === highlights && row.nextElementSibling === game,
        right: button.getBoundingClientRect().right < game.getBoundingClientRect().left,
        between: repo.contains(button) && Math.abs(button.getBoundingClientRect().top + button.getBoundingClientRect().height / 2 - game.getBoundingClientRect().top - game.getBoundingClientRect().height / 2) < 1,
        composerCopy: !!document.getElementById('ghrc-deep-research-tracker-composer'),
      };
    });
    assert.deepEqual(layout, { order: true, right: true, between: true, composerCopy: false });
    for (const width of [500, 400]) {
      await page.setViewportSize({ width, height: 800 });
      const positions = await page.evaluate(() => {
        const counter = document.getElementById('ghrc-deep-research-tracker').getBoundingClientRect();
        const game = document.getElementById('ghrc-2048-launcher').getBoundingClientRect();
        const arrows = document.querySelector('.ghrc-pagination').getBoundingClientRect();
        return { counterBeforeGame: counter.right < game.left, arrowsBeforeCounter: arrows.right <= counter.left,
          sameRow: Math.abs(counter.top + counter.height / 2 - game.top - game.height / 2) < 1 };
      });
      assert.deepEqual(positions, { counterBeforeGame: true, arrowsBeforeCounter: true, sameRow: true });
    }
    await page.evaluate(() => {
      const mention = document.createElement('span');
      mention.contentEditable = 'false';
      mention.dataset.promptLinkHref = 'app://connector_openai_deep_research';
      mention.textContent = 'Deep research';
      document.getElementById('prompt-textarea').append(mention);
    });
    await page.waitForFunction(() => document.getElementById('ghrc-deep-research-tracker') && !document.getElementById('ghrc-deep-research-tracker-composer'));
    assert.equal(await page.locator('#ghrc-deep-research-tracker').count(), 1);
    await page.evaluate(() => window.changeSetting(false));
    await page.waitForFunction(() => document.querySelectorAll('.ghrc-deep-research-tracker').length === 0);
    assert.equal(await page.locator('#ghrc-highlighted-pages').count(), 1);
    await page.evaluate(() => window.changeSetting(true));
    await page.waitForFunction(() => document.querySelectorAll('.ghrc-deep-research-tracker').length === 1);
    await page.evaluate(() => document.querySelector('[data-prompt-link-href]').remove());
    await page.waitForFunction(() => !document.getElementById('ghrc-deep-research-tracker-composer'));
    assert.equal(await page.locator('#prompt-textarea').innerText(), 'My draft');
    const section = await page.locator('#ghrc-highlighted-pages').elementHandle();
    await page.waitForTimeout(150);
    assert.equal(await section.evaluate(element => element.isConnected), true, 'Highlights must not repeatedly remount');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('homepage only shows the Deep Research embed in the final five days', async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<section><form><div id="prompt-textarea" contenteditable="true"><span contenteditable="false" data-prompt-link-href="app://connector_openai_deep_research">Deep research</span></div></form><section id="github-repositories-for-chatgpt">Repositories<footer class="ghrc-dashboard-footer"><nav class="ghrc-pagination"><button>←</button><button>→</button></nav></footer></section></section>');
    await page.evaluate(() => {
      window.__ghrcExtensionContext = { active: () => true, onStop() {} };
      const now = Date.now();
      document.documentElement.setAttribute('data-ghrc-deep-research-usage', JSON.stringify({ remaining: 13, resetAt: now + 6 * 24 * 60 * 60_000, observedAt: now }));
    });
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../js/research/deep-research-tracker.js'), 'utf8') });
    const dashboard = page.locator('#ghrc-deep-research-tracker');
    const composer = page.locator('#ghrc-deep-research-tracker-composer');
    await composer.waitFor();
    assert.equal(await dashboard.count(), 0);
    assert.match(await composer.innerText(), /13 left/);

    await page.evaluate(() => {
      const now = Date.now();
      document.documentElement.setAttribute('data-ghrc-deep-research-usage', JSON.stringify({ remaining: 13, resetAt: now + 5 * 24 * 60 * 60_000, observedAt: now }));
    });
    await page.waitForFunction(() => document.getElementById('ghrc-deep-research-tracker')?.textContent.includes('13 left')
      && !document.getElementById('ghrc-deep-research-tracker-composer'));
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
      return route.fulfill({ contentType: 'text/html', body: '<section><form><div id="prompt-textarea" contenteditable="true">My draft<span contenteditable="false" data-prompt-link-href="app://connector_openai_deep_research"></span></div></form><section id="github-repositories-for-chatgpt">Repositories<footer class="ghrc-dashboard-footer"><nav class="ghrc-pagination"><button>←</button><button>→</button></nav></footer></section></section>' });
    });
    await page.goto('https://research.test/');
    await page.evaluate(() => { window.__ghrcExtensionContext = { active: () => true, onStop() {} }; });
    for (const file of ['research/deep-research-usage.js', 'research/deep-research-tracker.js']) {
      await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../js', file), 'utf8') });
    }
    const response = await page.evaluate(async () => (await fetch('/backend-api/conversation/init', { method: 'POST', body: '{}' })).json());
    assert.equal(response.unrelated_private_field, 'must stay in page response');
    await page.waitForFunction(() => document.getElementById('ghrc-deep-research-tracker-composer')?.textContent.includes('13 left'));
    const widget = page.locator('#ghrc-deep-research-tracker-composer');
    assert.equal(await page.locator('#ghrc-deep-research-tracker').count(), 0);
    assert.match(await widget.innerText(), /13 left · resets \d+d/);
    const exposed = await page.evaluate(() => JSON.parse(document.documentElement.getAttribute('data-ghrc-deep-research-usage')));
    assert.deepEqual(Object.keys(exposed).sort(), ['observedAt', 'remaining', 'resetAt']);
    remaining = 0;
    await widget.click();
    await page.waitForFunction(() => document.getElementById('ghrc-deep-research-tracker-composer')?.textContent.includes('0 left'));
    assert.equal(requests, 2);
    assert.equal(await page.locator('#prompt-textarea').innerText(), 'My draft');
  } finally { await browser.close(); }
});


test('Research settings show the composer only when homepage allowance details are unavailable', async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<main><section><form><div id="prompt-textarea" contenteditable="true"><span contenteditable="false" data-prompt-link-href="app://connector_openai_deep_research">Research</span></div></form><section id="github-repositories-for-chatgpt">Repositories<footer class="ghrc-dashboard-footer"><nav class="ghrc-pagination"><button>←</button><button>→</button></nav></footer></section></section></main>');
    await page.evaluate(() => {
      window.__ghrcExtensionContext = { active: () => true, onStop() {} };
      window.settings = {
        showDeepResearchTracker: true, showDeepResearchHomepage: true, showDeepResearchComposer: true,
        showDeepResearchHomepageCount: true, showDeepResearchHomepageReset: false,
        showDeepResearchComposerCount: false, showDeepResearchComposerReset: true,
        deepResearchHomepageVisibility: 'always', deepResearchHomepageWindowDays: 5,
      };
      window.listeners = [];
      window.chrome = { storage: { local: { async get(defaults) { return { ...defaults, ...window.settings }; } }, onChanged: {
        addListener(listener) { window.listeners.push(listener); }, removeListener() {},
      } } };
      window.changeResearchSetting = (key, value) => {
        window.settings[key] = value;
        window.listeners.forEach(listener => listener({ [key]: { newValue: value } }, 'local'));
      };
      document.documentElement.setAttribute('data-ghrc-deep-research-usage', JSON.stringify({
        remaining: 13, resetAt: Date.now() + 10 * 24 * 3600_000, observedAt: Date.now(),
      }));
    });
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../js/research/deep-research-tracker.js'), 'utf8') });
    const homepage = page.locator('#ghrc-deep-research-tracker');
    const composer = page.locator('#ghrc-deep-research-tracker-composer');
    await homepage.waitFor();
    assert.equal(await composer.count(), 0);
    assert.match(await homepage.innerText(), /13 left/);
    assert.doesNotMatch(await homepage.innerText(), /reset/i);
    assert.doesNotMatch(await homepage.getAttribute('aria-label'), /reset/i);
    assert.equal(await homepage.evaluate(node => node.classList.contains('ghrc-research-near-reset')), false);

    await page.evaluate(() => window.changeResearchSetting('deepResearchHomepageWindowDays', 14));
    await page.waitForFunction(() => document.getElementById('ghrc-deep-research-tracker').classList.contains('ghrc-research-near-reset'));
    assert.equal(await composer.count(), 0);
    await page.evaluate(() => window.changeResearchSetting('deepResearchHomepageWindowDays', 5));
    await page.waitForFunction(() => !document.getElementById('ghrc-deep-research-tracker').classList.contains('ghrc-research-near-reset'));
    assert.equal(await composer.count(), 0);

    await page.evaluate(() => window.changeResearchSetting('deepResearchHomepageVisibility', 'near-reset'));
    await page.waitForFunction(() => !document.getElementById('ghrc-deep-research-tracker')
      && !!document.getElementById('ghrc-deep-research-tracker-composer'));
    assert.match(await composer.innerText(), /resets \d+d/);
    assert.doesNotMatch(await composer.innerText(), /13 left/);

    await page.evaluate(() => window.changeResearchSetting('deepResearchHomepageWindowDays', 14));
    await homepage.waitFor();
    await page.waitForFunction(() => !document.getElementById('ghrc-deep-research-tracker-composer'));
    assert.equal(await homepage.evaluate(node => node.classList.contains('ghrc-research-near-reset')), true);
    assert.match(await homepage.innerText(), /13 left/);

    await page.evaluate(() => window.changeResearchSetting('showDeepResearchHomepageCount', false));
    await page.waitForFunction(() => document.getElementById('ghrc-deep-research-tracker')?.getAttribute('aria-label') === 'Deep Research'
      && !!document.getElementById('ghrc-deep-research-tracker-composer'));
    assert.equal(await homepage.innerText(), '');

    await page.evaluate(() => window.changeResearchSetting('showDeepResearchHomepageReset', true));
    await page.waitForFunction(() => document.getElementById('ghrc-deep-research-tracker')?.textContent.includes('resets')
      && !document.getElementById('ghrc-deep-research-tracker-composer'));
    assert.doesNotMatch(await homepage.innerText(), /13 left/);

    await page.evaluate(() => window.changeResearchSetting('showDeepResearchHomepage', false));
    await page.waitForFunction(() => !document.getElementById('ghrc-deep-research-tracker')
      && !!document.getElementById('ghrc-deep-research-tracker-composer'));
    await page.evaluate(() => window.changeResearchSetting('showDeepResearchComposer', false));
    await page.waitForFunction(() => !document.getElementById('ghrc-deep-research-tracker-composer'));
    await page.evaluate(() => window.changeResearchSetting('showDeepResearchHomepage', true));
    await homepage.waitFor();
    await page.evaluate(() => window.changeResearchSetting('showDeepResearchTracker', false));
    await page.waitForFunction(() => !document.getElementById('ghrc-deep-research-tracker'));
    assert.equal(await composer.count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('composer allowance returns when the homepage dashboard is hidden or removed', async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<section><form><div id="prompt-textarea" contenteditable="true">Draft<span contenteditable="false" data-prompt-link-href="app://connector_openai_deep_research"></span></div></form><section id="github-repositories-for-chatgpt">Repositories<footer class="ghrc-dashboard-footer"><nav class="ghrc-pagination"><button>←</button><button>→</button></nav></footer></section></section>');
    await page.evaluate(() => {
      window.__ghrcExtensionContext = { active: () => true, onStop() {} };
      window.chrome = { storage: { local: { async get(defaults) {
        return { ...defaults, deepResearchHomepageVisibility: 'always' };
      } }, onChanged: { addListener() {}, removeListener() {} } } };
    });
    await page.addStyleTag({ content: '[data-ghrc-hide-repository-dashboard] #github-repositories-for-chatgpt { display: none !important; }' });
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../js/research/deep-research-tracker.js'), 'utf8') });
    const composer = page.locator('#ghrc-deep-research-tracker-composer');
    const homepage = page.locator('#ghrc-deep-research-tracker');
    await homepage.waitFor();
    assert.equal(await composer.count(), 0);

    await page.evaluate(() => document.documentElement.setAttribute('data-ghrc-hide-repository-dashboard', ''));
    await composer.waitFor();
    assert.equal(await homepage.count(), 0);

    await page.evaluate(() => document.documentElement.removeAttribute('data-ghrc-hide-repository-dashboard'));
    await homepage.waitFor();
    await page.waitForFunction(() => !document.getElementById('ghrc-deep-research-tracker-composer'));

    await page.evaluate(() => document.getElementById('github-repositories-for-chatgpt').remove());
    await composer.waitFor();
    assert.equal(await homepage.count(), 0);
    assert.equal(await page.locator('#prompt-textarea').innerText(), 'Draft');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
