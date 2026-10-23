const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');

test('import chooses a category, cancellation never publishes, and report links escape the sandbox', async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('https://example.com/', route => route.fulfill({ body: '<html></html>', contentType: 'text/html' }));
    await page.goto('https://example.com');
    await page.setContent('<section><div><button aria-label="Export">Export</button><button aria-label="Expand">Expand</button></div><article class="_reportPage_fixture"><h1>Report</h1><p>Full report <a href="https://example.org/source" target="_blank">Source</a></p></article></section>');
    await page.evaluate(() => {
      window.calls = [];
      window.chrome = { storage: { local: { get: async d => ({ ...d, researchPublisherEnabled: true }) }, onChanged: { addListener() {} } }, runtime: { sendMessage: async m => {
        window.calls.push(m);
        if (m.type === 'research-publisher-status') return { ok: true, repository: 'Research', branch: 'main', categories: ['Markets', 'Markets/Ownership', 'Markets/Trading'], contents: { Markets: ['overview.md'], 'Markets/Ownership': ['holders.md'] } };
        return { ok: true, repository: 'Research', branch: 'main', path: 'Markets/report.md', url: 'https://github.com/example/Research/blob/main/Markets/report.md' };
      } } };
    });
    for (const file of ['vendor/turndown.js', 'vendor/turndown-plugin-gfm.js', 'js/research/research-import-dialog.js', 'js/research/research-publisher.js']) await page.addScriptTag({ content: fs.readFileSync(file, 'utf8') });
    const button = page.getByRole('button', { name: 'Add to repo', exact: true });
    await button.click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('button', { name: '📁 Markets', exact: true }).hover();
    assert.match(await page.locator('.ghrc-folder-preview').innerText(), /Ownership/);
    assert.match(await page.locator('.ghrc-folder-preview').innerText(), /overview.md/);
    await page.getByRole('button', { name: '📁 Markets', exact: true }).click();
    await page.getByRole('button', { name: '📁 Ownership', exact: true }).hover();
    assert.match(await page.locator('.ghrc-folder-preview').innerText(), /holders.md/);
    assert.equal(await page.locator('.ghrc-folder-list').innerText(), '📁 Ownership\n📁 Trading');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await page.evaluate(() => calls.filter(x => x.type === 'publish-research-report').length), 0);
    await button.click();
    await page.getByRole('textbox', { name: 'Category' }).fill('Markets');
    await page.getByRole('button', { name: 'Import report', exact: true }).click();
    await page.waitForFunction(() => calls.some(x => x.type === 'publish-research-report'));
    const report = await page.evaluate(() => calls.find(x => x.type === 'publish-research-report'));
    assert.equal(report.category, 'Markets');
    assert.match(report.markdown, /# Report/);
    assert.match(report.markdown, /Full report/);
    await page.getByRole('link', { name: 'https://github.com/example/Research/blob/main/Markets/report.md', exact: true }).waitFor();
    await page.getByRole('link', { name: 'Source' }).click();
    assert.equal(await page.evaluate(() => calls.filter(x => x.type === 'open-research-link').length), 1);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('fullscreen hides both composer versions and restores them when the report closes', async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<form><div id="prompt-textarea">Draft</div></form><div data-composer-surface-variant="inline"><div data-composer-markdown>New draft</div></div><div style="position:fixed;inset:0"><iframe></iframe></div>');
    await page.evaluate(() => { window.chrome = { runtime: { onMessage: { addListener() {} } } }; });
    await page.addScriptTag({ content: fs.readFileSync('js/research/research-report-host.js', 'utf8') });
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { origin: 'https://mcp-app-abc123.web-sandbox.oaiusercontent.com', source: document.querySelector('iframe').contentWindow, data: { type: 'ghrc-research-report-state', report: true } })));
    assert.equal(await page.locator('form').evaluate(n => getComputedStyle(n).visibility), 'hidden');
    assert.equal(await page.locator('[data-composer-surface-variant]').evaluate(n => getComputedStyle(n).visibility), 'hidden');
    await page.locator('iframe').evaluate(n => n.parentElement.remove());
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-ghrc-research-fullscreen'));
    assert.equal(await page.locator('form').evaluate(n => getComputedStyle(n).visibility), 'visible');
    assert.equal(await page.locator('[data-composer-markdown]').innerText(), 'New draft');
  } finally { await browser.close(); }
});

