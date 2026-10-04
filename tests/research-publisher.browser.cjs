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
        if (m.type === 'research-publisher-status') return { ok: true, repository: 'Research', branch: 'main', categories: ['Markets'] };
        return { ok: true, repository: 'Research', branch: 'main', path: 'Markets/report.md' };
      } } };
    });
    for (const file of ['vendor/turndown.js', 'vendor/turndown-plugin-gfm.js', 'js/research-import-dialog.js', 'js/research-publisher.js']) await page.addScriptTag({ content: fs.readFileSync(file, 'utf8') });
    const button = page.getByRole('button', { name: 'Add to repo', exact: true });
    await button.click();
    await page.getByRole('dialog').waitFor();
    assert.deepEqual(await page.locator('datalist option').evaluateAll(xs => xs.map(x => x.value)), ['Markets']);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await page.evaluate(() => calls.filter(x => x.type === 'publish-research-report').length), 0);
    await button.click();
    await page.getByRole('combobox', { name: 'Category' }).fill('Markets');
    await page.getByRole('button', { name: 'Import report', exact: true }).click();
    await page.waitForFunction(() => calls.some(x => x.type === 'publish-research-report'));
    const report = await page.evaluate(() => calls.find(x => x.type === 'publish-research-report'));
    assert.equal(report.category, 'Markets');
    assert.match(report.markdown, /# Report/);
    assert.match(report.markdown, /Full report/);
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
