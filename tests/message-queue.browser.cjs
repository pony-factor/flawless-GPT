// Run with Playwright available: node --test tests/message-queue.browser.cjs
// Uses an isolated browser and a local ChatGPT fixture; never sends real messages.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const source = fs.readFileSync(path.join(__dirname, '../js/message-queue.js'), 'utf8');
const clipboardSource = fs.readFileSync(path.join(__dirname, '../js/clipboard-send.js'), 'utf8');
const queueCss = fs.readFileSync(path.join(__dirname, '../css/message-queue.css'), 'utf8');
const hatCss = fs.readFileSync(path.join(__dirname, '../css/top-hat-send-button.css'), 'utf8');
let browser;
before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.BROWSER_EXECUTABLE || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    headless: true,
  });
});
after(async () => { await browser?.close(); });

async function fixture({ active = false, voice = false, editable = true, stored = {}, route = '/c/test', liveMarkup = false, clipboard = false, searches = false, delayQueueStorage = false, queueButton = true } = {}) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://queue.test/**', r => r.fulfill({ contentType: 'text/html', body: `
    <style>body {font-family: sans-serif; margin: 30px} form {display:flex;gap:8px} [contenteditable],textarea {width:400px;min-height:50px} button {min-width:32px;min-height:32px}</style>
    <main id="turns"></main><div><form>
    ${editable ? '<div data-composer-markdown contenteditable="true" role="textbox"><p><br class="ProseMirror-trailingBreak"></p></div>' : '<textarea id="prompt-textarea"></textarea>'}
    <button id="composer-submit-button" type="button"><svg viewBox="0 0 24 24"><rect width="10" height="10"/></svg></button>
    </form></div>` }));
  await page.goto(`https://queue.test${route}`);
  await page.evaluate(({ active, voice, stored, liveMarkup, clipboard, delayQueueStorage, queueButton }) => {
    window.liveMarkup = liveMarkup;
    if (liveMarkup) document.documentElement.setAttribute('data-theme', 'dark');
    window.sent = [];
    window.rejectSend = false;
    window.stops = 0;
    window.deferStop = false;
    window.storage = { ...structuredClone(stored), showClipboardSendButton: clipboard, showMessageQueueButton: queueButton };
    window.chrome = { runtime: { id: "fixture" }, storage: { local: {
      async get(defaults) {
        if (delayQueueStorage && !window.queueStorageReleased && "queuedChatMessages" in defaults) await new Promise(resolve => {
          window.resolveQueueStorage = () => { window.queueStorageReleased = true; resolve(); };
        });
        return { ...defaults, ...structuredClone(window.storage) };
      },
      async set(values) {
        if (window.delayQueueSave && "queuedChatMessages" in values) await new Promise(resolve => { window.resolveQueueSave = resolve; });
        if (window.rejectQueueSave && "queuedChatMessages" in values) throw new Error('Queue storage unavailable');
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          if (JSON.stringify(window.storage[key]) !== JSON.stringify(value))
            changes[key] = { oldValue: window.storage[key], newValue: structuredClone(value) };
          window.storage[key] = structuredClone(value);
        }
        for (const listener of window.storageListeners) listener(changes, 'local');
      },
    }, onChanged: { addListener(fn) { window.storageListeners.push(fn); } } } };
    window.storageListeners = [];
    window.editor = document.querySelector('[contenteditable],textarea');
    window.button = document.getElementById('composer-submit-button');
    window.read = () => {
      if (editor.tagName === 'TEXTAREA') return editor.value;
      const paragraphs = [...editor.children];
      return paragraphs.length && paragraphs.every(e => e.tagName === 'P')
        ? paragraphs.map(e => e.textContent).join('\n') : editor.innerText;
    };
    window.clear = () => {
      if (editor.tagName === 'TEXTAREA') editor.value = '';
      else editor.innerHTML = '<p><br class="ProseMirror-trailingBreak"></p>';
    };
    window.addTurn = (role, complete = false) => {
      if (window.liveMarkup) {
        let group;
        if (role === 'user') {
          group = document.createElement('div');
          group.className = 'group flex flex-col';
          group.dataset.fixtureTurn = document.querySelectorAll('[data-fixture-turn]').length;
          document.getElementById('turns').append(group);
        } else group = document.querySelector('[data-fixture-turn]:last-child');
        const content = document.createElement('div');
        content.setAttribute('data-content-search-unit-key', `fallback-turn-${group.dataset.fixtureTurn}:${role === 'user' ? 0 : 1}:${role}`);
        if (role === 'user') content.innerHTML = '<button aria-label="Copy message">Copy user</button>';
        group.append(content);
        if (complete) group.insertAdjacentHTML('beforeend', '<div class="turn-action-controls"><button aria-label="Copy">Copy assistant</button></div>');
        return;
      }
      const article = document.createElement('article');
      article.dataset.testid = `conversation-turn-${document.querySelectorAll('article').length}`;
      article.innerHTML = `<div data-message-author-role="${role}"></div>`;
      if (complete) article.innerHTML += '<button data-testid="copy-turn-action-button">Copy</button>';
      document.getElementById('turns').append(article);
    };
    window.active = active;
    window.voice = voice;
    window.update = () => {
      button.dataset.testid = window.active ? 'stop-button' : (window.voice && !read().trim() ? 'voice-button' : 'send-button');
      button.setAttribute('aria-label', window.active ? 'Stop generating' : (window.voice && !read().trim() ? 'Start Voice' : 'Send prompt'));
      button.disabled = !window.active && !window.voice && !read().trim();
      if (window.liveMarkup) {
        button.removeAttribute('data-testid');
        button.removeAttribute('id');
        button.setAttribute('aria-label', window.active ? 'Stop' : (window.voice && !read().trim() ? 'Start Voice' : 'Send'));
      }
    };
    window.finish = () => {
      const assistants = document.querySelectorAll('[data-message-author-role="assistant"], [data-content-search-unit-key$=":assistant"]');
      assistants[assistants.length - 1]?.parentElement.insertAdjacentHTML('beforeend', window.liveMarkup
        ? '<div class="turn-action-controls"><button aria-label="Copy">Copy assistant</button></div>'
        : '<button data-testid="copy-turn-action-button">Copy</button>');
      window.active = false;
      update();
    };
    editor.addEventListener('input', update);
    editor.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.defaultPrevented) {
        event.preventDefault();
        if (!button.disabled && !window.active) button.click();
      }
    });
    button.addEventListener('click', () => {
      if (window.active) { window.stops++; if (!window.deferStop) window.finish(); return; }
      if (window.rejectSend || !read().trim()) return;
      sent.push(read().trim());
      addTurn('user'); addTurn('assistant');
      clear(); window.active = true; update();
    });
    if (active) { addTurn('user'); addTurn('assistant'); }
    update();
  }, { active, voice, stored, liveMarkup, clipboard, delayQueueStorage, queueButton });
  await page.addStyleTag({ content: queueCss + hatCss });
  if (searches) await page.evaluate(() => {
    const search = document.createElement('button');
    search.type = 'submit';
    search.className = 'ghrc-wooten-link-submit';
    search.setAttribute('aria-label', 'Search WootenLink');
    document.querySelector('form').prepend(search);
  });
  await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, "../js/extension-context.js"), "utf8") });
  if (clipboard) await page.addScriptTag({ content: clipboardSource });
  await page.addScriptTag({ content: source });
  if (!delayQueueStorage && queueButton) await page.locator('#ghrc-message-queue-button').waitFor();
  else if (!delayQueueStorage) await page.waitForFunction(() => window.storageListeners.length > 0);
  page.errors = errors;
  return page;
}
async function enqueue(page, text, enter = false) {
  const count = await page.locator('.ghrc-message-queue-editor').count();
  const editor = page.locator('[data-composer-markdown],#prompt-textarea');
  await editor.fill(text);
  if (enter) await editor.press('Enter');
  else await page.locator('#ghrc-message-queue-button').click();
  await page.waitForFunction(n => document.querySelectorAll('.ghrc-message-queue-editor').length === n + 1, count);
  await page.waitForFunction(() => !read().trim());
}
async function sentCount(page, count) {
  await page.waitForFunction(n => sent.length === n, count, { timeout: 10000 });
}