test('report host observes only active frames and disconnects after finalization', async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<form><div id="prompt-textarea">Draft</div></form>'
      + '<div style="position:fixed;inset:0"><iframe></iframe></div>');
    await page.evaluate(() => {
      const NativeObserver = window.MutationObserver;
      window.observerCounts = { attached: 0, detached: 0, active: 0 };
      window.MutationObserver = class extends NativeObserver {
        observe(...args) {
          window.observerCounts.attached += 1;
          window.observerCounts.active += 1;
          return super.observe(...args);
        }
        disconnect() {
          window.observerCounts.detached += 1;
          window.observerCounts.active = Math.max(0, window.observerCounts.active - 1);
          return super.disconnect();
        }
      };
      window.chrome = { runtime: { onMessage: { addListener() {} } } };
      window.reportMessage = (type, frame = document.querySelector('iframe'), origin = 'https://mcp-app-abc123.web-sandbox.oaiusercontent.com') => {
        window.dispatchEvent(new MessageEvent('message', {
          origin, source: frame.contentWindow,
          data: { type, report: true },
        }));
      };
    });
    await page.addScriptTag({ content: fs.readFileSync('js/research/research-report-host.js', 'utf8') });
    assert.equal(await page.evaluate(() => observerCounts.attached), 0,
      'ordinary ChatGPT tabs must not start a document-wide observer');
    await page.evaluate(() => reportMessage('ghrc-research-report-state'));
    assert.equal(await page.evaluate(() => observerCounts.active), 1);
    assert.equal(await page.locator('form').evaluate(node => getComputedStyle(node).visibility), 'hidden');

    await page.evaluate(() => reportMessage('ghrc-research-report-finalized',
      document.querySelector('iframe'), 'https://untrusted.example'));
    assert.equal(await page.evaluate(() => observerCounts.active), 1,
      'untrusted completion messages cannot end the report lifecycle');

    await page.evaluate(() => reportMessage('ghrc-research-report-finalized'));
    assert.equal(await page.evaluate(() => observerCounts.active), 0,
      'successful finalization releases the active observer');
    assert.equal(await page.locator('form').evaluate(node => getComputedStyle(node).visibility), 'visible');
    await page.evaluate(() => reportMessage('ghrc-research-report-state'));
    assert.equal(await page.evaluate(() => observerCounts.active), 0,
      'stale report-state pings cannot restart a finalized frame');

    await page.evaluate(() => {
      const next = document.createElement('iframe');
      next.style.cssText = 'width:100vw;height:100vh';
      document.querySelector('iframe').after(next);
      reportMessage('ghrc-research-report-state', next);
    });
    assert.equal(await page.evaluate(() => observerCounts.active), 1,
      'an independent later report can start its own observer');
    await page.locator('iframe').last().evaluate(node => node.remove());
    await page.waitForFunction(() => observerCounts.active === 0);
    assert.equal(await page.locator('form').evaluate(node => getComputedStyle(node).visibility), 'visible');
  } finally { await browser.close(); }
});

