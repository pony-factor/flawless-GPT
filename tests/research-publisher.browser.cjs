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
    for (const file of ['vendor/turndown.js', 'vendor/turndown-plugin-gfm.js', 'js/research-import-dialog.js', 'js/research-publisher.js']) await page.addScriptTag({ content: fs.readFileSync(file, 'utf8') });
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
    await page.addScriptTag({ content: fs.readFileSync('js/research-report-host.js', 'utf8') });
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { origin: 'https://mcp-app-abc123.web-sandbox.oaiusercontent.com', source: document.querySelector('iframe').contentWindow, data: { type: 'ghrc-research-report-state', report: true } })));
    assert.equal(await page.locator('form').evaluate(n => getComputedStyle(n).visibility), 'hidden');
    assert.equal(await page.locator('[data-composer-surface-variant]').evaluate(n => getComputedStyle(n).visibility), 'hidden');
    await page.locator('iframe').evaluate(n => n.parentElement.remove());
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-ghrc-research-fullscreen'));
    assert.equal(await page.locator('form').evaluate(n => getComputedStyle(n).visibility), 'visible');
    assert.equal(await page.locator('[data-composer-markdown]').innerText(), 'New draft');
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
    await frame.addScriptTag({ content: fs.readFileSync('js/research-import-dialog.js', 'utf8') });
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