test('standalone queue button is opt-in and follows setting changes', async () => {
  const p = await fixture({ queueButton: false });
  assert.equal(await p.locator('#ghrc-message-queue-button').count(), 0);
  await p.evaluate(() => chrome.storage.local.set({ showMessageQueueButton: true }));
  await p.locator('#ghrc-message-queue-button').waitFor();
  await p.evaluate(() => chrome.storage.local.set({ showMessageQueueButton: false }));
  await p.waitForFunction(() => !document.getElementById('ghrc-message-queue-button'));
  assert.deepEqual(p.errors, []);
  await p.close();
});

for (const menuMarkup of [
  '<div data-mention-list-scroll-area><button type="button" data-list-navigation-item="true">Deep research</button></div>',
  '<div id="plugin-options" role="listbox"><div id="plugin-option" role="option">Deep research</div></div>',
]) {
  test(`busy Enter selects a partial plugin mention instead of queueing (${menuMarkup.includes('scroll-area') ? 'native portal' : 'ARIA autocomplete'})`, async () => {
    const p = await fixture({ active: true });
    await p.locator('[data-composer-markdown]').fill('@deep-re');
    await p.evaluate(markup => {
      const popup = document.createElement('section');
      popup.id = 'autocomplete-fixture';
      popup.innerHTML = markup;
      document.body.append(popup);
      if (popup.querySelector('[role="listbox"]')) {
        editor.setAttribute('aria-expanded', 'true');
        editor.setAttribute('aria-controls', 'plugin-options');
        editor.setAttribute('aria-activedescendant', 'plugin-option');
      }
      window.pluginSelections = 0;
      // Model the native document capture handler, before composer send handlers.
      document.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || !popup.isConnected) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        window.pluginSelections++;
        editor.textContent = 'Deep research';
        popup.remove();
        editor.removeAttribute('aria-expanded');
        editor.removeAttribute('aria-controls');
        editor.removeAttribute('aria-activedescendant');
      }, true);
    }, menuMarkup);
    await p.locator('[data-composer-markdown]').press('Enter');
    assert.equal(await p.evaluate(() => window.pluginSelections), 1);
    assert.equal(await p.locator('[data-composer-markdown]').innerText(), 'Deep research');
    assert.equal(await p.locator('.ghrc-message-queue-editor').count(), 0);
    assert.equal(await p.evaluate(() => window.stops), 0);
    assert.equal(await p.evaluate(() => window.sent.length), 0);
    // Once autocomplete closes, the next Enter follows the usual queue behavior.
    await enqueue(p, 'Research this topic', true);
    assert.equal(await p.locator('.ghrc-message-queue-editor').count(), 1);
    assert.deepEqual(p.errors, []);
    await p.close();
  });
}

test('hidden or inert autocomplete does not swallow a normal busy Enter', async () => {
  const p = await fixture({ active: true });
  await p.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<div data-mention-list-scroll-area style="display:none"><button>Deep research</button></div><div data-mention-list-scroll-area inert><button>Deep research</button></div>');
  });
  await enqueue(p, 'Queue normally', true);
  assert.equal(await p.locator('.ghrc-message-queue-editor').count(), 1);
  assert.deepEqual(p.errors, []);
  await p.close();
});

for (const route of ['/', '/?temporary-chat=true', '/c/test']) {
  test(`busy Enter queues before a host document capture handler on ${route}`, async () => {
    const p = await fixture({ active: true, route });
    await p.evaluate(() => {
      document.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.defaultPrevented) button.click();
      }, true);
    });
    await enqueue(p, 'Keep generating; queue this', true);
    assert.equal(await p.evaluate(() => stops), 0);
    assert.deepEqual(await p.evaluate(() => sent), []);
    assert.equal(await p.locator('.ghrc-message-queue-editor').inputValue(), 'Keep generating; queue this');
    await p.close();
  });
}