test('successful manual repository import stops sandbox observer and polling', async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<section><div><button aria-label="Export">Export</button><button aria-label="Expand">Expand</button></div>'
      + '<article class="_reportPage_fixture"><h1>Final report</h1><p>Completed analysis</p></article></section>');
    await page.evaluate(() => {
      const NativeObserver = window.MutationObserver;
      const nativeInterval = window.setInterval.bind(window);
      const nativeClear = window.clearInterval.bind(window);
      window.monitoring = { observers: 0, polling: new Set(), signals: [], calls: [] };
      window.MutationObserver = class extends NativeObserver {
        observe(...args) {
          window.monitoring.observers += 1;
          return super.observe(...args);
        }
        disconnect() {
          window.monitoring.observers = Math.max(0, window.monitoring.observers - 1);
          return super.disconnect();
        }
      };
      window.setInterval = (callback, delay, ...args) => {
        const id = nativeInterval(callback, delay, ...args);
        if (delay === 1000) window.monitoring.polling.add(id);
        return id;
      };
      window.clearInterval = id => {
        window.monitoring.polling.delete(id);
        return nativeClear(id);
      };
      window.postMessage = (data, target) => {
        window.monitoring.signals.push({ type: data.type, target });
      };
      window.chrome = { storage: { local: {
        get: async defaults => ({ ...defaults, researchPublisherEnabled: true }),
      }, onChanged: { addListener() {} } }, runtime: { sendMessage: async message => {
        window.monitoring.calls.push(message.type);
        if (message.type === 'research-launch-job') return { ok: true, job: null };
        if (message.type === 'research-publisher-status') return {
          ok: true, repository: 'Research', branch: 'main', categories: ['Markets'], contents: {},
        };
        return { ok: true, repository: 'Research', branch: 'main',
          path: 'Markets/final-report.md', url: 'https://github.com/example/Research/blob/main/Markets/final-report.md' };
      } } };
    });
    for (const file of ['vendor/turndown.js', 'vendor/turndown-plugin-gfm.js',
      'js/research/research-import-dialog.js', 'js/research/research-publisher.js'])
      await page.addScriptTag({ content: fs.readFileSync(file, 'utf8') });
    await page.getByRole('button', { name: 'Add to repo', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('button', { name: '📁 Markets', exact: true }).click();
    await page.getByRole('button', { name: 'Import report', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.ghrc-report-status')?.textContent.includes('Imported:'));
    assert.deepEqual(await page.evaluate(() => ({
      observers: monitoring.observers, polling: monitoring.polling.size,
      finalSignals: monitoring.signals.filter(m => m.type === 'ghrc-research-report-finalized'),
    })), { observers: 0, polling: 0, finalSignals: [
      { type: 'ghrc-research-report-finalized', target: 'https://chatgpt.com' },
    ] });
    const scans = await page.evaluate(() => monitoring.calls.filter(type => type === 'research-launch-job').length);
    await page.waitForTimeout(1200);
    assert.equal(await page.evaluate(() => monitoring.calls.filter(type => type === 'research-launch-job').length), scans,
      'completed reports must not resume the 1-second background scans');
  } finally { await browser.close(); }
});

test('disabled publishing does not start a one-second background scanner', async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<section><button aria-label="Export">Export</button>'
      + '<article class="_reportPage_fixture"><h1>Read-only report</h1></article></section>');
    await page.evaluate(() => {
      window.oneSecondTimers = [];
      const realInterval = window.setInterval.bind(window);
      window.setInterval = (callback, delay, ...args) => {
        window.oneSecondTimers.push(delay);
        return realInterval(callback, delay, ...args);
      };
      window.chrome = {
        storage: { local: { get: async defaults => ({ ...defaults, researchPublisherEnabled: false }) },
          onChanged: { addListener() {} } },
        runtime: { sendMessage: async () => { throw new Error('Publisher is disabled'); } },
      };
    });
    await page.addScriptTag({ content: fs.readFileSync('js/research/research-publisher.js', 'utf8') });
    await page.waitForTimeout(50);
    assert.deepEqual(await page.evaluate(() => oneSecondTimers), [],
      'disabled publisher should rely on DOM events instead of periodic scans');
    assert.equal(await page.getByRole('button', { name: 'Add to repo' }).count(), 0);
  } finally { await browser.close(); }
});

