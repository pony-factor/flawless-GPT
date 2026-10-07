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

async function fixture({ active = false, voice = false, editable = true, stored = {}, route = '/c/test', liveMarkup = false, clipboard = false, searches = false, delayQueueStorage = false, queueButton = true, preserveScroll = false } = {}) {
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
  if (preserveScroll) {
    await page.evaluate(() => { storage.preserveScrollPositionOnSend = true; });
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../js/preserve-scroll-on-send.js'), 'utf8') });
  }
  await page.addScriptTag({ content: source });
  if (!delayQueueStorage && queueButton) await page.locator('#ghrc-message-queue-button').waitFor();
  else if (!delayQueueStorage) await page.waitForFunction(() => window.storageListeners.length > 0);
  page.errors = errors;
  return page;
}

test('generating dots keep Enter in the queue when the native Stop control is stale', async () => {
  const p = await fixture({ active: true });
  await p.locator('[data-composer-markdown]').fill('Queue while the dots are active');
  await p.evaluate(() => {
    button.dataset.testid = 'send-button';
    button.setAttribute('aria-label', 'Send prompt');
    const turn = document.querySelector('[data-testid^="conversation-turn-"]:last-child');
    turn.insertAdjacentHTML('beforeend', '<div role="status"><span>•••</span></div>');
  });
  await p.locator('[data-composer-markdown]').press('Enter');
  await p.locator('.ghrc-message-queue-editor').waitFor();
  assert.equal(await p.locator('.ghrc-message-queue-editor').inputValue(), 'Queue while the dots are active');
  assert.deepEqual(await p.evaluate(() => sent), []);
  assert.equal(await p.evaluate(() => stops), 0);
  assert.deepEqual(p.errors, []);
  await p.close();
});

for (const pending of ['generation', 'image-load']) test(`image-only reply advances the queue after ${pending} finishes`, async () => {
  const p = await fixture({ active: true, liveMarkup: true });
  await p.evaluate(async pending => {
    document.querySelector('[data-content-search-unit-key$=":assistant"]').remove();
    const group = document.querySelector('[data-fixture-turn]');
    group.insertAdjacentHTML('beforeend', '<div data-testid="generated-image-gallery"><button data-testid="generated-image-preview"><img></button></div>');
    window.loadImage = async () => {
      const image = document.querySelector('[data-testid="generated-image-preview"] img');
      image.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';
      await image.decode();
    };
    if (pending === 'generation') await loadImage();
    else { window.active = false; update(); }
  }, pending);
  await enqueue(p, 'After the image');
  await p.waitForTimeout(2000);
  assert.equal(await p.evaluate(() => sent.length), 0);
  await p.evaluate(async pending => {
    if (pending === 'generation') { window.active = false; update(); }
    else await loadImage();
  }, pending);
  await sentCount(p, 1);
  assert.deepEqual(await p.evaluate(() => sent), ['After the image']);
  await p.waitForFunction(() => !document.querySelector('.ghrc-message-queue-editor'));
  assert.deepEqual(p.errors, []);
  await p.close();
});
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

for (const liveMarkup of [false, true]) test(`queue follows the latest reply after unanswered earlier messages (${liveMarkup ? 'grouped' : 'article'} turns)`, async () => {
  const p = await fixture({ liveMarkup });
  await p.evaluate(() => {
    addTurn('user');
    addTurn('user');
    addTurn('assistant', true);
  });
  await enqueue(p, 'Continue after the completed reply');
  await sentCount(p, 1);
  await p.waitForFunction(() => !document.querySelector('.ghrc-message-queue-editor') && !read().trim());
  await p.evaluate(() => finish());
  await p.evaluate(() => addTurn('user'));
  await enqueue(p, 'Wait for the newest reply');
  await p.waitForTimeout(2000);
  assert.equal(await p.evaluate(() => sent.length), 1);
  await p.evaluate(() => addTurn('assistant', true));
  await sentCount(p, 2);
  assert.deepEqual(await p.evaluate(() => sent), ['Continue after the completed reply', 'Wait for the newest reply']);
  assert.deepEqual(p.errors, []);
  await p.close();
});

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

test('inline message edits with app mentions stay outside the queue and clipboard composer', async () => {
  const p = await fixture({ active: true, clipboard: true });
  await p.locator('#ghrc-clipboard-send-button').waitFor();
  await p.evaluate(() => {
    const editForm = document.createElement('form');
    editForm.id = 'inline-edit-form';
    editForm.innerHTML = `
      <div id="inline-edit" data-composer-markdown contenteditable="true" role="textbox">
        <p>Edited with <span app-mention-name="Plugin" app-mention-display-name="Plugin" app-mention-path="app://plugin" contenteditable="false">Plugin</span></p>
      </div>
      <button id="inline-edit-send" type="submit" aria-label="Send edit">Send edit</button>
    `;
    document.getElementById('turns').prepend(editForm);
    window.inlineEditSubmits = 0;
    editForm.addEventListener('submit', event => {
      event.preventDefault();
      window.inlineEditSubmits++;
    });
    editForm.querySelector('#inline-edit').addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.defaultPrevented) {
        event.preventDefault();
        editForm.requestSubmit();
      }
    });
  });

  await p.waitForFunction(() => document.getElementById('ghrc-message-queue-button')?.closest('form') !== document.getElementById('inline-edit-form'));
  await p.waitForTimeout(200);
  assert.equal(await p.locator('#inline-edit-form [id^="ghrc-"]').count(), 0);
  await p.evaluate(() => {
    window.editMoves = 0;
    new MutationObserver(records => { window.editMoves += records.length; })
      .observe(document.body, { childList: true, subtree: true });
  });
  await p.waitForTimeout(400);
  assert.equal(await p.evaluate(() => editMoves), 0);
  await p.locator('#inline-edit').press('Enter');

  assert.equal(await p.evaluate(() => window.inlineEditSubmits), 1);
  assert.equal(await p.locator('.ghrc-message-queue-editor').count(), 0);
  assert.equal(await p.evaluate(() => document.getElementById('ghrc-message-queue-button')?.closest('form')?.id || ''), '');
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
  await p.getByRole('button', { name: 'Wait', exact: true }).click();
  await p.evaluate(() => finish());
  await p.waitForTimeout(1800);
  assert.deepEqual(await p.evaluate(() => sent), []);
  const stored = await p.evaluate(() => window.storage);
  const restored = await fixture({ stored });
  await restored.getByRole('button', { name: 'Resume', exact: true }).waitFor();
  await restored.waitForTimeout(1800);
  assert.deepEqual(await restored.evaluate(() => sent), []);
  await restored.getByRole('button', { name: 'Resume', exact: true }).click();
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

