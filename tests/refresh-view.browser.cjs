const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const source = ['js/core/chatgpt-route-events.js', 'js/chat/refresh-view.js']
  .map(file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')).join('\n;\n');
let browser;
before(async () => { browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true }); });
after(async () => { await browser?.close(); });

async function fixture({ router = true, active = false, error = false, held = false } = {}) {
  const p = await browser.newPage();
  let loads = 0;
  await p.clock.install();
  await p.route('https://refresh.test/**', route => {
    loads++;
    return route.fulfill({ contentType: 'text/html', body: `<main style="height:1500px">
      ${error ? '<p>Could not load this ChatGPT conversation</p><button id="retry">Try again</button>' : '<p id="answer">Old view</p>'}
      <form><textarea id="prompt-textarea">Unsent draft</textarea><input type="file"></form>
      ${active ? '<button aria-label="Stop">Stop</button>' : ''}
      <aside id="ghrc-message-queue">Queued prompt</aside></main>` });
  });
  await p.goto('https://refresh.test/c/test');
  await p.evaluate(({ router, held }) => {
    window.refreshes = 0;
    window.listeners = new Set();
    document.querySelector('#retry')?.addEventListener('click', () => { window.refreshes++; });
    if (router) {
      const instance = {
        state: { revalidation: 'idle' },
        subscribe(callback) { window.listeners.add(callback); return () => window.listeners.delete(callback); },
        revalidate() {
          window.refreshes++;
          instance.state.revalidation = 'loading';
          const complete = () => {
            instance.state.revalidation = 'idle';
            document.querySelector('#answer').textContent = 'Fresh view';
            for (const callback of window.listeners) callback(instance.state);
          };
          if (!held) queueMicrotask(complete);
        },
      };
      document.querySelector('main').__reactFiber$fixture = { memoizedProps: {},
        return: { memoizedProps: { value: { router: instance } } } };
    }
  }, { router, held });
  await p.addScriptTag({ content: source });
  await p.addStyleTag({ content: fs.readFileSync(path.join(__dirname, '../css/refresh-view.css'), 'utf8') });
  return { p, loads: () => loads };
}

test('refreshes in place while preserving draft, real attachment, queue, scroll and document', async () => {
  const f = await fixture();
  await f.p.locator('input[type=file]').setInputFiles({ name: 'draft.txt', mimeType: 'text/plain', buffer: Buffer.from('unsent') });
  await f.p.evaluate(() => { window.scrollTo(0, 200); window.documentMarker = {}; });
  await f.p.getByRole('button', { name: '↻ Refresh view', exact: true }).click();
  assert.equal(await f.p.locator('#answer').textContent(), 'Fresh view');
  assert.equal(await f.p.locator('textarea').inputValue(), 'Unsent draft');
  assert.equal(await f.p.locator('input[type=file]').evaluate(e => e.files[0].name), 'draft.txt');
  assert.equal(await f.p.locator('#ghrc-message-queue').textContent(), 'Queued prompt');
  assert.equal(await f.p.evaluate(() => window.scrollY), 200);
  assert.equal(await f.p.evaluate(() => Boolean(window.documentMarker)), true);
  assert.equal(await f.p.evaluate(() => window.listeners.size), 0);
  assert.equal(f.loads(), 1);
  await f.p.getByRole('button', { name: '↻ Refresh view', exact: true }).click();
  assert.equal(await f.p.evaluate(() => window.refreshes), 1);
  assert.match(await f.p.getByRole('status').textContent(), /wait a moment/);
  await f.p.close();
});

test('active generation is not refreshed', async () => {
  const f = await fixture({ active: true });
  await f.p.getByRole('button', { name: '↻ Refresh view', exact: true }).click();
  assert.equal(await f.p.evaluate(() => window.refreshes), 0);
  assert.match(await f.p.getByRole('status').textContent(), /current response/);
  await f.p.close();
});

test('error-screen retry works without a router or reload', async () => {
  const f = await fixture({ router: false, error: true });
  await f.p.getByRole('button', { name: '↻ Refresh view', exact: true }).click();
  assert.equal(await f.p.evaluate(() => window.refreshes), 1);
  assert.match(await f.p.getByRole('status').textContent(), /Retry requested/);
  assert.equal(f.loads(), 1);
  await f.p.close();
});

test('unsupported pages report the limitation and route changes hide the control', async () => {
  const f = await fixture({ router: false });
  await f.p.getByRole('button', { name: '↻ Refresh view', exact: true }).click();
  assert.match(await f.p.getByRole('status').textContent(), /does not expose/);
  await f.p.evaluate(() => history.pushState({}, '', '/'));
  await f.p.waitForFunction(() => document.getElementById('ghrc-refresh-view').hidden);
  assert.equal(f.loads(), 1);
  await f.p.close();
});

test('a stalled refresh times out and releases its router subscription', async () => {
  const f = await fixture({ held: true });
  await f.p.getByRole('button', { name: '↻ Refresh view', exact: true }).click();
  assert.equal(await f.p.getByRole('button', { name: 'Refreshing…', exact: true }).isDisabled(), true);
  await f.p.clock.runFor(15_001);
  assert.equal(await f.p.evaluate(() => window.listeners.size), 0);
  assert.match(await f.p.getByRole('status').textContent(), /did not finish/);
  await f.p.close();
});