test('busy Enter waits for initial storage and suppresses repeated Enter', async () => {
  const p = await fixture({ active: true, route: '/', delayQueueStorage: true });
  const editor = p.locator('[data-composer-markdown]');
  await editor.fill('Wait for storage');
  await editor.press('Enter');
  await editor.press('Enter');
  assert.equal(await editor.innerText(), 'Wait for storage');
  assert.equal(await p.evaluate(() => stops), 0);
  await p.evaluate(() => resolveQueueStorage());
  await p.waitForFunction(() => document.querySelectorAll('.ghrc-message-queue-editor').length === 1);
  assert.equal(await p.locator('.ghrc-message-queue-editor').inputValue(), 'Wait for storage');
  await p.waitForFunction(() => !read().trim());
  await p.close();
});

test('queue save preserves a draft edited while storage is pending', async () => {
  const p = await fixture({ active: true });
  await p.evaluate(() => { window.delayQueueSave = true; });
  const editor = p.locator('[data-composer-markdown]');
  await editor.fill('Save this');
  await editor.press('Enter');
  await p.waitForFunction(() => typeof resolveQueueSave === 'function');
  assert.equal(await editor.innerText(), 'Save this');
  await editor.fill('My next draft');
  await p.evaluate(() => { window.delayQueueSave = false; resolveQueueSave(); });
  await p.waitForTimeout(100);
  assert.equal(await editor.innerText(), 'My next draft');
  assert.equal(await p.locator('.ghrc-message-queue-editor').inputValue(), 'Save this');
  await p.close();
});

test('failed queue storage keeps the draft and allows a single retry', async () => {
  const p = await fixture({ active: true });
  await p.evaluate(() => { window.rejectQueueSave = true; });
  const editor = p.locator('[data-composer-markdown]');
  await editor.fill('Retry this');
  await editor.press('Enter');
  await p.waitForTimeout(100);
  assert.equal(await editor.innerText(), 'Retry this');
  assert.equal(await p.locator('.ghrc-message-queue-editor').count(), 0);
  await p.evaluate(() => { window.rejectQueueSave = false; });
  await editor.press('Enter');
  await p.waitForFunction(() => document.querySelectorAll('.ghrc-message-queue-editor').length === 1);
  assert.equal(await p.locator('.ghrc-message-queue-editor').inputValue(), 'Retry this');
  assert.equal(await p.evaluate(() => stops), 0);
  await p.close();
});

test('distinct Enter requests save in FIFO order while the first save is pending', async () => {
  const p = await fixture({ active: true });
  await p.evaluate(() => { window.delayQueueSave = true; });
  const editor = p.locator('[data-composer-markdown]');
  await editor.fill('First pending message');
  await editor.press('Enter');
  await p.waitForFunction(() => typeof resolveQueueSave === 'function');
  await editor.fill('Second pending message');
  await editor.press('Enter');
  await p.evaluate(() => { window.delayQueueSave = false; resolveQueueSave(); });
  await p.waitForFunction(() => document.querySelectorAll('.ghrc-message-queue-editor').length === 2 && !read().trim());
  assert.deepEqual(await p.locator('.ghrc-message-queue-editor').evaluateAll(items => items.map(item => item.value)), ['First pending message', 'Second pending message']);
  assert.equal(await p.evaluate(() => stops), 0);
  assert.deepEqual(await p.evaluate(() => sent), []);
  await p.close();
});

test('Enter during delayed native submission queues without sending another message', async () => {
  const p = await fixture({ route: '/' });
  await p.evaluate(() => {
    window.delayedNativeSends = 0;
    document.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.defaultPrevented) {
        event.preventDefault(); event.stopImmediatePropagation();
        window.delayedNativeSends++;
        clear(); update();
      }
    }, true);
  });
  const editor = p.locator('[data-composer-markdown]');
  await editor.fill('First native message');
  await editor.press('Enter');
  await enqueue(p, 'Second message', true);
  await p.waitForTimeout(2000);
  assert.equal(await p.evaluate(() => delayedNativeSends), 1);
  assert.deepEqual(await p.evaluate(() => sent), []);
  assert.equal(await p.locator('.ghrc-message-queue-editor').inputValue(), 'Second message');
  await p.close();
});

test('empty disabled send button does not deadlock; FIFO waits for complete responses', async () => {
  const p = await fixture({ active: true });
  await enqueue(p, 'First\nsecond line', true);
  await enqueue(p, 'Second', true);
  await p.waitForTimeout(1800);
  assert.deepEqual(await p.evaluate(() => sent), []);
  // Thinking-to-answer gap: stop disappears before completion actions arrive.
  await p.evaluate(() => { window.active = false; update(); });
  await p.waitForTimeout(1800);
  assert.deepEqual(await p.evaluate(() => sent), []);
  await p.evaluate(() => finish());
  await sentCount(p, 1);
  assert.deepEqual(await p.evaluate(() => sent), ['First\nsecond line']);
  await p.waitForTimeout(1800);
  assert.equal(await p.locator('.ghrc-message-queue-editor').count(), 1);
  await p.evaluate(() => finish());
  await sentCount(p, 2);
  await p.waitForFunction(() => !document.getElementById('ghrc-message-queue'));
  assert.deepEqual(p.errors, []);
  await p.close();
});

test('Stop queue preserves messages across reload; Resume sends them', async () => {
  const p = await fixture({ active: true });
  await enqueue(p, 'Saved');
  await p.getByRole('button', { name: 'Stop', exact: true }).click();
  await p.evaluate(() => finish());
  await p.waitForTimeout(1800);
  assert.deepEqual(await p.evaluate(() => sent), []);
  const stored = await p.evaluate(() => window.storage);
  const restored = await fixture({ stored });
  await restored.getByRole('button', { name: 'Resume queue', exact: true }).waitFor();
  await restored.waitForTimeout(1800);
  assert.deepEqual(await restored.evaluate(() => sent), []);
  await restored.getByRole('button', { name: 'Resume queue', exact: true }).click();
  await sentCount(restored, 1);
  assert.deepEqual(await restored.evaluate(() => sent), ['Saved']);
  await p.close(); await restored.close();
});