test('queued prompt edits survive a delayed storage echo without losing focus', async () => {
  const p = await fixture({ active: true });
  await enqueue(p, 'Original');
  const editor = p.locator('.ghrc-message-queue-editor');

  await p.evaluate(() => { window.delayQueueSave = true; });
  await editor.fill('First edit');
  await p.waitForFunction(() => typeof window.resolveQueueSave === 'function');
  await editor.fill('Second edit');
  await p.evaluate(() => {
    window.delayQueueSave = false;
    window.resolveQueueSave();
  });

  await p.waitForTimeout(350);
  assert.equal(await editor.inputValue(), 'Second edit');
  assert.equal(await editor.evaluate(el => document.activeElement === el), true);
  assert.equal(await p.evaluate(() => storage.queuedChatMessages['conversation:test'][0].text), 'Second edit');
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
  await p.getByRole('button', { name: 'Resume', exact: true }).waitFor({ timeout: 10000 });
  assert.equal(await p.locator('.ghrc-message-queue-editor').inputValue(), 'Retry me');
  assert.equal(await p.evaluate(() => read()), '');
  await p.evaluate(() => { window.rejectSend = false; });
  await p.getByRole('button', { name: 'Resume', exact: true }).click();
  await sentCount(p, 1);
  assert.deepEqual(await p.evaluate(() => sent), ['Retry me']);
  await p.close();
});

test('conversation navigation isolates queues and migrates a new-chat queue', async () => {
  const p = await fixture({ active: true, route: '/' });
  await enqueue(p, 'New chat queue');
  await p.getByRole('button', { name: 'Wait', exact: true }).click();
  await p.evaluate(() => { history.pushState({}, '', '/g/g-example/c/created'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await p.waitForFunction(() => storage.queuedChatMessages?.['conversation:created']?.length === 1);
  assert.equal(await p.evaluate(() => storage.queuedChatMessagesPaused['conversation:created']), true);
  await p.evaluate(() => { history.pushState({}, '', '/c/other'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await p.waitForFunction(() => !document.getElementById('ghrc-message-queue'));
  await p.evaluate(() => { history.pushState({}, '', '/g/g-example/c/created'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await p.getByRole('button', { name: 'Resume', exact: true }).waitFor();
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
  const stop = p.getByRole('button', { name: 'Wait', exact: true });
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

test('new-chat Enter stays native when homepage shell has incomplete turn markup', async () => {
  const p = await fixture({ route: '/' });
  await p.evaluate(() => {
    document.getElementById('turns').insertAdjacentHTML(
      'beforeend',
      '<div data-testid="conversation-turn-loading"></div>',
    );
  });
  await p.locator('[data-composer-markdown]').fill('First message');
  await p.locator('[data-composer-markdown]').press('Enter');
  assert.deepEqual(await p.evaluate(() => sent), ['First message']);
  assert.equal(await p.locator('#ghrc-message-queue').count(), 0);
  assert.equal(await p.evaluate(() => storage.queuedChatMessages), undefined);
  assert.deepEqual(p.errors, []);
  await p.close();
});

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
  test(`clipboard button sends when idle and queues when active (active=${active})`, async () => {
    const p = await fixture({ active, voice: true, clipboard: true, liveMarkup: true });
    await p.locator('#ghrc-clipboard-send-button').waitFor();
    await p.evaluate(active => {
      Object.defineProperty(navigator, 'clipboard', { value: { readText: async () => 'Clipboard prompt' } });
      // Idle sends must work without writing an intermediate queue item.
      if (!active) window.rejectQueueSave = true;
    }, active);
    await p.locator('[data-composer-markdown]').fill('Keep this draft');
    await p.locator('#ghrc-clipboard-send-button').click();
    if (active) {
      await p.locator('.ghrc-message-queue-editor').waitFor();
      assert.equal(await p.evaluate(() => read()), 'Keep this draft');
    } else {
      await sentCount(p, 1);
      assert.equal(await p.locator('.ghrc-message-queue-editor').count(), 0);
      assert.equal(await p.evaluate(() => Object.values(storage.queuedChatMessages || {}).flat().length), 0);
    }
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

test('idle clipboard joins an existing paused queue in FIFO order', async () => {
  const p = await fixture({ clipboard: true, stored: {
    queuedChatMessages: { 'conversation:test': [{ id: 'first', text: 'First prompt' }] },
    queuedChatMessagesPaused: { 'conversation:test': true },
  } });
  await p.locator('#ghrc-clipboard-send-button').waitFor();
  await p.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { readText: async () => 'Clipboard prompt' } });
  });
  await p.locator('#ghrc-clipboard-send-button').click();
  await p.waitForFunction(() => document.querySelectorAll('.ghrc-message-queue-editor').length === 2);
  assert.deepEqual(await p.locator('.ghrc-message-queue-editor').evaluateAll(elements => elements.map(e => e.value)), ['First prompt', 'Clipboard prompt']);
  assert.deepEqual(await p.evaluate(() => sent), []);
  assert.equal(await p.evaluate(() => stops), 0);
  assert.deepEqual(p.errors, []);
  await p.close();
});

test('clipboard stays immediately left of the hat without repeated button moves', async () => {
  const p = await fixture({ active: true, clipboard: true });
  await p.locator('[data-composer-markdown]').fill('Keep draft');
  await p.waitForFunction(() => document.getElementById('ghrc-clipboard-send-button')?.nextElementSibling?.id === 'ghrc-message-interrupt-button');
  assert.equal(await p.locator('#ghrc-message-queue-button').evaluate(e => e.nextElementSibling.id), 'ghrc-clipboard-open-url-button');
  assert.equal(await p.locator('#ghrc-clipboard-open-url-button').evaluate(e => e.nextElementSibling.id), 'ghrc-clipboard-send-button');
  await p.evaluate(() => {
    window.buttonMoves = 0;
    new MutationObserver(rs => { window.buttonMoves += rs.length; }).observe(document.querySelector('form'), { childList: true, subtree: true });
  });
  await p.waitForTimeout(400);
  assert.equal(await p.evaluate(() => buttonMoves), 0);
  await p.evaluate(() => { window.active = false; update(); });
  await p.waitForFunction(() => document.getElementById('ghrc-clipboard-send-button')?.nextElementSibling?.id === 'composer-submit-button');
  await p.close();
});

test('URL and queue controls settle when clipboard sending is disabled', async () => {
  const p = await fixture();
  await p.addScriptTag({ content: clipboardSource });
  await p.locator('[data-composer-markdown]').fill('Keep draft');
  await p.waitForFunction(() => document.getElementById('ghrc-message-queue-button')?.nextElementSibling?.id === 'ghrc-clipboard-open-url-button');
  assert.equal(await p.locator('#ghrc-clipboard-send-button').count(), 0);
  assert.equal(await p.locator('#ghrc-clipboard-open-url-button').evaluate(e => e.nextElementSibling.id), 'composer-submit-button');
  await p.evaluate(() => {
    window.buttonMoves = 0;
    new MutationObserver(records => { window.buttonMoves += records.length; })
      .observe(document.querySelector('form'), { childList: true, subtree: true });
  });
  await p.waitForTimeout(400);
  assert.equal(await p.evaluate(() => buttonMoves), 0);
  assert.deepEqual(p.errors, []);
  await p.close();
});

test('clipboard permission failure falls back to native paste while preserving the draft', async () => {
  const p = await fixture({ active: true, clipboard: true });
  await p.locator('[data-composer-markdown]').fill('Keep draft');
  await p.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { readText: async () => { throw new DOMException('Blocked', 'NotAllowedError'); } } });
    const original = document.execCommand.bind(document);
    document.execCommand = (command, ...args) => {
      if (command !== 'paste') return original(command, ...args);
      document.activeElement.value = 'Fallback clipboard prompt';
      return true;
    };
  });
  await p.locator('#ghrc-clipboard-send-button').click();
  await p.locator('.ghrc-message-queue-editor').waitFor();
  assert.equal(await p.evaluate(() => read()), 'Keep draft');
  assert.equal(await p.locator('.ghrc-message-queue-editor').inputValue(), 'Fallback clipboard prompt');
  assert.equal(await p.evaluate(() => stops), 0);
  assert.equal(await p.locator('textarea[aria-hidden="true"]').count(), 0);
  await p.close();
});

test('clipboard without text reports the reason and leaves the queue empty', async () => {
  const p = await fixture({ active: true, clipboard: true });
  await p.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { readText: async () => '' } });
  });
  await p.locator('#ghrc-clipboard-send-button').click();
  await p.getByRole('button', { name: 'Clipboard has no text to queue', exact: true }).waitFor();
  assert.equal(await p.locator('.ghrc-message-queue-editor').count(), 0);
  await p.close();
});

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
  await p.getByRole('button', { name: 'Resume', exact: true }).waitFor({ timeout: 10000 });
  assert.equal(await p.evaluate(() => read()), 'Unfinished draft');
  assert.equal(await p.locator('.ghrc-message-queue-editor').inputValue(), 'Queued prompt');
  await p.evaluate(() => { window.rejectSend = false; });
  await p.getByRole('button', { name: 'Resume', exact: true }).click();
  await sentCount(p, 1);
  await p.waitForFunction(() => read() === 'Unfinished draft');
  assert.deepEqual(await p.evaluate(() => sent), ['Queued prompt']);
  await p.close();
});

