const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

test('expired or missing quota never triggers background server refreshes', async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
  try {
    for (const bridge of [true, false]) {
      const page = await browser.newPage();
      await page.clock.install();
      await page.setContent('<form><div id="prompt-textarea" contenteditable="true"><span data-prompt-link-href="app://connector_openai_deep_research">Research</span></div></form>');
      await page.evaluate(bridge => {
        window.__ghrcExtensionContext = { active: () => true, onStop() {} };
        window.refreshRequests = 0;
        window.claims = 0;
        window.addEventListener('ghrc-refresh-deep-research-usage', () => window.refreshRequests++);
        if (bridge) window.chrome = { runtime: { async sendMessage(message) {
          if (message.type === 'deep-research-quota-refresh-claim') window.claims++;
          return { ok: true, refresh: true, quota: { remaining: 3, observedAt: Date.now() - 9 * 3600_000, resetAt: null } };
        } } };
      }, bridge);
      await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../js/research/deep-research-tracker.js'), 'utf8') });
      await page.clock.runFor(120_000);
      assert.equal(await page.evaluate(() => window.refreshRequests), 0);
      assert.equal(await page.evaluate(() => window.claims), 0);
      await page.close();
    }
  } finally { await browser.close(); }
});

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
    await page.waitForFunction(() => document.getElementById('ghrc-deep-research-tracker')
      && document.getElementById('ghrc-deep-research-tracker-composer'));
    assert.equal(await page.locator('#ghrc-deep-research-tracker').count(), 1);
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
      && document.getElementById('ghrc-deep-research-tracker-composer')?.textContent.includes('13 left'));
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


