const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');

test('writing Copy converts HTML documents to Markdown and leaves other copies alone', async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<main><div data-oai-writing-block-surface><header><button aria-label="Copy">Copy</button></header></div><pre><button>Copy</button></pre></main>');
    await page.evaluate(() => {
      window.writes = [];
      window.payload = '<html><head></head><body><h2>Cycle</h2><ul><li><span><input type="checkbox" checked></span><div><p>Done</p></div></li><li><span><input type="checkbox"></span><div><p>Pending</p></div></li></ul><table><thead><tr><th>Check</th><th>Result</th></tr></thead><tbody><tr><td>Tests</td><td>Passed</td></tr></tbody></table><p><a href="https://github.com/example/repo/pull/1">PR</a></p><p><code>schedule.bell</code></p></body></html>';
      class TestClipboard {
        async writeText(text) { writes.push(text); }
        async write(items) { writes.push(await (await items[0].getType('text/plain')).text()); }
      }
      window.ClipboardItem = class {
        constructor(data) { this.data = data; this.types = Object.keys(data); }
        getType(type) { return Promise.resolve(this.data[type]); }
      };
      window.Clipboard = TestClipboard;
      Object.defineProperty(navigator, 'clipboard', { value: new TestClipboard(), configurable: true });
      document.querySelectorAll('button').forEach(button => button.onclick = () => navigator.clipboard.writeText(payload));
    });
    for (const file of ['vendor/turndown.js', 'vendor/turndown-plugin-gfm.js', 'js/links/clipboard-utm-sanitizer.js']) {
      await page.addScriptTag({ path: path.join(__dirname, '..', file) });
    }
    await page.locator('header button').click();
    const text = await page.evaluate(() => writes[0]);
    assert.match(text, /^## Cycle/);
    assert.match(text, /-\s+\[x\] Done/);
    assert.match(text, /-\s+\[ \] Pending/);
    assert.match(text, /\| Check \| Result \|/);
    assert.match(text, /`schedule.bell`/);
    assert.equal(text.split('https://github.com/example/repo/pull/1').length, 2);
    assert.doesNotMatch(text, /<html|<span|<input/);
    await page.locator('pre button').click();
    assert.match(await page.evaluate(() => writes[1]), /^<html>/);
    await page.evaluate(() => {
      document.querySelector('header button').onclick = () => navigator.clipboard.write([new ClipboardItem({
        'text/plain': new Blob([payload], { type: 'text/plain' }),
        'text/html': new Blob([payload], { type: 'text/html' }),
      })]);
    });
    await page.locator('header button').click();
    await page.waitForFunction(() => writes.length === 3);
    assert.equal(await page.evaluate(() => writes[2]), text);
  } finally { await browser.close(); }
});