for (const paused of [false, true]) {
  test(`Steer sends a selected queued item and preserves the remaining FIFO and draft (paused=${paused})`, async () => {
    const p = await fixture({ active: true });
    await enqueue(p, 'First'); await enqueue(p, 'Selected'); await enqueue(p, 'Last');
    if (paused) await p.getByRole('button', { name: 'Wait', exact: true }).click();
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
      await p.getByRole('button', { name: 'Resume', exact: true }).click();
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
  await p.getByRole('button', { name: 'Resume', exact: true }).waitFor({ timeout: 10000 });
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

async function attachmentFixture(page, { images = false } = {}) {
  await page.evaluate(({ images }) => {
    document.querySelector('form').insertAdjacentHTML('afterbegin', '<input type="file" aria-label="Attach files" multiple><div data-composer-attachments></div>');
    window.sentContexts = [];
    const input = document.querySelector('input[type=file]');
    const renderFiles = files => {
      const surface = document.querySelector('[data-composer-attachments]');
      for (const file of files) {
        const chip = document.createElement('div');
        chip.className = 'group/composer-attachment';
        chip.dataset.filename = file.name;
        if (images) {
          const image = document.createElement('img');
          image.alt = file.name;
          chip.append(image);
        } else chip.textContent = file.name;
        const remove = document.createElement('button');
        remove.type = 'button'; remove.setAttribute('aria-label', images ? 'Remove image' : `Remove file ${file.name}`);
        remove.addEventListener('click', () => chip.remove());
        chip.append(remove); surface.append(chip);
      }
    };
    input.addEventListener('change', () => renderFiles(input.files));
    editor.addEventListener('paste', event => {
      if (!event.clipboardData?.files.length) return;
      event.preventDefault();
      renderFiles(event.clipboardData.files);
      update();
    });
    button.addEventListener('click', () => {
      if (!window.active || window.rejectSend) return;
      const surface = document.querySelector('[data-composer-attachments]');
      sentContexts.push([...surface.children].map(e => e.dataset.filename));
      surface.replaceChildren();
    });
    if (images) {
      const nativeUpdate = window.update;
      window.update = () => {
        nativeUpdate();
        if (document.querySelector('[data-composer-attachments]').childElementCount && !window.active) button.disabled = false;
      };
      input.addEventListener('change', () => update());
      editor.addEventListener('input', () => update());
      button.addEventListener('click', () => {
        if (window.active || window.rejectSend || read().trim() || !document.querySelector('[data-composer-attachments]').childElementCount) return;
        sent.push('');
        addTurn('user'); addTurn('assistant');
        sentContexts.push([...document.querySelector('[data-composer-attachments]').children].map(e => e.dataset.filename));
        document.querySelector('[data-composer-attachments]').replaceChildren();
        window.active = true;
        update();
      });
    }
  }, { images });
}

for (const gesture of ['Enter', 'button', 'paste']) for (const prompt of ['', 'Describe this image']) test(`queues an image ${prompt ? 'with text' : 'without text'} using ${gesture}`, async () => {
  const p = await fixture({ active: true });
  await attachmentFixture(p, { images: true });
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=', 'base64');
  if (gesture === 'paste') {
    await p.evaluate(data => {
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File([Uint8Array.from(atob(data), char => char.charCodeAt(0))], 'picture.png', { type: 'image/png' }));
      editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData }));
    }, bytes.toString('base64'));
  } else await p.locator('input[type=file]').setInputFiles({ name: 'picture.png', mimeType: 'image/png', buffer: bytes });
  await p.locator('[data-composer-markdown]').fill(prompt);
  if (gesture !== 'button') await p.locator('[data-composer-markdown]').press('Enter');
  else await p.locator('#ghrc-message-queue-button').click();
  await p.waitForFunction(() => storage.queuedChatMessages?.['conversation:test']?.length === 1 && !document.querySelector('[data-composer-attachments]').childElementCount);
  const item = await p.evaluate(() => storage.queuedChatMessages['conversation:test'][0]);
  assert.equal(item.text, prompt);
  assert.equal(item.attachments[0].type, 'image/png');
  assert.deepEqual(Buffer.from(item.attachments[0].dataUrl.split(',')[1], 'base64'), bytes);
  assert.equal(await p.evaluate(() => stops), 0);
  await p.evaluate(() => finish());
  await sentCount(p, 1);
  assert.deepEqual(await p.evaluate(() => sent), [prompt]);
  assert.deepEqual(await p.evaluate(() => sentContexts), [['picture.png']]);
  assert.deepEqual(p.errors, []);
  await p.close();
});