test('import confirmation links open through the bridge inside a sandbox frame', async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<iframe sandbox="allow-scripts allow-same-origin" srcdoc="<div role=status></div>"></iframe>');
    const frame = page.frames()[1];
    await frame.evaluate(() => {
      window.calls = [];
      window.chrome = { runtime: { sendMessage: async message => { calls.push(message); return { ok: true }; } } };
    });
    await frame.addScriptTag({ content: fs.readFileSync('js/research/research-import-dialog.js', 'utf8') });
    await frame.evaluate(() => window.__ghrcResearchImportStatus(document.querySelector('[role=status]'), {
      repository: 'Research', branch: 'main', path: 'report.md', url: 'https://github.com/example/Research/blob/main/report.md',
    }));
    await frame.getByRole('link').click();
    assert.deepEqual(await frame.evaluate(() => calls), [{ type: 'open-research-link', url: 'https://github.com/example/Research/blob/main/report.md' }]);
    // A second identical import must restore a status that was replaced by progress text.
    await frame.evaluate(() => {
      const status = document.querySelector('[role=status]');
      status.textContent = 'Adding report…';
      window.__ghrcResearchImportStatus(status, { repository: 'Research', branch: 'main', path: 'report.md', url: 'https://github.com/example/Research/blob/main/report.md' });
    });
    assert.equal(await frame.getByRole('link').count(), 1);
  } finally { await browser.close(); }
});


test('filename context uses the prompt preceding the report, not an earlier or later turn', async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<title>New chat - ChatGPT</title><div data-message-author-role="user">Old unrelated topic</div><iframe src="about:blank" width="500"></iframe><div data-message-author-role="user">DTC Bond Purchaser Tracking</div><iframe src="about:blank" width="500"></iframe><div data-message-author-role="user">Later unrelated topic</div>');
    await page.locator('iframe').first().evaluate(frame => { frame.setAttribute('src', 'https://mcp-app-abc123.web-sandbox.oaiusercontent.com/old-report'); });
    await page.locator('iframe').last().evaluate(frame => { frame.setAttribute('src', 'https://mcp-app-abc123.web-sandbox.oaiusercontent.com/report'); });
    await page.evaluate(() => { window.chrome = { runtime: { onMessage: { addListener(listener) { window.contextListener = listener; } } } }; });
    await page.addScriptTag({ content: fs.readFileSync('js/research/research-report-host.js', 'utf8') });
    const context = await page.evaluate(() => new Promise(resolve => contextListener({ type: 'research-report-context', reportUrl: 'https://mcp-app-abc123.web-sandbox.oaiusercontent.com/report' }, {}, resolve)));
    assert.equal(context.title, 'DTC Bond Purchaser Tracking');
    assert.equal(context.prompt, 'DTC Bond Purchaser Tracking');
  } finally { await browser.close(); }
});


test('root shortcut finishes immediately from a nested folder in both chooser modes', async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 560, height: 520 } });
    await page.setContent('<body></body>');
    await page.addScriptTag({ content: fs.readFileSync('js/research/research-import-dialog.js', 'utf8') });
    for (const launch of [false, true]) {
      await page.evaluate(launch => {
        window.chosen = undefined;
        window.__ghrcChooseResearchCategory(document, { repository: 'Research', branch: 'main', categories: ['Markets', 'Markets/Ownership'] }, launch).then(value => { window.chosen = value; });
      }, launch);
      await page.getByRole('button', { name: '📁 Markets', exact: true }).click();
      assert.equal(await page.getByRole('textbox', { name: 'Category' }).inputValue(), 'Markets');
      await page.getByRole('button', { name: launch ? 'Start at root' : 'Import to root', exact: true }).click();
      await page.waitForFunction(() => window.chosen === '');
      assert.equal(await page.getByRole('dialog').count(), 0);
    }
  } finally { await browser.close(); }
});

