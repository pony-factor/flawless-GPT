// Run with Playwright available; checks game input against competing page handlers.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
let browser;
before(async () => {
  browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
});
after(async () => { await browser?.close(); });

async function fixture() {
  const p = await browser.newPage();
  await p.setContent('<textarea id="prompt-textarea"></textarea><div id="github-repositories-for-chatgpt"><footer class="ghrc-dashboard-footer"><nav class="ghrc-pagination"><button>Previous</button><button>Next</button></nav></footer></div>');
  await p.addStyleTag({ content: read('css/2048.css') });
  await p.addScriptTag({ content: read('js/2048-keyboard.js') });
  await p.evaluate(() => {
    // A deterministic initial board: two adjacent twos in the first row.
    Math.random = () => 0;
    window.hostKeys = [];
    window.addEventListener('keydown', event => {
      hostKeys.push(event.key);
      event.stopImmediatePropagation();
    }, true);
  });
  await p.addScriptTag({ content: read('js/2048.js') });
  return p;
}

for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'o', 'u', 'e', '.', '>']) {
  test(`${key} moves tiles ahead of the page's capture handler`, async () => {
    const p = await fixture();
    await p.getByRole('button', { name: 'Play 2048' }).click();
    if (['ArrowUp', '.', '>'].includes(key)) await p.keyboard.press('ArrowDown');
    const before = await p.locator('.ghrc-2048-tile').allTextContents();
    await p.keyboard.press(key);
    assert.equal(await p.getByRole('button', { name: 'Undo' }).isEnabled(), true);
    assert.notDeepEqual(await p.locator('.ghrc-2048-tile').allTextContents(), before);
    assert.deepEqual(await p.evaluate(() => hostKeys), []);
    await p.getByRole('button', { name: 'Undo' }).click();
    assert.deepEqual(await p.locator('.ghrc-2048-tile').allTextContents(), before);
    await p.close();
  });
}

test('Escape closes, reopening does not duplicate moves, and page input resumes afterward', async () => {
  const p = await fixture();
  for (let index = 0; index < 2; index++) {
    await p.getByRole('button', { name: 'Play 2048' }).click();
    await p.keyboard.press('ArrowLeft');
    await p.getByRole('button', { name: 'Undo' }).click();
    assert.equal(await p.getByRole('button', { name: 'Undo' }).isEnabled(), false);
    await p.keyboard.press('Escape');
    assert.equal(await p.locator('#ghrc-2048-modal').count(), 0);
  }
  await p.locator('#prompt-textarea').focus();
  await p.keyboard.press('ArrowLeft');
  assert.deepEqual(await p.evaluate(() => hostKeys), ['ArrowLeft']);
  assert.equal(await p.locator('.ghrc-pagination').evaluate(e => e.parentElement.tagName), 'FOOTER');
  await p.close();
});

test('modified shortcuts remain available to the host while playing', async () => {
  const p = await fixture();
  await p.getByRole('button', { name: 'Play 2048' }).click();
  await p.keyboard.press('Control+ArrowLeft');
  assert.equal(await p.getByRole('button', { name: 'Undo' }).isEnabled(), false);
  assert.ok((await p.evaluate(() => hostKeys)).includes('ArrowLeft'));
  await p.close();
});

for (const returnEvent of ['focus', 'visibilitychange']) {
  test(`returning through ${returnEvent} restores game focus and preserves undo`, async () => {
    const p = await fixture();
    await p.getByRole('button', { name: 'Play 2048' }).click();
    const initial = await p.locator('.ghrc-2048-tile').allTextContents();
    await p.keyboard.press('ArrowLeft');
    const moved = await p.locator('.ghrc-2048-tile').allTextContents();
    await p.evaluate(type => {
      document.activeElement.blur();
      (type === 'focus' ? window : document).dispatchEvent(new Event(type));
    }, returnEvent);
    assert.equal(await p.getByRole('button', { name: 'Close 2048' }).evaluate(e => e === document.activeElement), true);
    assert.deepEqual(await p.locator('.ghrc-2048-tile').allTextContents(), moved);
    await p.keyboard.press('ArrowDown');
    assert.notDeepEqual(await p.locator('.ghrc-2048-tile').allTextContents(), moved);
    await p.getByRole('button', { name: 'Undo' }).click();
    assert.deepEqual(await p.locator('.ghrc-2048-tile').allTextContents(), moved);
    await p.getByRole('button', { name: 'Undo' }).click();
    assert.deepEqual(await p.locator('.ghrc-2048-tile').allTextContents(), initial);
    assert.deepEqual(await p.evaluate(() => hostKeys), []);
    await p.close();
  });
}

test('host inputs and frames cannot take game focus, and focus is released on close', async () => {
  const p = await fixture();
  await p.getByRole('button', { name: 'Play 2048' }).click();
  await p.locator('#prompt-textarea').focus();
  assert.equal(await p.getByRole('button', { name: 'Close 2048' }).evaluate(e => e === document.activeElement), true);
  await p.evaluate(() => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    frame.contentWindow.focus();
  });
  await p.waitForFunction(() => document.activeElement?.matches('.ghrc-2048-close'));
  assert.equal(await p.getByRole('button', { name: 'Close 2048' }).evaluate(e => e === document.activeElement), true);
  await p.keyboard.press('ArrowLeft');
  assert.equal(await p.getByRole('button', { name: 'Undo' }).isEnabled(), true);
  await p.keyboard.press('Escape');
  await p.locator('#prompt-textarea').focus();
  await p.evaluate(() => window.dispatchEvent(new Event('focus')));
  assert.equal(await p.locator('#prompt-textarea').evaluate(e => e === document.activeElement), true);
  await p.close();
});

test('the keyboard bridge is installed at document_start', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const script = manifest.content_scripts.find(c => c.js?.includes('js/2048-keyboard.js'));
  assert.equal(script.run_at, 'document_start');
});