test('saved image-only messages reattach and send after reload', async () => {
  const p = await fixture({ stored: {
    queuedChatMessages: { 'conversation:test': [{ id: 'saved-image', text: '', attachments: [{ name: 'picture.png', type: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=' }] }] },
    queuedChatMessagesPaused: { 'conversation:test': true },
  } });
  await attachmentFixture(p, { images: true });
  await p.getByRole('button', { name: 'Resume', exact: true }).click();
  await sentCount(p, 1);
  assert.deepEqual(await p.evaluate(() => sent), ['']);
  assert.deepEqual(await p.evaluate(() => sentContexts), [['picture.png']]);
  await p.waitForFunction(() => !storage.queuedChatMessages['conversation:test']?.length);
  assert.deepEqual(p.errors, []);
  await p.close();
});

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

async function selectedTextFixture(page, passages) {
  await page.evaluate(passages => {
    const surface = document.createElement('div');
    surface.dataset.composerAttachments = '';
    for (const [index, text] of passages.entries()) {
      const card = document.createElement('span');
      card.className = 'group/composer-attachment';
      const preview = document.createElement('span');
      preview.className = 'line-clamp-4 whitespace-pre-wrap';
      preview.textContent = text;
      const title = document.createElement('span');
      title.textContent = 'Selection';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove selected text ${index + 1}`);
      remove.addEventListener('click', () => {
        card.remove();
        if (!surface.childElementCount) surface.remove();
      });
      card.append(preview, title, remove);
      surface.append(card);
    }
    document.querySelector('form').prepend(surface);
    // Native Enter interrupts if the extension lets the event reach the host.
    document.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.defaultPrevented) button.click();
    }, true);
  }, passages);
}

for (const prompt of ['Explain these passages', '']) test(`Selection attachments queue without interrupting (${prompt ? 'with prompt' : 'selection only'})`, async () => {
  const p = await fixture({ active: true });
  const passages = ['First selected passage. '.repeat(30).trim(), 'Second passage\nwith another line'];
  await selectedTextFixture(p, passages);
  await enqueue(p, prompt, true);
  assert.equal(await p.evaluate(() => stops), 0);
  assert.deepEqual(await p.evaluate(() => sent), []);
  assert.equal(await p.locator('[data-composer-attachments]').count(), 0);
  const expected = `> ${passages[0]}\n>\n> Second passage\n> with another line${prompt ? '\n\n' + prompt : ''}`;
  assert.equal(await p.locator('.ghrc-message-queue-editor').inputValue(), expected);
  await p.evaluate(() => finish());
  await sentCount(p, 1);
  assert.deepEqual(await p.evaluate(() => sent), [expected]);
  assert.deepEqual(p.errors, []);
  await p.close();
});

test('a newer Selection attachment prevents an older queued message from sending', async () => {
  const p = await fixture({ active: true });
  await enqueue(p, 'Older prompt', true);
  await selectedTextFixture(p, ['New selected passage']);
  await p.evaluate(() => finish());
  await p.waitForTimeout(1900);
  assert.deepEqual(await p.evaluate(() => sent), []);
  await p.getByRole('button', { name: 'Remove selected text 1', exact: true }).click();
  await sentCount(p, 1);
  assert.deepEqual(await p.evaluate(() => sent), ['Older prompt']);
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
  await p.getByRole('button', { name: 'Resume', exact: true }).click();
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

async function scrollFixture(page, { modern = false, short = false } = {}) {
  await page.evaluate(({ modern, short }) => {
    const scroller = document.createElement('section');
    scroller.id = 'conversation-scroller';
    scroller.style.cssText = 'height:320px;overflow-y:auto;scroll-behavior:smooth';
    const turns = document.getElementById('turns');
    turns.before(scroller);
    scroller.append(turns);
    if (!short) for (let i = 0; i < 12; i++) {
      const turn = document.createElement('article');
      if (!modern) turn.dataset.testid = `conversation-turn-history-${i}`;
      turn.innerHTML = i % 2
        ? '<div data-message-author-role="assistant">History</div><button data-testid="copy-turn-action-button">Copy</button>'
        : '<div data-message-author-role="user">History</div>';
      turn.style.height = '180px';
      turns.append(turn);
    }
    // Model native auto-scroll, long streaming output and composer collapse.
    window.nativeAddTurn = window.addTurn;
    window.addTurn = (role, complete) => {
      nativeAddTurn(role, complete);
      turns.lastElementChild.style.minHeight = '900px';
      scroller.scrollTo({ top: scroller.scrollHeight });
    };
    window.scroller = scroller;
    scroller.scrollTo({ top: short ? 0 : 600, behavior: 'instant' });
    window.expectedScroll = scroller.scrollTop;
  }, { modern, short });
}

for (const modern of [false, true]) test(`keep scroll on long native Enter with an empty queue (${modern ? 'modern' : 'legacy'} markup)`, async () => {
  const p = await fixture({ preserveScroll: true });
  await scrollFixture(p, { modern });
  const editor = p.locator('[data-composer-markdown]');
  await editor.fill('A very long sentence with lots of detail. '.repeat(300));
  await p.evaluate(() => document.addEventListener('keydown', event => {
    if (event.key === 'Enter') scroller.scrollTo({ top: 1600, behavior: 'instant' });
  }, true));
  await editor.press('Enter');
  await sentCount(p, 1);
  await p.waitForTimeout(450);
  assert.equal(await p.evaluate(() => scroller.scrollTop), 600);
  // Delayed streaming growth and native smooth scroll still preserve the offset.
  await p.evaluate(() => {
    document.getElementById('turns').lastElementChild.style.height = '2200px';
    scroller.scrollTo({ top: scroller.scrollHeight });
  });
  await p.waitForTimeout(450);
  assert.equal(await p.evaluate(() => scroller.scrollTop), 600);
  // Editing a draft with arrow keys must not release the reading position.
  await editor.press('ArrowUp');
  await p.evaluate(() => { scroller.scrollTop = 1800; });
  await p.waitForTimeout(100);
  assert.equal(await p.evaluate(() => scroller.scrollTop), 600);
  // Deliberate wheel input moves the reading position; streaming cannot undo it.
  await p.evaluate(() => {
    scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 250 }));
  });
  await p.waitForTimeout(100);
  assert.equal(await p.evaluate(() => scroller.scrollTop), 850);
  await p.evaluate(() => { scroller.scrollTop = scroller.scrollHeight; });
  await p.waitForTimeout(100);
  assert.equal(await p.evaluate(() => scroller.scrollTop), 850);
  assert.deepEqual(p.errors, []);
  await p.close();
});

test('sidebar toggles preserve visible text through width reflow and native scrolling', async () => {
  const p = await fixture({ preserveScroll: true });
  await scrollFixture(p);
  await p.evaluate(() => {
    scroller.style.width = '600px';
    for (const message of document.querySelectorAll('[data-message-author-role]')) {
      message.textContent = 'Reading text with wrapping. '.repeat(20);
    }
    const button = document.createElement('button');
    button.setAttribute('aria-label', 'Show sidebar');
    document.body.prepend(button);
    button.onclick = () => {
      scroller.style.width = button.getAttribute('aria-label') === 'Show sidebar' ? '300px' : '600px';
      button.setAttribute('aria-label', button.getAttribute('aria-label') === 'Show sidebar' ? 'Hide sidebar' : 'Show sidebar');
      scroller.scrollTop = scroller.scrollHeight;
    };
    window.anchor = [...document.querySelectorAll('[data-message-author-role]')]
      .find(e => e.getBoundingClientRect().bottom > scroller.getBoundingClientRect().top);
    window.anchorTop = anchor.getBoundingClientRect().top;
  });
  for (const label of ['Show sidebar', 'Hide sidebar']) {
    // Hover reveal uses a synthetic click, without pointerdown.
    await p.evaluate(label => document.querySelector(`button[aria-label="${label}"]`).click(), label);
    await p.waitForTimeout(100);
    assert.equal(await p.evaluate(() => anchor.getBoundingClientRect().top), await p.evaluate(() => anchorTop));
  }
  assert.deepEqual(p.errors, []);
  await p.close();
});

for (const zoom of [1, 1.25, 2]) test(`portrait sidebar reflow preserves the screen position at scale ${zoom}`, async () => {
  const p = await fixture({ preserveScroll: true });
  await p.setViewportSize({ width: 900, height: 1600 });
  await scrollFixture(p);
  await p.evaluate(zoom => {
    scroller.style.zoom = zoom;
    scroller.style.height = '320.5px';
    scroller.style.width = '300px';
    scroller.scrollTop = 600;
    window.anchor = [...document.querySelectorAll('[data-message-author-role]')]
      .find(e => e.getBoundingClientRect().bottom > scroller.getBoundingClientRect().top);
    window.anchorTop = anchor.getBoundingClientRect().top;
    const button = document.createElement('button');
    button.setAttribute('aria-label', 'Show sidebar');
    button.style.position = 'fixed';
    document.body.append(button);
    button.onclick = () => {
      // Narrow layouts can move the conversation viewport as well as resize it.
      scroller.style.position = 'relative';
      scroller.style.top = `${2 / zoom}px`;
      scroller.style.width = '250px';
    };
    button.click();
  }, zoom);
  await p.waitForTimeout(150);
  assert.equal(await p.evaluate(() => anchor.getBoundingClientRect().top), await p.evaluate(() => anchorTop));
  // A fractional native scroll must also be corrected at display scale.
  await p.evaluate(() => { scroller.scrollTop += 1 / 2; });
  await p.waitForTimeout(100);
  assert.equal(await p.evaluate(() => anchor.getBoundingClientRect().top), await p.evaluate(() => anchorTop));
  await p.evaluate(zoom => {
    // This move falls exactly between two representable scroll positions.
    scroller.style.top = `${2.5 / zoom}px`;
    document.getElementById('turns').append(document.createElement('div'));
  }, zoom);
  await p.waitForTimeout(100);
  const residual = await p.evaluate(() => anchor.getBoundingClientRect().top - anchorTop);
  assert.ok(residual >= 0 && residual <= 0.51, `rounded correction moved text by ${residual}px`);
  assert.deepEqual(p.errors, []);
  await p.close();
});

test('first response remains freely scrollable after receiving its conversation URL', async () => {
  const p = await fixture({ preserveScroll: true, route: '/' });
  await scrollFixture(p, { short: true });
  await p.locator('[data-composer-markdown]').fill('First prompt');
  await p.locator('[data-composer-markdown]').press('Enter');
  await sentCount(p, 1);
  await p.evaluate(() => {
    history.replaceState({}, '', '/c/first-response');
    document.getElementById('turns').lastElementChild.style.height = '2400px';
    scroller.scrollTop = scroller.scrollHeight;
  });
  await p.waitForTimeout(100);
  assert.equal(await p.evaluate(() => scroller.scrollTop), 0);
  const bounds = await p.locator('#conversation-scroller').boundingBox();
  await p.mouse.move(bounds.x + 50, bounds.y + 100);
  await p.mouse.wheel(0, 300);
  await p.waitForTimeout(100);
  assert.equal(await p.evaluate(() => scroller.scrollTop), 300);
  await p.evaluate(() => {
    document.getElementById('turns').lastElementChild.style.height = '3200px';
    scroller.scrollTop = scroller.scrollHeight;
  });
  await p.waitForTimeout(100);
  assert.equal(await p.evaluate(() => scroller.scrollTop), 300);
  assert.deepEqual(p.errors, []);
  await p.close();
});

test('streaming response scrolls both ways over a horizontal source carousel', async () => {
  const p = await fixture({ preserveScroll: true });
  await scrollFixture(p);
  await p.locator('[data-composer-markdown]').fill('Scroll over sources');
  await p.locator('[data-composer-markdown]').press('Enter');
  await sentCount(p, 1);
  await p.evaluate(() => {
    const carousel = document.createElement('div');
    carousel.id = 'sources';
    carousel.style.cssText = 'height:120px;overflow-x:auto;width:280px';
    carousel.innerHTML = '<div style="width:900px;height:100px">Sources</div>';
    scroller.append(carousel);
    carousel.style.position = 'sticky';
    carousel.style.bottom = '0';
  });
  const bounds = await p.locator('#sources').boundingBox();
  await p.mouse.move(bounds.x + 40, bounds.y + 40);
  await p.mouse.wheel(0, 120);
  await p.waitForTimeout(100);
  assert.equal(await p.evaluate(() => scroller.scrollTop), 720);
  await p.mouse.wheel(0, -180);
  await p.waitForTimeout(100);
  assert.equal(await p.evaluate(() => scroller.scrollTop), 540);
  await p.evaluate(() => {
    document.getElementById('turns').lastElementChild.style.height = '3200px';
    scroller.scrollTop = scroller.scrollHeight;
  });
  await p.waitForTimeout(100);
  assert.equal(await p.evaluate(() => scroller.scrollTop), 540);
  assert.deepEqual(p.errors, []);
  await p.close();
});

test('wheel scrolling restores a pending streaming jump before applying the user delta', async () => {
  const p = await fixture({ preserveScroll: true });
  await scrollFixture(p);
  await p.locator('[data-composer-markdown]').fill('Streaming wheel race');
  await p.locator('[data-composer-markdown]').press('Enter');
  await sentCount(p, 1);
  await p.waitForTimeout(100);
  const position = await p.evaluate(() => {
    document.getElementById('turns').lastElementChild.style.height = '3200px';
    scroller.scrollTop = scroller.scrollHeight;
    scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 250 }));
    return scroller.scrollTop;
  });
  assert.equal(position, 850);
  await p.waitForTimeout(100);
  assert.equal(await p.evaluate(() => scroller.scrollTop), 850);
  assert.deepEqual(p.errors, []);
  await p.close();
});

for (const reverse of [false, true]) for (const singleParagraph of [false, true]) {
  test(`very large text-only streaming reply scrolls midway (${reverse ? 'reverse' : 'normal'}, ${singleParagraph ? 'one clipped paragraph' : 'many paragraphs'})`, async () => {
    const p = await fixture({ preserveScroll: true, liveMarkup: true });
    await scrollFixture(p, { modern: true });
    await p.locator('[data-composer-markdown]').fill('Large text-only scroll test');
    await p.locator('[data-composer-markdown]').press('Enter');
    await sentCount(p, 1);
    await p.evaluate(({ reverse, singleParagraph }) => {
      scroller.style.width = '360px';
      if (reverse) {
        scroller.style.display = 'flex';
        scroller.style.flexDirection = 'column-reverse';
        document.getElementById('turns').style.flexShrink = '0';
      }
      window.reply = document.querySelector('[data-content-search-unit-key$=":assistant"]:last-child');
      const sentence = 'A long text-only response keeps growing while the reader moves through its middle. ';
      if (singleParagraph) {
        reply.innerHTML = '<p></p>';
        reply.firstChild.textContent = sentence.repeat(2000);
      } else {
        reply.replaceChildren(...Array.from({ length: 500 }, () => {
          const paragraph = document.createElement('p');
          paragraph.textContent = sentence.repeat(4);
          return paragraph;
        }));
      }
      window.streamTicks = 0;
      window.streamTimer = setInterval(() => {
        if (singleParagraph) reply.firstChild.firstChild.appendData(sentence.repeat(4));
        else {
          const paragraph = document.createElement('p');
          paragraph.textContent = sentence.repeat(4);
          reply.append(paragraph);
        }
        streamTicks++;
        scroller.scrollTop = reverse ? 0 : scroller.scrollHeight;
      }, 30);
    }, { reverse, singleParagraph });
    await p.waitForTimeout(100);
    const bounds = await p.locator('#conversation-scroller').boundingBox();
    await p.mouse.move(bounds.x + 100, bounds.y + 160);
    const toMiddle = await p.evaluate(({ reverse }) => {
      const range = scroller.scrollHeight - scroller.clientHeight;
      return (reverse ? -range / 2 : range / 2) - scroller.scrollTop;
    }, { reverse });
    await p.mouse.wheel(0, toMiddle);
    await p.waitForTimeout(100);
    assert.ok(await p.evaluate(() => reply.textContent.length > 150000 && active));
    assert.equal(await p.evaluate(() => scroller.querySelectorAll('img,pre').length), 0);
    for (const delta of [240, -480, 360, -180]) {
      const before = await p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve({ top: reply.getBoundingClientRect().top, ticks: streamTicks })))));
      await p.mouse.wheel(0, delta);
      await p.waitForTimeout(150);
      const after = await p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve({ top: reply.getBoundingClientRect().top, ticks: streamTicks })))));
      assert.ok(after.ticks > before.ticks, 'text continues generating during scrolling');
      assert.ok(Math.abs(after.top - (before.top - delta)) <= 1, `wheel ${delta} moves visible text while streaming: ${JSON.stringify({ before, after })}`);
    }
    const held = await p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(reply.getBoundingClientRect().top)))));
    await p.waitForTimeout(200);
    assert.ok(Math.abs(await p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(reply.getBoundingClientRect().top))))) - held) <= 1);
    await p.evaluate(() => clearInterval(streamTimer));
    assert.deepEqual(p.errors, []);
    await p.close();
  });
}

test('nested code panes scroll themselves and hand off at their vertical edges', async () => {
  const p = await fixture({ preserveScroll: true });
  await scrollFixture(p);
  await p.evaluate(() => {
    const pane = document.createElement('pre');
    pane.id = 'code-pane';
    pane.style.cssText = 'height:100px;overflow:auto;position:sticky;bottom:0;margin:0';
    pane.innerHTML = '<code style="display:block;height:600px">Long code</code>';
    scroller.append(pane);
    document.dispatchEvent(new Event('ghrc:before-composer-send'));
  });
  const bounds = await p.locator('#code-pane').boundingBox();
  await p.mouse.move(bounds.x + 40, bounds.y + 40);
  await p.mouse.wheel(0, 120);
  await p.waitForTimeout(250);
  assert.ok(await p.evaluate(() => document.getElementById('code-pane').scrollTop > 0));
  assert.equal(await p.evaluate(() => scroller.scrollTop), 600);
  await p.evaluate(() => {
    const pane = document.getElementById('code-pane');
    pane.scrollTop = pane.scrollHeight;
  });
  await p.mouse.wheel(0, 120);
  await p.waitForTimeout(100);
  assert.equal(await p.evaluate(() => scroller.scrollTop), 720);
  await p.evaluate(() => { document.getElementById('code-pane').scrollTop = 0; });
  await p.mouse.wheel(0, -180);
  await p.waitForTimeout(100);
  assert.equal(await p.evaluate(() => scroller.scrollTop), 540);
  assert.deepEqual(p.errors, []);
  await p.close();
});

test('keyboard scrolling updates the reading position without releasing streaming protection', async () => {
  const p = await fixture({ preserveScroll: true });
  await scrollFixture(p);
  await p.locator('[data-composer-markdown]').fill('Keyboard scrolling');
  await p.locator('[data-composer-markdown]').press('Enter');
  await sentCount(p, 1);
  await p.evaluate(() => { scroller.tabIndex = 0; scroller.focus({ preventScroll: true }); });
  await p.keyboard.press('PageDown');
  await p.waitForTimeout(400);
  const position = await p.evaluate(() => scroller.scrollTop);
  assert.ok(position > 600);
  await p.evaluate(() => {
    document.getElementById('turns').lastElementChild.style.height = '3200px';
    scroller.scrollTop = scroller.scrollHeight;
  });
  await p.waitForTimeout(100);
  assert.equal(await p.evaluate(() => scroller.scrollTop), position);
  assert.deepEqual(p.errors, []);
  await p.close();
});

test('keep scroll finds a conversation container before it overflows', async () => {
  const p = await fixture({ active: true, preserveScroll: true });
  await scrollFixture(p, { short: true });
  await enqueue(p, 'Long queued message. '.repeat(400), true);
  await p.evaluate(() => finish());
  await sentCount(p, 1);
  await p.waitForTimeout(450);
  assert.equal(await p.evaluate(() => scroller.scrollTop), 0);
  assert.deepEqual(p.errors, []);
  await p.close();
});

test('keep scroll through three long queued prompts and composer replacement', async () => {
  const p = await fixture({ active: true, preserveScroll: true });
  await scrollFixture(p, { modern: true });
  for (let i = 1; i <= 3; i++) await enqueue(p, `Queued message ${i}. ` + 'A long sentence. '.repeat(300), true);
  for (let i = 1; i <= 3; i++) {
    await p.evaluate(() => finish());
    await sentCount(p, i);
    await p.waitForTimeout(450);
    assert.equal(await p.evaluate(() => scroller.scrollTop), 600);
  }
  await p.waitForFunction(() => !document.querySelector('.ghrc-message-queue-editor'));
  assert.deepEqual(await p.evaluate(() => sent.map(text => text.slice(0, 17))), ['Queued message 1.', 'Queued message 2.', 'Queued message 3.']);
  assert.deepEqual(p.errors, []);
  await p.close();
});

test('keep scroll follows a replaced conversation scroller and releases on navigation', async () => {
  const p = await fixture({ preserveScroll: true });
  await scrollFixture(p);
  await p.locator('[data-composer-markdown]').fill('Native click send');
  await p.getByRole('button', { name: 'Send prompt', exact: true }).click();
  await sentCount(p, 1);
  await p.evaluate(() => {
    const replacement = document.createElement('section');
    replacement.id = scroller.id;
    replacement.style.cssText = 'height:320px;overflow-y:auto;scroll-behavior:smooth';
    while (scroller.firstChild) replacement.append(scroller.firstChild);
    scroller.replaceWith(replacement);
    window.oldScroller = scroller;
    window.scroller = replacement;
    scroller.scrollTo({ top: 1800, behavior: 'instant' });
  });
  await p.waitForTimeout(100);
  assert.equal(await p.evaluate(() => scroller.scrollTop), 600);
  assert.equal(await p.evaluate(() => oldScroller.style.scrollBehavior), 'smooth');
  await p.evaluate(() => {
    history.pushState({}, '', '/c/another');
    document.getElementById('turns').append(document.createElement('div'));
  });
  await p.waitForTimeout(100);
  assert.equal(await p.evaluate(() => scroller.style.scrollBehavior), 'smooth');
  assert.deepEqual(p.errors, []);
  await p.close();
});

test('keep visible text steady in the live reverse-flex layout during long streaming replies', async () => {
  const p = await fixture({ preserveScroll: true });
  await scrollFixture(p, { modern: true });
  await p.evaluate(() => {
    scroller.style.display = 'flex';
    scroller.style.flexDirection = 'column-reverse';
    document.getElementById('turns').style.flexShrink = '0';
    scroller.scrollTo({ top: -900, behavior: 'instant' });
    window.anchor = [...document.querySelectorAll('[data-message-author-role]')]
      .find(e => e.getBoundingClientRect().top >= scroller.getBoundingClientRect().top);
    window.anchorTop = anchor.getBoundingClientRect().top;
  });
  await p.locator('[data-composer-markdown]').fill('Reverse-layout long message. '.repeat(300));
  await p.locator('[data-composer-markdown]').press('Enter');
  await sentCount(p, 1);
  await p.waitForTimeout(100);
  assert.equal(await p.evaluate(() => anchor.getBoundingClientRect().top), await p.evaluate(() => anchorTop));
  for (const height of [1800, 2600, 4000]) {
    await p.evaluate(height => {
      document.getElementById('turns').lastElementChild.style.height = `${height}px`;
      scroller.scrollTo({ top: 0 });
    }, height);
    await p.waitForTimeout(100);
    assert.equal(await p.evaluate(() => anchor.getBoundingClientRect().top), await p.evaluate(() => anchorTop));
  }
  const previous = await p.evaluate(() => scroller.scrollTop);
  const bounds = await p.locator('#conversation-scroller').boundingBox();
  await p.mouse.move(bounds.x + 50, bounds.y + 100);
  await p.mouse.wheel(0, -250);
  await p.waitForTimeout(100);
  assert.equal(await p.evaluate(() => scroller.scrollTop), previous - 250);
  const readingTop = await p.evaluate(() => anchor.getBoundingClientRect().top);
  await p.evaluate(() => {
    document.getElementById('turns').lastElementChild.style.height = '4800px';
    scroller.scrollTop = 0;
  });
  await p.waitForTimeout(100);
  assert.equal(await p.evaluate(() => anchor.getBoundingClientRect().top), readingTop);
  assert.deepEqual(p.errors, []);
  await p.close();
});

test('long queued prompts use text insertion before a native paste-to-file handler', async () => {
  const p = await fixture({ active: true, preserveScroll: true });
  await scrollFixture(p);
  await p.evaluate(() => {
    window.pasteConversions = 0;
    editor.addEventListener('paste', event => {
      if (event.clipboardData.getData('text/plain').length > 2000) {
        event.preventDefault();
        window.pasteConversions++;
        clear(); update();
      }
    });
  });
  const text = 'A very long queued sentence. '.repeat(350);
  await enqueue(p, text, true);
  await p.evaluate(() => finish());
  await sentCount(p, 1);
  assert.deepEqual(await p.evaluate(() => sent), [text.trim()]);
  assert.equal(await p.evaluate(() => pasteConversions), 0);
  assert.equal(await p.evaluate(() => scroller.scrollTop), 600);
  assert.deepEqual(p.errors, []);
  await p.close();
});

test('keep visible text steady when the document itself scrolls', async () => {
  const p = await fixture({ preserveScroll: true });
  await scrollFixture(p);
  await p.evaluate(() => {
    scroller.style.height = 'auto';
    scroller.style.overflowY = 'visible';
    window.scrollTo({ top: 600, behavior: 'instant' });
    window.anchor = [...document.querySelectorAll('[data-message-author-role]')]
      .find(e => e.getBoundingClientRect().top >= 0);
    window.anchorTop = anchor.getBoundingClientRect().top;
    const native = addTurn;
    window.addTurn = (...args) => { native(...args); window.scrollTo(0, document.body.scrollHeight); };
  });
  await p.locator('[data-composer-markdown]').fill('Document scrolling test');
  // Focus can scroll the composer into view before Enter; preserve the reading
  // position present at the actual send gesture.
  await p.evaluate(() => { window.scrollTo({ top: 600, behavior: 'instant' }); });
  await p.evaluate(() => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  await sentCount(p, 1);
  await p.waitForTimeout(100);
  assert.equal(await p.evaluate(() => anchor.getBoundingClientRect().top), await p.evaluate(() => anchorTop));
  assert.deepEqual(p.errors, []);
  await p.close();
});

async function enableAppMentions(page) {
  await page.evaluate(() => {
    window.sentApps = [];
    editor.addEventListener('paste', event => {
      const html = event.clipboardData.getData('text/html');
      if (!html) return;
      event.preventDefault();
      document.execCommand('insertHTML', false, html);
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });
    button.addEventListener('click', () => {
      if (!window.active && !window.rejectSend) window.sentApps.push(
        [...editor.querySelectorAll('[app-mention-path]')].map(node => node.getAttribute('app-mention-path')));
    }, true);
  });
}

for (const [label, connector] of [['Deep research', 'connector_openai_deep_research'], ['CourtListener', 'courtlistener']]) {
  test(`queued ${label} preserves app identity through storage and prompt edits`, async () => {
    let p = await fixture({ active: true });
    await enableAppMentions(p);
    await p.evaluate(({ label, connector }) => {
      editor.innerHTML = '<p><span contenteditable="false"></span> Investigate this topic</p>';
      const mention = editor.querySelector('span');
      mention.textContent = label;
      mention.setAttribute('app-mention-path', 'app://' + connector);
      mention.setAttribute('app-mention-name', connector);
      mention.setAttribute('app-mention-display-name', label);
      mention.setAttribute('data-prompt-link-href', 'app://' + connector);
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }, { label, connector });
    await p.locator('[data-composer-markdown]').press('Enter');
    await p.locator('.ghrc-message-queue-editor').waitFor();
    const saved = await p.evaluate(() => structuredClone(storage));
    assert.equal(saved.queuedChatMessages['conversation:test'][0].mentions[0].attributes['app-mention-path'], 'app://' + connector);
    await p.close();
    p = await fixture({ active: true, stored: saved });
    await enableAppMentions(p);
    await p.locator('.ghrc-message-queue-editor').fill(label + ' Investigate another topic');
    await p.evaluate(() => {
      editor.innerHTML = '<p><span app-mention-path="app://draft-app" app-mention-name="draft-app" contenteditable="false">Draft app</span> Later draft</p>';
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      finish();
    });
    await sentCount(p, 1);
    assert.deepEqual(await p.evaluate(() => sentApps), [['app://' + connector]]);
    await p.waitForFunction(() => editor.querySelector('[app-mention-path="app://draft-app"]'));
    assert.equal(await p.evaluate(() => read()), 'Draft app Later draft');
    assert.deepEqual(p.errors, []);
    await p.close();
  });
}

test('app restoration failure keeps the message queued and pauses instead of sending plain text', async () => {
  const p = await fixture({ active: true });
  await p.evaluate(() => {
    editor.innerHTML = '<p><span app-mention-path="app://research" contenteditable="false">Research</span> Topic</p>';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await p.locator('[data-composer-markdown]').press('Enter');
  await p.locator('.ghrc-message-queue-editor').waitFor();
  await p.evaluate(() => finish());
  await p.waitForFunction(() => storage.queuedChatMessagesPaused?.['conversation:test'] === true);
  assert.deepEqual(await p.evaluate(() => sent), []);
  assert.equal(await p.locator('.ghrc-message-queue-editor').count(), 1);
  assert.deepEqual(p.errors, []);
  await p.close();
});