test('stale report scripts explain recovery instead of exposing a missing runtime error', async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<section><div><button aria-label="Export">Export</button><button aria-label="Expand">Expand</button></div><article class="_reportPage_fixture"><h1>Report</h1><p>Full report</p></article></section>');
    await page.evaluate(() => {
      window.chrome = { storage: { local: { get: async d => ({ ...d, researchPublisherEnabled: true }) }, onChanged: { addListener() {} } }, runtime: { sendMessage: async () => ({ ok: true }) } };
    });
    for (const file of ['vendor/turndown.js', 'vendor/turndown-plugin-gfm.js', 'js/research/research-import-dialog.js', 'js/research/research-publisher.js']) await page.addScriptTag({ content: fs.readFileSync(file, 'utf8') });
    const button = page.getByRole('button', { name: 'Add to repo', exact: true });
    await button.waitFor();
    await page.evaluate(() => { delete chrome.runtime; });
    await button.click();
    assert.match(await page.locator('.ghrc-report-status').innerText(), /Reload this ChatGPT page/);
    assert.equal(await button.isEnabled(), true);
    assert.equal(await page.getByRole('dialog').count(), 0);
  } finally { await browser.close(); }
});

test('stale report scripts explain recovery instead of exposing a missing runtime error', async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<section><div><button aria-label="Export">Export</button><button aria-label="Expand">Expand</button></div><article class="_reportPage_fixture"><h1>Report</h1><p>Full report</p></article></section>');
    await page.evaluate(() => {
      window.chrome = { storage: { local: { get: async d => ({ ...d, researchPublisherEnabled: true }) }, onChanged: { addListener() {} } }, runtime: { sendMessage: async () => ({ ok: true }) } };
    });
    for (const file of ['vendor/turndown.js', 'vendor/turndown-plugin-gfm.js', 'js/research/research-import-dialog.js', 'js/research/research-publisher.js']) await page.addScriptTag({ content: fs.readFileSync(file, 'utf8') });
    const button = page.getByRole('button', { name: 'Add to repo', exact: true });
    await button.waitFor();
    await page.evaluate(() => { delete chrome.runtime; });
    await button.click();
    assert.match(await page.locator('.ghrc-report-status').innerText(), /Reload this ChatGPT page/);
    assert.equal(await button.isEnabled(), true);
    assert.equal(await page.getByRole('dialog').count(), 0);
  } finally { await browser.close(); }
});


test('automatic import exposes lookup and terminal errors, then resumes after recovery', async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<section><div><button aria-label="Export">Export</button><button aria-label="Expand">Expand</button></div><article class="_reportPage_fixture"><h1>Recovered report</h1><p>Complete evidence.</p></article></section>');
    await page.evaluate(() => {
      window.mode = 'lookup-error';
      window.imports = 0;
      window.chrome = { storage: { local: { get: async d => ({ ...d, researchPublisherEnabled: true }) }, onChanged: { addListener() {} } }, runtime: { sendMessage: async m => {
        if (m.type === 'research-launch-job') {
          if (mode === 'lookup-error') return { ok: false, error: 'Research page is reconnecting. Retrying automatic import…' };
          if (mode === 'terminal-error') return { ok: true, job: { state: 'import-error', error: 'The linked repository changed during research.' } };
          if (mode === 'complete') return { ok: true, job: { state: 'complete', result: { repository: 'Research', branch: 'main', path: 'recovered.md' } } };
          return { ok: true, job: { id: 'recovered', state: 'submitted' } };
        }
        if (m.type === 'publish-research-report') {
          imports++;
          window.mode = 'complete';
          return { ok: true, repository: 'Research', branch: 'main', path: 'recovered.md' };
        }
      } } };
    });
    for (const file of ['vendor/turndown.js', 'vendor/turndown-plugin-gfm.js', 'js/research/research-import-dialog.js', 'js/research/research-publisher.js'])
      await page.addScriptTag({ content: fs.readFileSync(file, 'utf8') });
    await page.waitForFunction(() => document.querySelector('.ghrc-report-status')?.textContent.includes('reconnecting'));
    await page.evaluate(() => { window.mode = 'terminal-error'; });
    await page.waitForFunction(() => document.querySelector('.ghrc-report-status')?.textContent.includes('repository changed'));
    await page.evaluate(() => { window.mode = 'recovered'; });
    await page.waitForFunction(() => window.imports === 1, null, { timeout: 15000 });
    assert.match(await page.locator('.ghrc-report-status').innerText(), /Imported: Research \/ recovered.md/);
    assert.equal(await page.evaluate(() => imports), 1);
  } finally { await browser.close(); }
});