test('homepage and active research composer render independently and keep their own allowance fields', async () => {
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
        deepResearchAllowanceMode: 'full', deepResearchUsagePieTotal: null,
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
    await page.addStyleTag({ content: fs.readFileSync(path.join(__dirname, '../css/deep-research-tracker.css'), 'utf8') });
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../js/research/deep-research-tracker.js'), 'utf8') });
    const homepage = page.locator('#ghrc-deep-research-tracker');
    const composer = page.locator('#ghrc-deep-research-tracker-composer');
    await homepage.waitFor();
    await composer.waitFor();
    assert.match(await composer.innerText(), /resets \d+d/);
    assert.doesNotMatch(await composer.innerText(), /13 left/);
    assert.match(await homepage.innerText(), /13 left/);
    assert.doesNotMatch(await homepage.innerText(), /reset/i);
    const pie = homepage.locator('.ghrc-research-usage-pie');
    assert.equal(await pie.isVisible(), false, 'pie is opt-in by default');
    await page.evaluate(() => window.changeResearchSetting('showDeepResearchUsagePie', true));
    await page.waitForFunction(() => !document.querySelector('#ghrc-deep-research-tracker .ghrc-research-usage-pie').hidden);
    assert.equal(await pie.isVisible(), true, 'full-only Auto mode renders a visible pie without a server total');
    assert.match(await homepage.getAttribute('title'), /13 of 25 full reports remaining.*estimated allowance/);
    await page.evaluate(() => window.changeResearchSetting('deepResearchUsagePieTotal', 20));
    await page.waitForFunction(() => document.getElementById('ghrc-deep-research-tracker').title.includes('13 of 20'));
    assert.doesNotMatch(await homepage.getAttribute('title'), /estimated allowance/);
    await page.evaluate(() => window.changeResearchSetting('deepResearchUsagePieTotal', null));
    await page.waitForFunction(() => document.getElementById('ghrc-deep-research-tracker').title.includes('13 of 25'));
    assert.equal(await homepage.innerText(), '', 'pie replaces only the visible report count');
    assert.equal(await homepage.getAttribute('aria-label'), 'Deep Research · 13 left');
    assert.match(await pie.evaluate(node => node.style.background), /conic-gradient\(from 0deg/i);
    assert.match(await pie.evaluate(node => node.style.background), /172\.8deg.*360deg/i);
    assert.match(await pie.evaluate(node => node.style.background), /--ghrc-composer-toolbar-icon/);
    // Existing toolbar colors take effect without remounting the tracker.
    const regularBefore = await pie.evaluate(node => getComputedStyle(node).backgroundImage);
    await page.evaluate(() => document.documentElement.style.setProperty('--ghrc-composer-toolbar-icon', '#376ac8'));
    const regularAfter = await pie.evaluate(node => getComputedStyle(node).backgroundImage);
    assert.notEqual(regularAfter, regularBefore, 'pie follows the toolbar icon preference');
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-ghrc-deep-research-usage', JSON.stringify({
        remaining: 2, resetAt: Date.now() + 10 * 24 * 3600_000, observedAt: Date.now(),
      }));
    });
    await page.waitForFunction(() => document.querySelector('#ghrc-deep-research-tracker')?.getAttribute('aria-label')?.includes('2 left'));
    assert.match(await pie.evaluate(node => node.style.background), /--ghrc-composer-send-hover/);
    const warningBefore = await pie.evaluate(node => getComputedStyle(node).backgroundImage);
    await page.evaluate(() => document.documentElement.style.setProperty('--ghrc-composer-send-hover', '#b24bdf'));
    const warningAfter = await pie.evaluate(node => getComputedStyle(node).backgroundImage);
    assert.notEqual(warningAfter, warningBefore, 'low balance follows send hover preference');
    await page.evaluate(() => {
      document.documentElement.style.removeProperty('--ghrc-composer-send-hover');
      document.documentElement.style.setProperty('--ghrc-composer-focus-ring', '#0c9b7a');
    });
    const warningFocus = await pie.evaluate(node => getComputedStyle(node).backgroundImage);
    assert.notEqual(warningFocus, warningBefore, 'focus-ring setting supplies the low-balance fallback');
    assert.notEqual(warningFocus, warningAfter, 'warning colors update the pie live');
    await page.evaluate(() => {
      window.changeResearchSetting('deepResearchAllowanceMode', 'all');
      window.changeResearchSetting('deepResearchUsagePieTotal', null);
      document.documentElement.setAttribute('data-ghrc-deep-research-usage', JSON.stringify({
        remaining: 20, miniRemaining: 6,
        resetAt: Date.now() + 10 * 24 * 3600_000, observedAt: Date.now(),
      }));
    });
    await page.waitForFunction(() => document.querySelector('#ghrc-deep-research-tracker')?.getAttribute('aria-label')?.includes('26 left'));
    assert.equal(await pie.isVisible(), true, 'combined balances above 25 use the estimated scale');
    assert.match(await homepage.getAttribute('title'), /26 of 250.*estimated allowance/);
    await page.evaluate(() => {
      window.changeResearchSetting('deepResearchUsagePieTotal', 200);
      document.documentElement.setAttribute('data-ghrc-deep-research-usage', JSON.stringify({
        remaining: 60, miniRemaining: 40, resetAt: Date.now() + 10 * 24 * 3600_000, observedAt: Date.now(),
      }));
    });
    await page.waitForFunction(() => document.querySelector('#ghrc-deep-research-tracker')?.getAttribute('title')?.includes('100 of 200'));
    assert.match(await pie.evaluate(node => node.style.background), /180deg.*360deg/i);
    await page.evaluate(() => {
      window.changeResearchSetting('deepResearchUsagePieTotal', null);
      document.documentElement.setAttribute('data-ghrc-deep-research-usage', JSON.stringify({
        remaining: 60, total: 70, miniRemaining: 30, miniTotal: 30,
        resetAt: Date.now() + 10 * 24 * 3600_000, observedAt: Date.now(),
      }));
    });
    await page.waitForFunction(() => document.querySelector('#ghrc-deep-research-tracker')?.getAttribute('title')?.includes('90 of 100'));
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-ghrc-deep-research-usage', JSON.stringify({
        remaining: 200, miniRemaining: 51,
        resetAt: Date.now() + 10 * 24 * 3600_000, observedAt: Date.now(),
      }));
    });
    await page.waitForFunction(() => document.querySelector('#ghrc-deep-research-tracker')?.textContent.includes('251 left'));
    assert.equal(await pie.isVisible(), false, 'unknown high allowances keep their exact text');
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-ghrc-deep-research-usage', JSON.stringify({
        remaining: 13, resetAt: Date.now() + 10 * 24 * 3600_000, observedAt: Date.now(),
      }));
      window.changeResearchSetting('showDeepResearchUsagePie', false);
      window.changeResearchSetting('deepResearchAllowanceMode', 'full');
    });
    await page.waitForFunction(() => document.getElementById('ghrc-deep-research-tracker')?.textContent.includes('13 left'));
    assert.doesNotMatch(await homepage.getAttribute('aria-label'), /reset/i);
    await page.evaluate(() => window.changeResearchSetting('deepResearchAllowanceMode', 'all'));
    await page.waitForFunction(() => document.getElementById('ghrc-deep-research-tracker')?.textContent.includes('unavailable'));
    await page.evaluate(() => window.changeResearchSetting('deepResearchAllowanceMode', 'full'));
    await page.waitForFunction(() => document.getElementById('ghrc-deep-research-tracker')?.textContent.includes('13 left'));
    assert.equal(await homepage.evaluate(node => node.classList.contains('ghrc-research-near-reset')), false);

    // A custom combined allowance must not change the full-only pie denominator.
    await page.evaluate(() => {
      window.changeResearchSetting('showDeepResearchUsagePie', true);
      window.changeResearchSetting('deepResearchUsagePieTotals', { full: 20, all: 200 });
      document.documentElement.setAttribute('data-ghrc-deep-research-usage', JSON.stringify({
        remaining: 13, miniRemaining: 7,
        resetAt: Date.now() + 10 * 24 * 3600_000, observedAt: Date.now(),
      }));
    });
    await page.waitForFunction(() => document.querySelector('#ghrc-deep-research-tracker')?.title.includes('13 of 20 full reports'));
    await page.evaluate(() => window.changeResearchSetting('deepResearchAllowanceMode', 'all'));
    await page.waitForFunction(() => document.querySelector('#ghrc-deep-research-tracker')?.title.includes('20 of 200 full + lightweight reports'));
    await page.evaluate(() => window.changeResearchSetting('deepResearchAllowanceMode', 'full'));
    await page.waitForFunction(() => document.querySelector('#ghrc-deep-research-tracker')?.title.includes('13 of 20 full reports'));
    await page.evaluate(() => window.changeResearchSetting('deepResearchUsagePieTotals', { full: null, all: 200 }));
    await page.waitForFunction(() => document.querySelector('#ghrc-deep-research-tracker')?.title.includes('13 of 25 full reports'));
    await page.evaluate(() => {
      window.changeResearchSetting('showDeepResearchUsagePie', false);
      window.changeResearchSetting('deepResearchUsagePieTotals', { full: null, all: null });
    });

    // Homepage window changes cannot remove the selected in-chat tracker.
    await page.evaluate(() => window.changeResearchSetting('deepResearchHomepageWindowDays', 14));
    await page.waitForFunction(() => document.getElementById('ghrc-deep-research-tracker').classList.contains('ghrc-research-near-reset'));
    assert.equal(await composer.count(), 1);
    await page.evaluate(() => window.changeResearchSetting('deepResearchHomepageWindowDays', 5));
    await page.waitForFunction(() => !document.getElementById('ghrc-deep-research-tracker').classList.contains('ghrc-research-near-reset'));
    assert.equal(await composer.count(), 1);

    await page.evaluate(() => window.changeResearchSetting('deepResearchHomepageVisibility', 'near-reset'));
    await page.waitForFunction(() => !document.getElementById('ghrc-deep-research-tracker'));
    assert.match(await composer.innerText(), /resets \d+d/);
    assert.doesNotMatch(await composer.innerText(), /left/);

    await page.evaluate(() => window.changeResearchSetting('deepResearchHomepageWindowDays', 14));
    await homepage.waitFor();
    assert.equal(await composer.count(), 1);

    await page.evaluate(() => window.changeResearchSetting('showDeepResearchHomepageCount', false));
    await page.waitForFunction(() => document.getElementById('ghrc-deep-research-tracker')?.getAttribute('aria-label') === 'Deep Research');
    assert.equal(await homepage.innerText(), '');
    assert.match(await composer.innerText(), /resets \d+d/);

    await page.evaluate(() => window.changeResearchSetting('showDeepResearchHomepageReset', true));
    await page.waitForFunction(() => document.getElementById('ghrc-deep-research-tracker')?.textContent.includes('resets'));
    assert.doesNotMatch(await homepage.innerText(), /left/);
    assert.match(await composer.innerText(), /resets \d+d/);

    await page.evaluate(() => window.changeResearchSetting('showDeepResearchComposerCount', true));
    await page.waitForFunction(() => document.getElementById('ghrc-deep-research-tracker-composer')?.getAttribute('aria-label')?.includes('13 left'));
    assert.match(await composer.innerText(), /resets \d+d/);
    await page.evaluate(() => window.changeResearchSetting('showDeepResearchComposerReset', false));
    await page.waitForFunction(() => document.getElementById('ghrc-deep-research-tracker-composer')?.getAttribute('aria-label') === 'Deep Research · 13 left');
    assert.doesNotMatch(await composer.innerText(), /reset/i);
    assert.match(await homepage.innerText(), /reset/i);

    // Each location also has its own usage-pie switch.
    await page.evaluate(() => {
      window.changeResearchSetting('showDeepResearchHomepageCount', true);
      window.changeResearchSetting('showDeepResearchHomepagePie', true);
      window.changeResearchSetting('showDeepResearchComposerPie', false);
    });
    await page.waitForFunction(() => !document.querySelector('#ghrc-deep-research-tracker .ghrc-research-usage-pie').hidden);
    assert.equal(await composer.locator('.ghrc-research-usage-pie').isVisible(), false);
    await page.evaluate(() => {
      window.changeResearchSetting('showDeepResearchHomepagePie', false);
      window.changeResearchSetting('showDeepResearchComposerPie', true);
    });
    await page.waitForFunction(() => document.querySelector('#ghrc-deep-research-tracker .ghrc-research-usage-pie').hidden
      && !document.querySelector('#ghrc-deep-research-tracker-composer .ghrc-research-usage-pie').hidden);

    await page.evaluate(() => window.changeResearchSetting('showDeepResearchHomepage', false));
    await page.waitForFunction(() => !document.getElementById('ghrc-deep-research-tracker'));
    assert.equal(await composer.count(), 1);
    await page.evaluate(() => window.changeResearchSetting('showDeepResearchHomepage', true));
    await homepage.waitFor();
    assert.equal(await composer.count(), 1);

    await page.evaluate(() => window.changeResearchSetting('showDeepResearchComposer', false));
    await page.waitForFunction(() => !document.getElementById('ghrc-deep-research-tracker-composer'));
    assert.equal(await homepage.count(), 1);
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
    await composer.waitFor();

    await page.evaluate(() => document.documentElement.setAttribute('data-ghrc-hide-repository-dashboard', ''));
    await composer.waitFor();
    assert.equal(await homepage.count(), 0);

    await page.evaluate(() => document.documentElement.removeAttribute('data-ghrc-hide-repository-dashboard'));
    await homepage.waitFor();
    assert.equal(await composer.count(), 1);

    await page.evaluate(() => document.getElementById('github-repositories-for-chatgpt').remove());
    await composer.waitFor();
    assert.equal(await homepage.count(), 0);
    assert.equal(await page.locator('#prompt-textarea').innerText(), 'Draft');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('unrelated response streaming does not schedule Deep Research tracker scans', async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<form><div id="prompt-textarea" contenteditable="true">Draft</div></form>'
      + '<section id="github-repositories-for-chatgpt"><footer class="ghrc-dashboard-footer"></footer></section>'
      + '<article><div id="unrelated-stream"></div></article>');
    await page.evaluate(() => {
      window.__ghrcExtensionContext = { active: () => true, onStop() {} };
      window.chrome = { storage: { local: { async get(defaults) {
        return { ...defaults, deepResearchHomepageVisibility: 'always' };
      } }, onChanged: { addListener() {}, removeListener() {} } } };
      const realFrame = window.requestAnimationFrame.bind(window);
      window.trackerFrames = 0;
      window.requestAnimationFrame = callback => {
        window.trackerFrames += 1;
        return realFrame(callback);
      };
    });
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../js/research/deep-research-tracker.js'), 'utf8') });
    await page.locator('#ghrc-deep-research-tracker').waitFor();
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      window.trackerFrames = 0;
      const stream = document.getElementById('unrelated-stream');
      for (let i = 0; i < 100; i++) stream.append(document.createTextNode(String(i)));
    });
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => window.trackerFrames), 0, 'unrelated streaming does not request tracker frames');
    await page.evaluate(() => {
      const mention = document.createElement('span');
      mention.setAttribute('data-prompt-link-href', 'app://connector_openai_deep_research');
      document.querySelector('#prompt-textarea').append(mention);
    });
    await page.locator('#ghrc-deep-research-tracker-composer').waitFor();
  } finally { await browser.close(); }
});