test('edit, reorder, and remove preserve FIFO while Send bypasses the queue', async () => {
  const p = await fixture({ active: true });
  await enqueue(p, 'First'); await enqueue(p, 'Second'); await enqueue(p, 'Remove');
  await p.locator('.ghrc-message-queue-editor').nth(1).fill('Edited');
  await p.getByRole('button', { name: 'Move queued message earlier', exact: true }).nth(1).click();
  await p.getByRole('button', { name: 'Remove queued message', exact: true }).nth(2).click();
  await p.evaluate(() => finish());
  await p.locator('[data-composer-markdown]').fill('Third');
  await p.locator('#composer-submit-button').click();
  await sentCount(p, 1);
  assert.deepEqual(await p.evaluate(() => sent), ['Third']);
  assert.deepEqual(await p.locator('.ghrc-message-queue-editor').evaluateAll(es => es.map(e => e.value)), ['Edited', 'First']);
  await p.evaluate(() => finish());
  await sentCount(p, 2);
  assert.deepEqual(await p.evaluate(() => sent), ['Third', 'Edited']);
  await p.close();
});

test('queue drains while preserving a partial draft and Shift+Enter newline', async () => {
  const p = await fixture({ active: true });
  await enqueue(p, 'Queued');
  await enqueue(p, 'Next');
  const editor = p.locator('[data-composer-markdown]');
  await editor.fill('Draft'); await editor.press('Shift+Enter');
  const draft = await p.evaluate(() => read());
  await p.evaluate(() => finish());
  await sentCount(p, 1);
  await p.waitForFunction(d => read().replace(/\n+$/, '') === d.replace(/\n+$/, ''), draft);
  assert.deepEqual(await p.evaluate(() => sent), ['Queued']);
  await p.evaluate(() => finish());
  await sentCount(p, 2);
  await p.waitForFunction(d => read().replace(/\n+$/, '') === d.replace(/\n+$/, ''), draft);
  assert.deepEqual(await p.evaluate(() => sent), ['Queued', 'Next']);
  await p.close();
});

test('voice-only empty composer mounts queue; hat tilts without hiding native stop', async () => {
  const p = await fixture({ voice: true });
  await enqueue(p, 'Voice layout');
  await sentCount(p, 1);
  assert.equal(await p.locator('[data-testid="stop-button"] svg').evaluate(el => getComputedStyle(el).opacity), '1');
  assert.equal(await p.locator('[data-testid="stop-button"]').evaluate(el => getComputedStyle(el, '::before').content), 'none');
  await p.evaluate(() => { finish(); editor.textContent = 'Draft'; update(); });
  const transform = await p.locator('#composer-submit-button').evaluate(el => getComputedStyle(el, '::before').transform);
  assert.match(transform, /0\.984808/); // cos(10 degrees)
  assert.deepEqual(p.errors, []);
  await p.waitForFunction(() => !document.getElementById('ghrc-message-queue'));
  await p.screenshot({ path: '/tmp/flawless-queue-hat.png' });
  await p.close();
});

test('failed submission pauses and keeps the message for retry', async () => {
  const p = await fixture({ editable: false });
  await p.evaluate(() => { window.rejectSend = true; });
  await enqueue(p, 'Retry me');
  await p.getByRole('button', { name: 'Resume queue', exact: true }).waitFor({ timeout: 10000 });
  assert.equal(await p.locator('.ghrc-message-queue-editor').inputValue(), 'Retry me');
  assert.equal(await p.evaluate(() => read()), '');
  await p.evaluate(() => { window.rejectSend = false; });
  await p.getByRole('button', { name: 'Resume queue', exact: true }).click();
  await sentCount(p, 1);
  assert.deepEqual(await p.evaluate(() => sent), ['Retry me']);
  await p.close();
});

