const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

test('response Copy preserves all citation destinations in text and HTML and stays scoped to its turn', async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<main><article id="other"><button data-d-component="popover-trigger">Scooch</button></article><div id="response"><div data-message-author-role="assistant"><p>Consider Scooch.</p><button id="source" data-d-component="popover-trigger"><span>Scooch</span><span>+2</span></button></div><button data-testid="copy-turn-btn" aria-label="Copy">Copy</button><pre><button id="code-copy">Copy</button></pre></div></main>');
    await page.evaluate(() => {
      window.writes = [];
      class Clipboard {
        async writeText(text) { writes.push(text); }
        async write(items) {
          const data = {};
          for (const type of items[0].types) data[type] = await (await items[0].getType(type)).text();
          writes.push(data);
        }
      }
      class TestClipboardItem {
        constructor(data) { this.data = data; this.types = Object.keys(data); }
        getType(type) { return Promise.resolve(this.data[type]); }
      }
      window.Clipboard = Clipboard;
      window.ClipboardItem = TestClipboardItem;
      Object.defineProperty(navigator, 'clipboard', { value: new Clipboard(), configurable: true });
      const chip = document.querySelector('#source');
      chip.__reactFiber$test = { memoizedProps: { __dilHostElement: { props: { children: [
        { props: { onVisibleKey: 'https://scooch.example/moneymate?utm_source=chatgpt.com' } },
        { props: { onVisibleKey: 'https://scooch.example/drop' } },
        { props: { onVisibleKey: 'https://amazon.example/listing' } },
        { props: { onVisibleKey: 'https://scooch.example/drop' } },
      ] } } }, return: { stateNode: document.querySelector('main'), memoizedProps: { __dilHostElement: { props: { onVisibleKey: 'https://unrelated.example/' } } } } };
      document.querySelector('#other button').__reactFiber$test = { memoizedProps: { __dilHostElement: { props: { onVisibleKey: 'https://wrong-turn.example/' } } } };
      document.querySelector('[data-testid="copy-turn-btn"]').onclick = () => navigator.clipboard.writeText('Consider Scooch.\nScooch\n+2\n\n[View listing](https://amazon.example/listing)');
      document.querySelector('#code-copy').onclick = () => navigator.clipboard.writeText('Scooch\n+2');
    });
    for (const file of ['clipboard-utm-sanitizer', 'citation-links-main']) {
      await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, `../js/${file}.js`), 'utf8') });
    }
    await page.locator('[data-testid="copy-turn-btn"]').click();
    const copied = await page.evaluate(() => writes[0]);
    assert.match(copied, /^Consider Scooch\.\n\[Scooch\]\(https:\/\/scooch\.example\/moneymate\)/);
    assert.match(copied, /\[scooch.example\]\(https:\/\/scooch.example\/drop\)/);
    assert.match(copied, /\[amazon.example\]\(https:\/\/amazon.example\/listing\)/);
    assert.doesNotMatch(copied, /\+2|wrong-turn|unrelated|utm_source/);
    assert.match(copied, /moneymate\)  \n\[scooch.example\].*  \n\[amazon.example\]/);
    assert.match(copied, /\[View listing\]\(https:\/\/amazon.example\/listing\)/);
    await page.locator('#code-copy').click();
    assert.equal(await page.evaluate(() => writes[1]), 'Scooch\n+2');
    await page.evaluate(() => {
      document.querySelector('[data-testid="copy-turn-btn"]').onclick = () => navigator.clipboard.write([new ClipboardItem({
        'text/plain': new Blob(['Scooch\n+2'], { type: 'text/plain' }),
        'text/html': new Blob(['<p>Consider Scooch.</p><span><span>Scooch</span><span>+2</span></span>'], { type: 'text/html' }),
      })]);
    });
    await page.locator('[data-testid="copy-turn-btn"]').click();
    await page.waitForFunction(() => writes.length === 3);
    const rich = await page.evaluate(() => writes[2]);
    assert.equal((rich['text/html'].match(/<a /g) || []).length, 3);
    assert.equal((rich['text/html'].match(/<\/a><br><a /g) || []).length, 2);
    assert.match(rich['text/html'], /<p>Consider Scooch\.<\/p>/);
    assert.doesNotMatch(rich['text/html'], /\+2|utm_source|wrong-turn/);
    assert.match(rich['text/plain'], /\[Scooch\]\(https:\/\/scooch.example\/moneymate\)/);
    await page.evaluate(() => {
      document.querySelector('[data-testid="copy-turn-btn"]').onclick = () => {
        const temporary = document.createElement('div');
        temporary.innerHTML = '<p>Consider Scooch.</p><div>Scooch<br>+2</div>';
        document.body.append(temporary);
        const range = document.createRange();
        range.selectNodeContents(temporary);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        const data = new DataTransfer();
        const event = new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true });
        temporary.dispatchEvent(event);
        writes.push({ text: data.getData('text/plain'), html: data.getData('text/html'), prevented: event.defaultPrevented });
        temporary.remove();
      };
    });
    await page.locator('[data-testid="copy-turn-btn"]').click();
    const fallback = await page.evaluate(() => writes[3]);
    assert.equal(fallback.prevented, true);
    assert.match(fallback.text, /\[Scooch\]\(https:\/\/scooch.example\/moneymate\)/);
    assert.equal((fallback.html.match(/<a /g) || []).length, 3);
    await page.evaluate(() => {
      document.querySelector('[data-testid="copy-turn-btn"]').onclick = () => {
        const temporary = document.createElement('div');
        temporary.addEventListener('copy', event => {
          event.clipboardData.setData('text/plain', 'Before.\n\n\nScooch\n\n+2\n\n\nAfter.');
          event.clipboardData.setData('text/html', '<p>Before.</p><div><p>Scooch</p><p>+2</p></div><p>After.</p>');
          event.preventDefault();
          event.stopPropagation();
        });
        document.body.append(temporary);
        const data = new DataTransfer();
        temporary.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
        writes.push({ text: data.getData('text/plain'), html: data.getData('text/html') });
        temporary.remove();
      };
    });
    await page.locator('[data-testid="copy-turn-btn"]').click();
    const stopped = await page.evaluate(() => writes[4]);
    assert.match(stopped.text, /Before\.\n\n\[Scooch\]/);
    assert.doesNotMatch(stopped.text, /\n{3}|\+2/);
    assert.equal((stopped.html.match(/<a /g) || []).length, 3);
  } finally { await browser.close(); }
});