test('eight-hour quota cache does not poll after five minutes and sends are counted only on confirmed turns', async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<form><div id="prompt-textarea" contenteditable="true"><span data-prompt-link-href="app://connector_openai_deep_research">Deep research</span></div><button data-testid="send-button" type="button">Send</button></form><section id="github-repositories-for-chatgpt"><footer class="ghrc-dashboard-footer"></footer></section>');
    await page.evaluate(() => {
      window.__ghrcExtensionContext = { active: () => true, onStop() {} };
      window.writes = [];
      window.chrome = { storage: { local: { async get() { return {}; } }, onChanged: { addListener() {}, removeListener() {} } },
        runtime: { async sendMessage(message) {
          window.writes.push(message);
          if (message.type === 'deep-research-quota-read') return { ok: true, quota: { remaining: 4, observedAt: Date.now() - 6 * 60_000, resetAt: Date.now() + 20 * 24 * 3600_000 } };
          if (message.type === 'deep-research-quota-spent') return { ok: true, quota: { remaining: 3, observedAt: Date.now() - 6 * 60_000, resetAt: Date.now() + 20 * 24 * 3600_000 } };
          return { ok: true, quota: null, refresh: false };
        } } };
    });
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../js/research/deep-research-tracker.js'), 'utf8') });
    await page.waitForFunction(() => document.getElementById('ghrc-deep-research-tracker-composer')?.textContent.includes('4 left'));
    // A native Send click alone is not a successful research run.
    await page.locator('[data-testid="send-button"]').click();
    assert.equal(await page.evaluate(() => window.writes.filter(m => m.type === 'deep-research-quota-spent').length), 0);
    await page.evaluate(() => {
      const turn = document.createElement('div');
      turn.dataset.messageAuthorRole = 'user';
      turn.textContent = 'Research started';
      document.body.append(turn);
    });
    await page.waitForFunction(() => document.getElementById('ghrc-deep-research-tracker-composer')?.textContent.includes('3 left'));
    assert.equal(await page.evaluate(() => window.writes.filter(m => m.type === 'deep-research-quota-spent').length), 1);
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(() => window.writes.filter(m => m.type === 'deep-research-quota-refresh-claim').length), 0);
  } finally { await browser.close(); }
});

test('expected reset countdown stays visible until native quota confirms renewal', async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<section><form><div id="prompt-textarea" contenteditable="true"><span data-prompt-link-href="app://connector_openai_deep_research">Research</span></div></form><section id="github-repositories-for-chatgpt"><footer class="ghrc-dashboard-footer"></footer></section></section>');
    await page.evaluate(() => {
      window.__ghrcExtensionContext = { active: () => true, onStop() {} };
      document.documentElement.setAttribute('data-ghrc-deep-research-usage', JSON.stringify({
        remaining: 0, observedAt: Date.now() - 6 * 60_000, resetAt: Date.now() - 30_000,
      }));
    });
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../js/research/deep-research-tracker.js'), 'utf8') });
    // An overdue reset estimate keeps the homepage tracker visible; it must
    // not imply that the server has actually replenished the allowance.
    const widget = page.locator('#ghrc-deep-research-tracker');
    await widget.waitFor();
    assert.match(await widget.innerText(), /0 last checked/);
    assert.match(await widget.innerText(), /reset expected · awaiting confirmation/);
    const marker = await widget.getAttribute('aria-label');
    assert.doesNotMatch(marker, /resets 1d|reset completed/i);
  } finally { await browser.close(); }
});