test('conversation navigation isolates queues and migrates a new-chat queue', async () => {
  const p = await fixture({ active: true, route: '/' });
  await enqueue(p, 'New chat queue');
  await p.getByRole('button', { name: 'Stop', exact: true }).click();
  await p.evaluate(() => { history.pushState({}, '', '/g/g-example/c/created'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await p.waitForFunction(() => storage.queuedChatMessages?.['conversation:created']?.length === 1);
  assert.equal(await p.evaluate(() => storage.queuedChatMessagesPaused['conversation:created']), true);
  await p.evaluate(() => { history.pushState({}, '', '/c/other'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await p.waitForFunction(() => !document.getElementById('ghrc-message-queue'));
  await p.evaluate(() => { history.pushState({}, '', '/g/g-example/c/created'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await p.getByRole('button', { name: 'Resume queue', exact: true }).waitFor();
  assert.equal(await p.locator('.ghrc-message-queue-editor').inputValue(), 'New chat queue');
  await p.close();
});

test('queue UI observer settles instead of rewriting its own DOM every frame', async () => {
  const p = await fixture({ active: true });
  await enqueue(p, 'Waiting');
  await p.waitForTimeout(300);
  await p.evaluate(() => {
    window.queueMutations = 0;
    new MutationObserver(records => { window.queueMutations += records.length; })
      .observe(document.body, { subtree: true, childList: true });
  });
  await p.waitForTimeout(1000);
  assert.equal(await p.evaluate(() => window.queueMutations), 0);
  await p.close();
});

test('first queued send can create a conversation without resending its migrated item', async () => {
  const p = await fixture({ route: '/' });
  await p.evaluate(() => {
    button.addEventListener('click', () => {
      if (sent.length === 1 && location.pathname === '/') {
        history.pushState({}, '', '/c/created-by-send');
        window.dispatchEvent(new PopStateEvent('popstate'));
      }
    });
  });
  await enqueue(p, 'Create conversation');
  await sentCount(p, 1);
  await p.waitForFunction(() => !document.getElementById('ghrc-message-queue'));
  await p.evaluate(() => finish());
  await p.waitForTimeout(1800);
  assert.deepEqual(await p.evaluate(() => sent), ['Create conversation']);
  assert.equal(await p.evaluate(() => storage.queuedChatMessages['conversation:created-by-send']), undefined);
  await p.close();
});


test('stopping during the completion settle period prevents the next send on a narrow screen', async () => {
  const p = await fixture({ active: true });
  await p.setViewportSize({ width: 390, height: 844 });
  await enqueue(p, 'Stay queued');
  await p.evaluate(() => finish());
  await p.waitForTimeout(500);
  const stop = p.getByRole('button', { name: 'Stop', exact: true });
  const box = await stop.boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 390);
  await stop.click();
  await p.waitForTimeout(1800);
  assert.deepEqual(await p.evaluate(() => sent), []);
  assert.equal(await p.locator('.ghrc-message-queue-editor').inputValue(), 'Stay queued');
  await p.screenshot({ path: '/tmp/flawless-queue-stopped-mobile.png' });
  await p.close();
});


for (const route of ['/', '/c/test']) {
  test(`idle Enter sends immediately without a queue panel on ${route}`, async () => {
    const p = await fixture({ route });
    await p.locator('[data-composer-markdown]').fill('Send directly');
    await p.locator('[data-composer-markdown]').press('Enter');
    assert.deepEqual(await p.evaluate(() => sent), ['Send directly']);
    assert.equal(await p.locator('#ghrc-message-queue').count(), 0);
    await p.close();
  });
}


for (const route of ['/', '/?temporary-chat=true']) {
  test(`overview Enter sends the first message before queue storage loads on ${route}`, async () => {
    const p = await fixture({ route, delayQueueStorage: true });
    await p.locator('[data-composer-markdown]').fill('First message');
    await p.locator('[data-composer-markdown]').press('Enter');
    assert.deepEqual(await p.evaluate(() => sent), ['First message']);
    assert.equal(await p.locator('#ghrc-message-queue').count(), 0);
    await p.evaluate(() => resolveQueueStorage());
    await p.waitForTimeout(200);
    assert.deepEqual(await p.evaluate(() => sent), ['First message']);
    assert.equal(await p.locator('#ghrc-message-queue').count(), 0);
    assert.deepEqual(p.errors, []);
    await p.close();
  });
}

test('after the overview creates a chat, Enter queues behind its active response', async () => {
  const p = await fixture({ route: '/' });
  await p.evaluate(() => {
    button.addEventListener('click', () => {
      if (sent.length === 1 && location.pathname === '/') {
        history.pushState({}, '', '/c/native-first-send');
        window.dispatchEvent(new PopStateEvent('popstate'));
      }
    });
  });
  await p.locator('[data-composer-markdown]').fill('First message');
  await p.locator('[data-composer-markdown]').press('Enter');
  assert.deepEqual(await p.evaluate(() => sent), ['First message']);
  await p.waitForTimeout(100);
  await enqueue(p, 'Second message', true);
  assert.deepEqual(await p.evaluate(() => sent), ['First message']);
  assert.equal(await p.locator('.ghrc-message-queue-editor').inputValue(), 'Second message');
  assert.equal(await p.evaluate(() => stops), 0);
  await p.close();
});

test('clicking the hat interrupts and sends immediately ahead of queued messages', async () => {
  const p = await fixture({ active: true });
  await enqueue(p, 'Queued earlier', true);
  await p.locator('[data-composer-markdown]').fill('Send now');
  const hat = p.getByRole('button', { name: 'Interrupt and send', exact: true });
  await hat.waitFor();
  const transform = await hat.evaluate(el => getComputedStyle(el, '::before').transform);
  assert.match(transform, /0\.984808/);
  await hat.click();
  await sentCount(p, 1);
  assert.equal(await p.evaluate(() => stops), 1);
  assert.deepEqual(await p.evaluate(() => sent), ['Send now']);
  assert.equal(await p.locator('.ghrc-message-queue-editor').inputValue(), 'Queued earlier');
  await p.evaluate(() => finish());
  await sentCount(p, 2);
  assert.deepEqual(await p.evaluate(() => sent), ['Send now', 'Queued earlier']);
  assert.deepEqual(p.errors, []);
  await p.close();
});

test('native Stop only stops, and the idle hat sends a draft immediately', async () => {
  const p = await fixture({ active: true });
  await p.locator('[data-composer-markdown]').fill('Draft');
  await p.getByRole('button', { name: 'Interrupt and send', exact: true }).waitFor();
  await p.locator('[data-testid="stop-button"]').click();
  assert.deepEqual(await p.evaluate(() => sent), []);
  assert.equal(await p.evaluate(() => read()), 'Draft');
  await p.locator('#composer-submit-button').click();
  await sentCount(p, 1);
  assert.deepEqual(await p.evaluate(() => sent), ['Draft']);
  assert.equal(await p.locator('.ghrc-message-queue-editor').count(), 0);
  await p.close();
});

test('an empty disabled hat remains visible with voice hidden and yields to native Send', async () => {
  const p = await fixture({ voice: true, liveMarkup: true, queueButton: false });
  await p.addStyleTag({ content: fs.readFileSync(path.join(__dirname, '../css/hide-dictation.css'), 'utf8') });
  await p.evaluate(() => document.documentElement.setAttribute('data-ghrc-hide-dictation', ''));
  const hat = p.getByRole('button', { name: 'Send message', exact: true });
  await hat.waitFor();
  assert.equal(await hat.isDisabled(), true);
  assert.equal(await p.getByRole('button', { name: 'Start Voice', includeHidden: true }).isVisible(), false);
  assert.deepEqual(await p.evaluate(() => sent), []);
  await p.locator('[data-composer-markdown]').fill('Hello');
  await p.waitForFunction(() => !document.getElementById('ghrc-message-interrupt-button'));
  await p.getByRole('button', { name: 'Send', exact: true }).click();
  await sentCount(p, 1);
  assert.deepEqual(await p.evaluate(() => sent), ['Hello']);
  await p.evaluate(() => finish());
  await hat.waitFor();
  await p.evaluate(() => document.documentElement.removeAttribute('data-ghrc-hide-dictation'));
  await p.waitForFunction(() => !document.getElementById('ghrc-message-interrupt-button'));
  assert.equal(await p.getByRole('button', { name: 'Start Voice', exact: true }).isVisible(), true);
  assert.deepEqual(p.errors, []);
  await p.close();
});

test('interrupt waits for Stop to finish and cancels if the draft changes', async () => {
  const p = await fixture({ active: true });
  await p.evaluate(() => { window.deferStop = true; });
  await p.locator('[data-composer-markdown]').fill('Original');
  await p.getByRole('button', { name: 'Interrupt and send', exact: true }).click();
  assert.equal(await p.evaluate(() => stops), 1);
  assert.deepEqual(await p.evaluate(() => sent), []);
  await p.locator('[data-composer-markdown]').fill('Updated draft');
  await p.waitForTimeout(200);
  await p.evaluate(() => finish());
  await p.waitForTimeout(200);
  assert.deepEqual(await p.evaluate(() => sent), []);
  assert.equal(await p.evaluate(() => read()), 'Updated draft');
  await p.close();
});

test('interrupt cancels on navigation without submitting in another chat', async () => {
  const p = await fixture({ active: true });
  await p.evaluate(() => { window.deferStop = true; });
  await p.locator('[data-composer-markdown]').fill('Original chat');
  await p.getByRole('button', { name: 'Interrupt and send', exact: true }).click();
  await p.evaluate(() => {
    history.pushState({}, '', '/c/different');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await p.waitForTimeout(200);
  await p.evaluate(() => finish());
  await p.waitForTimeout(200);
  assert.deepEqual(await p.evaluate(() => sent), []);
  await p.close();
});


test('live grouped markup, label-only Stop, clipboard integration, and dark theme work together', async () => {
  const p = await fixture({ active: true, liveMarkup: true, clipboard: true });
  await enqueue(p, 'Live queue', true);
  assert.equal(await p.locator('#ghrc-message-queue').evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(33, 33, 33)');
  await p.evaluate(() => { window.active = false; update(); });
  // User Copy message exists; the assistant toolbar has not arrived yet.
  await p.waitForTimeout(1800);
  assert.deepEqual(await p.evaluate(() => sent), []);
  await p.evaluate(() => finish());
  await sentCount(p, 1);
  assert.deepEqual(await p.evaluate(() => sent), ['Live queue']);
  await p.locator('[data-composer-markdown]').fill('Interrupt draft');
  await p.getByRole('button', { name: 'Interrupt and send', exact: true }).click();
  await sentCount(p, 2);
  assert.deepEqual(await p.evaluate(() => sent), ['Live queue', 'Interrupt draft']);
  await p.evaluate(() => finish());
  await p.locator('[data-composer-markdown]').fill('Keep draft');
  await p.locator('#ghrc-clipboard-send-button').waitFor();
  await p.waitForTimeout(300);
  await p.evaluate(() => {
    window.buttonMoves = 0;
    new MutationObserver(rs => { window.buttonMoves += rs.length; }).observe(document.querySelector('form'), { childList: true, subtree: true });
  });
  await p.waitForTimeout(1000);
  assert.equal(await p.evaluate(() => buttonMoves), 0);
  assert.deepEqual(p.errors, []);
  await p.close();
});


test('homepage queue anchors to Start Voice instead of embedded dashboard search buttons', async () => {
  const p = await fixture({ voice: true, searches: true });
  assert.equal(await p.locator('#ghrc-message-queue-button').evaluate(e => e.nextElementSibling.getAttribute('aria-label')), 'Start Voice');
  await p.locator('[data-composer-markdown]').fill('Native send');
  await p.locator('[data-composer-markdown]').press('Enter');
  await sentCount(p, 1);
  assert.deepEqual(await p.evaluate(() => sent), ['Native send']);
  await p.close();
});

for (const active of [false, true]) {
  test(`clipboard button mounts empty and queues without interrupting (active=${active})`, async () => {
    const p = await fixture({ active, voice: true, clipboard: true, liveMarkup: true });
    await p.locator('#ghrc-clipboard-send-button').waitFor();
    await p.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { value: { readText: async () => 'Clipboard prompt' } });
    });
    await p.locator('[data-composer-markdown]').fill('Keep this draft');
    await p.locator('#ghrc-clipboard-send-button').click();
    await p.locator('.ghrc-message-queue-editor').waitFor();
    assert.equal(await p.evaluate(() => read()), 'Keep this draft');
    assert.equal(await p.evaluate(() => stops), 0);
    if (active) await p.evaluate(() => finish());
    await sentCount(p, 1);
    await p.waitForFunction(() => read() === 'Keep this draft');
    assert.deepEqual(await p.evaluate(() => sent), ['Clipboard prompt']);
    assert.equal(await p.evaluate(() => stops), 0);
    assert.deepEqual(p.errors, []);
    await p.close();
  });
}

test('disclaimer is hidden by default, toggles live, and leaves message content visible', async () => {
  const p = await fixture();
  await p.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<div id="notice">ChatGPT can make mistakes. Check important info.</div><article><p id="message">ChatGPT can make mistakes. This is message content.</p></article>');
  });
  await p.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../js/chatgpt-disclaimer.js'), 'utf8') });
  await p.waitForFunction(() => getComputedStyle(document.getElementById('notice')).display === 'none');
  assert.equal(await p.locator('#message').isVisible(), true);
  await p.evaluate(() => chrome.storage.local.set({ showChatgptDisclaimer: true }));
  await p.waitForFunction(() => getComputedStyle(document.getElementById('notice')).display !== 'none');
  await p.evaluate(() => chrome.storage.local.set({ showChatgptDisclaimer: false }));
  await p.waitForFunction(() => getComputedStyle(document.getElementById('notice')).display === 'none');
  assert.deepEqual(p.errors, []);
  await p.close();
});

test('failed queued send restores a partial draft and preserves the queue for retry', async () => {
  const p = await fixture({ active: true, editable: false });
  await enqueue(p, 'Queued prompt');
  await p.locator('#prompt-textarea').fill('Unfinished draft');
  await p.evaluate(() => { window.rejectSend = true; finish(); });
  await p.getByRole('button', { name: 'Resume queue', exact: true }).waitFor({ timeout: 10000 });
  assert.equal(await p.evaluate(() => read()), 'Unfinished draft');
  assert.equal(await p.locator('.ghrc-message-queue-editor').inputValue(), 'Queued prompt');
  await p.evaluate(() => { window.rejectSend = false; });
  await p.getByRole('button', { name: 'Resume queue', exact: true }).click();
  await sentCount(p, 1);
  await p.waitForFunction(() => read() === 'Unfinished draft');
  assert.deepEqual(await p.evaluate(() => sent), ['Queued prompt']);
  await p.close();
});

for (const paused of [false, true]) {
  test(`Steer sends a selected queued item and preserves the remaining FIFO and draft (paused=${paused})`, async () => {
    const p = await fixture({ active: true });
    await enqueue(p, 'First'); await enqueue(p, 'Selected'); await enqueue(p, 'Last');
    if (paused) await p.getByRole('button', { name: 'Stop', exact: true }).click();
    await p.locator('[data-composer-markdown]').fill('Partial draft');
    await p.getByRole('button', { name: 'Steer queued message', exact: true }).nth(1).click();
    await sentCount(p, 1);
    await p.waitForFunction(() => read() === 'Partial draft' && document.querySelectorAll('.ghrc-message-queue-editor').length === 2);
    assert.equal(await p.evaluate(() => stops), 1);
    assert.deepEqual(await p.evaluate(() => sent), ['Selected']);
    assert.deepEqual(await p.locator('.ghrc-message-queue-editor').evaluateAll(es => es.map(e => e.value)), ['First', 'Last']);
    if (paused) {
      await p.evaluate(() => finish());
      await p.waitForTimeout(1800);
      assert.deepEqual(await p.evaluate(() => sent), ['Selected']);
      await p.getByRole('button', { name: 'Resume queue', exact: true }).click();
    } else await p.evaluate(() => finish());
    await sentCount(p, 2);
    await p.waitForFunction(() => read() === 'Partial draft');
    assert.deepEqual(await p.evaluate(() => sent), ['Selected', 'First']);
    await p.evaluate(() => finish());
    await sentCount(p, 3);
    await p.waitForFunction(() => read() === 'Partial draft' && !document.getElementById('ghrc-message-queue'));
    assert.deepEqual(await p.evaluate(() => sent), ['Selected', 'First', 'Last']);
    assert.deepEqual(p.errors, []);
    await p.close();
  });
}

test('failed Steer retains every queued message in order and restores the draft', async () => {
  const p = await fixture({ active: true, editable: false });
  await enqueue(p, 'First'); await enqueue(p, 'Selected'); await enqueue(p, 'Last');
  await p.locator('#prompt-textarea').fill('Keep draft');
  await p.evaluate(() => { window.rejectSend = true; });
  await p.getByRole('button', { name: 'Steer queued message', exact: true }).nth(1).click();
  await p.getByRole('button', { name: 'Resume queue', exact: true }).waitFor({ timeout: 10000 });
  assert.deepEqual(await p.evaluate(() => sent), []);
  assert.equal(await p.evaluate(() => read()), 'Keep draft');
  assert.deepEqual(await p.locator('.ghrc-message-queue-editor').evaluateAll(es => es.map(e => e.value)), ['First', 'Selected', 'Last']);
  await p.evaluate(() => { window.rejectSend = false; });
  await p.getByRole('button', { name: 'Steer queued message', exact: true }).nth(1).click();
  await sentCount(p, 1);
  await p.waitForFunction(() => read() === 'Keep draft' && document.querySelectorAll('.ghrc-message-queue-editor').length === 2);
  assert.deepEqual(await p.evaluate(() => sent), ['Selected']);
  assert.deepEqual(await p.locator('.ghrc-message-queue-editor').evaluateAll(es => es.map(e => e.value)), ['First', 'Last']);
  await p.close();
});

test('Steer cancels on navigation while waiting for Stop without sending in another chat', async () => {
  const p = await fixture({ active: true });
  await enqueue(p, 'First'); await enqueue(p, 'Selected');
  await p.evaluate(() => { window.deferStop = true; });
  await p.getByRole('button', { name: 'Steer queued message', exact: true }).nth(1).click();
  await p.evaluate(() => {
    history.pushState({}, '', '/c/other');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await p.waitForTimeout(200);
  await p.evaluate(() => finish());
  await p.waitForTimeout(200);
  assert.deepEqual(await p.evaluate(() => sent), []);
  assert.deepEqual(await p.evaluate(() => storage.queuedChatMessages['conversation:test'].map(i => i.text)), ['First', 'Selected']);
  await p.close();
});

test('Steer preserves draft edits made while waiting for the response to stop', async () => {
  const p = await fixture({ active: true });
  await enqueue(p, 'Selected');
  await p.locator('[data-composer-markdown]').fill('Original draft');
  await p.evaluate(() => { window.deferStop = true; });
  await p.getByRole('button', { name: 'Steer queued message', exact: true }).click();
  await p.locator('[data-composer-markdown]').fill('Updated draft');
  await p.evaluate(() => finish());
  await sentCount(p, 1);
  await p.waitForFunction(() => read() === 'Updated draft' && !document.getElementById('ghrc-message-queue'));
  assert.deepEqual(await p.evaluate(() => sent), ['Selected']);
  assert.equal(await p.evaluate(() => stops), 1);
  await p.close();
});

async function attachmentFixture(page) {
  await page.evaluate(() => {
    document.querySelector('form').insertAdjacentHTML('afterbegin', '<input type="file" aria-label="Attach files" multiple><div data-composer-attachments></div>');
    window.sentContexts = [];
    const input = document.querySelector('input[type=file]');
    input.addEventListener('change', () => {
      const surface = document.querySelector('[data-composer-attachments]');
      for (const file of input.files) {
        const chip = document.createElement('div');
        chip.textContent = file.name;
        const remove = document.createElement('button');
        remove.type = 'button'; remove.setAttribute('aria-label', `Remove file ${file.name}`);
        remove.addEventListener('click', () => chip.remove());
        chip.append(remove); surface.append(chip);
      }
    });
    button.addEventListener('click', () => {
      if (!window.active || window.rejectSend) return;
      const surface = document.querySelector('[data-composer-attachments]');
      sentContexts.push([...surface.children].map(e => e.textContent));
      surface.replaceChildren();
    });
  });
}

test('queued attachments stay with their message behind earlier text prompts', async () => {
  const p = await fixture({ active: true });
  await attachmentFixture(p);
  await enqueue(p, 'First plain prompt', true);
  await p.locator('input[type=file]').setInputFiles({ name: 'example.txt', mimeType: 'text/plain', buffer: Buffer.from('Exact file bytes') });
  await enqueue(p, 'Use my file', true);
  assert.equal(await p.locator('[data-composer-attachments]').textContent(), '');
  const stored = await p.evaluate(() => storage.queuedChatMessages['conversation:test'][1]);
  assert.equal(Buffer.from(stored.attachments[0].dataUrl.split(',')[1], 'base64').toString(), 'Exact file bytes');
  await p.evaluate(() => finish());
  await sentCount(p, 1);
  assert.deepEqual(await p.evaluate(() => sentContexts), [[]]);
  await p.evaluate(() => finish());
  await sentCount(p, 2);
  assert.deepEqual(await p.evaluate(() => sent), ['First plain prompt', 'Use my file']);
  assert.deepEqual(await p.evaluate(() => sentContexts), [[], ['example.txt']]);
  assert.deepEqual(p.errors, []);
  await p.close();
});

test('Ask ChatGPT selected text belongs to its queued prompt', async () => {
  const p = await fixture({ active: true });
  await enqueue(p, 'Earlier prompt', true);
  await p.evaluate(() => {
    const quote = document.createElement('blockquote');
    quote.dataset.composerQuote = '';
    quote.append(document.createTextNode('Selected passage'));
    const close = document.createElement('button');
    close.type = 'button'; close.setAttribute('aria-label', 'Remove quote');
    close.addEventListener('click', () => quote.remove());
    quote.append(close); document.querySelector('form').prepend(quote);
  });
  await enqueue(p, 'Explain this', true);
  assert.equal(await p.locator('blockquote').count(), 0);
  await p.evaluate(() => finish()); await sentCount(p, 1);
  assert.deepEqual(await p.evaluate(() => sent), ['Earlier prompt']);
  await p.evaluate(() => finish()); await sentCount(p, 2);
  assert.deepEqual(await p.evaluate(() => sent), ['Earlier prompt', '> Selected passage\n\nExplain this']);
  await p.close();
});

test('a new attachment draft cannot be consumed by an older queued prompt', async () => {
  const p = await fixture({ active: true });
  await attachmentFixture(p);
  await enqueue(p, 'Older prompt', true);
  await p.locator('input[type=file]').setInputFiles({ name: 'draft.txt', mimeType: 'text/plain', buffer: Buffer.from('Draft') });
  await p.locator('[data-composer-markdown]').fill('Unfinished attachment draft');
  await p.evaluate(() => finish());
  await p.waitForTimeout(1900);
  assert.deepEqual(await p.evaluate(() => sent), []);
  assert.equal(await p.evaluate(() => read()), 'Unfinished attachment draft');
  await p.getByRole('button', { name: 'Remove file draft.txt', exact: true }).click();
  await sentCount(p, 1);
  assert.deepEqual(await p.evaluate(() => sentContexts), [[]]);
  await p.close();
});

test('saved attachments survive reload and reattach when their prompt sends', async () => {
  const p = await fixture({ stored: { queuedChatMessages: { 'conversation:test': [{ id: 'saved-file', text: 'Saved prompt', attachments: [{ name: 'saved.txt', type: 'text/plain', dataUrl: 'data:text/plain;base64,U2F2ZWQgYnl0ZXM=' }] }] }, queuedChatMessagesPaused: { 'conversation:test': true } } });
  await attachmentFixture(p);
  await p.getByRole('button', { name: 'Resume queue', exact: true }).click();
  await sentCount(p, 1);
  assert.deepEqual(await p.evaluate(() => sentContexts), [['saved.txt']]);
  assert.deepEqual(await p.evaluate(() => sent), ['Saved prompt']);
  await p.close();
});

test('a failed attachment queue save preserves the original native draft', async () => {
  const p = await fixture({ active: true });
  await attachmentFixture(p);
  await p.locator('input[type=file]').setInputFiles({ name: 'keep.txt', mimeType: 'text/plain', buffer: Buffer.from('Keep') });
  await p.locator('[data-composer-markdown]').fill('Keep file draft');
  await p.evaluate(() => { window.rejectQueueSave = true; });
  await p.locator('[data-composer-markdown]').press('Enter');
  await p.waitForTimeout(300);
  assert.equal(await p.evaluate(() => read()), 'Keep file draft');
  assert.equal(await p.getByRole('button', { name: 'Remove file keep.txt', exact: true }).count(), 1);
  assert.equal(await p.locator('.ghrc-message-queue-editor').count(), 0);
  await p.close();
});
