const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Exercise the actual launcher functions with controlled editor events and time.
const source = fs.readFileSync(require('node:path').join(__dirname, '../js/spellcheck-launcher.js'), 'utf8');
function fixture({ draft = '', paste = 'accept', disabled = false } = {}) {
  let now = 0;
  const timers = [];
  const button = { disabled, clicks: 0, getAttribute() { return null; }, getClientRects() { return [{}]; }, click() { this.clicks++; } };
  const container = { parentElement: null, matches: () => false, querySelectorAll: () => [button] };
  const composer = {
    parentElement: container,
    innerText: draft, isContentEditable: true, isConnected: true,
    focus() {}, closest() { return { querySelector: () => button }; },
    dispatchEvent(event) {
      if (event.type === 'paste' && paste === 'accept') this.innerText = event.clipboardData.text;
      if (event.type === 'paste' && paste === 'partial') this.innerText = 'partial';
      return true;
    },
  };
  const context = {
    chrome: { runtime: { id: "fixture" }, storage: { local: {} } },
    Date: { now: () => now },
    location: { pathname: '/g/g-dyK63miav-spellcheck-only' },
    HTMLTextAreaElement: class {}, HTMLInputElement: class {},
    DataTransfer: class { setData(type, text) { this.text = text; } },
    KeyboardEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    ClipboardEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    window: {
      getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
      setTimeout: (fn, delay) => delay === 50 ? queueMicrotask(fn) : timers.push({ fn, time: now + delay }),
    },
    document: {
      querySelector: () => composer,
      createRange: () => ({ selectNodeContents() {} }),
      execCommand(command, ui, text) { composer.innerText = text; return true; },
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require("node:path").join(__dirname, "../js/extension-context.js"), "utf8"), context);
  vm.runInContext(source.slice(0, source.indexOf('  chrome.storage.onChanged')) + `
    globalThis.api = { pasteIntoComposer, submitWhenReady, findSendButton,
      handoff(text) { pendingClipboardText = text; return runClipboardHandoff(); } };
  })();`, context);
  return { context, composer, button, timers, api: context.api,
    tick() { const timer = timers.shift(); assert.ok(timer); now = timer.time; timer.fn(); } };
}

test('restored homepage draft is replaced with clipboard text before sending', async () => {
  const f = fixture({ draft: 'unrelated draft' });
  await f.api.handoff('clipboard');
  f.tick();
  assert.equal(f.composer.innerText, 'clipboard');
  assert.equal(f.button.clicks, 1);
});
test('accepted clipboard text is submitted exactly once', async () => {
  const f = fixture();
  await f.api.handoff('clipboard\nsecond line');
  f.tick();
  assert.equal(f.composer.innerText, 'clipboard\nsecond line');
  assert.equal(f.button.clicks, 1);
  assert.equal(f.timers.length, 0);
});
test('ignored paste uses insertion fallback', async () => {
  const f = fixture({ paste: 'ignore' });
  assert.equal(await f.api.pasteIntoComposer(f.composer, 'clipboard'), true);
  assert.equal(f.composer.innerText, 'clipboard');
});
test('partial paste does not submit or repeat insertion', async () => {
  const f = fixture({ paste: 'partial' });
  await f.api.handoff('clipboard');
  assert.equal(f.composer.innerText, 'partial');
  assert.equal(f.timers.length, 0);
});
test('disabled Send is retried until ready, then clicked once', async () => {
  const f = fixture({ disabled: true });
  await f.api.handoff('clipboard');
  f.tick(); f.tick();
  assert.equal(f.button.clicks, 0);
  f.button.disabled = false;
  f.tick();
  assert.equal(f.button.clicks, 1);
  assert.equal(f.timers.length, 0);
});
test('permanently disabled Send times out', async () => {
  const f = fixture({ disabled: true });
  await f.api.handoff('clipboard');
  let attempts = 0;
  while (f.timers.length && attempts++ < 60) f.tick();
  assert.equal(f.timers.length, 0);
  assert.equal(f.button.clicks, 0);
});
for (const scenario of ['navigation', 'edit', 'unmount', 'replacement']) {
  test(`pending submission cancels on ${scenario}`, async () => {
    const f = fixture();
    await f.api.handoff('clipboard');
    if (scenario === 'navigation') f.context.location.pathname = '/';
    if (scenario === 'edit') f.composer.innerText = 'user edit';
    if (scenario === 'unmount') f.composer.isConnected = false;
    if (scenario === 'replacement') f.context.document.querySelector = () => ({});
    f.tick();
    assert.equal(f.button.clicks, 0);
    assert.equal(f.timers.length, 0);
  });
}
test('blank clipboard never submits', async () => {
  const f = fixture();
  await f.api.handoff('  \n');
  assert.equal(f.timers.length, 0);
});

test('send action outside the immediate composer container is found', async () => {
  const f = fixture();
  f.composer.closest = () => null;
  const actionRow = f.composer.parentElement;
  f.composer.parentElement = { parentElement: actionRow, matches: () => false, querySelectorAll: () => [] };
  await f.api.handoff('clipboard');
  f.tick();
  assert.equal(f.button.clicks, 1);
});
test('composer-submit-button is supported without the legacy test ID', async () => {
  const f = fixture();
  f.composer.closest = () => null;
  f.composer.parentElement.querySelectorAll = (selector) => selector.includes('#composer-submit-button') ? [f.button] : [];
  await f.api.handoff('clipboard');
  f.tick();
  assert.equal(f.button.clicks, 1);
});
test('hidden send controls do not mask the visible action', async () => {
  const f = fixture();
  const hidden = { ...f.button, getClientRects: () => [] };
  f.composer.parentElement.querySelectorAll = () => [hidden, f.button];
  assert.equal(f.api.findSendButton(f.composer), f.button);
});
test('lookup stops at main rather than selecting another page control', async () => {
  const f = fixture();
  f.composer.closest = () => null;
  f.composer.parentElement = { parentElement: f.composer.parentElement, matches: () => true, querySelectorAll: () => [] };
  assert.equal(f.api.findSendButton(f.composer), null);
});

test('missing Send uses Shift+Enter once and stops when the editor clears', async () => {
  const f = fixture();
  f.composer.closest = () => null;
  f.composer.parentElement.querySelectorAll = () => [];
  const events = [];
  const dispatch = f.composer.dispatchEvent.bind(f.composer);
  f.composer.dispatchEvent = (event) => {
    if (event.type === 'keydown' || event.type === 'keyup') events.push(event);
    if (event.type === 'keydown' && event.key === 'Enter' && event.shiftKey) f.composer.innerText = '';
    return dispatch(event);
  };
  await f.api.handoff('clipboard');
  f.tick(); f.tick();
  assert.deepEqual(events.map(e => [e.type, e.key, e.shiftKey]), [['keydown', 'Enter', true], ['keyup', 'Enter', true]]);
  assert.equal(f.button.clicks, 0);
  assert.equal(f.timers.length, 0);
});
test('ignored shortcut is not repeated and can fall back to a newly mounted Send', async () => {
  const f = fixture();
  f.composer.closest = () => null;
  f.composer.parentElement.querySelectorAll = () => [];
  let keys = 0;
  const dispatch = f.composer.dispatchEvent.bind(f.composer);
  f.composer.dispatchEvent = (event) => { if (event.type === 'keydown') keys++; return dispatch(event); };
  await f.api.handoff('clipboard');
  f.tick(); f.tick();
  f.composer.parentElement.querySelectorAll = () => [f.button];
  f.tick();
  assert.equal(keys, 1);
  assert.equal(f.button.clicks, 1);
});

test('ProseMirror paragraph spacing matches the original clipboard line breaks', async () => {
  const f = fixture();
  await f.api.handoff('First line.\n\nSecond line.');
  const paragraph = (...childNodes) => ({ tagName: 'P', nodeName: 'P', childNodes });
  const text = (nodeValue) => ({ nodeType: 3, nodeValue });
  const trailingBreak = { nodeName: 'BR', classList: { contains: () => true } };
  f.composer.children = [paragraph(text('First line.')), paragraph(trailingBreak), paragraph(text('Second line.'))];
  f.composer.innerText = 'First line.\n\n\n\n\nSecond line.';
  f.tick();
  assert.equal(f.button.clicks, 1);
});

test('asynchronous handled paste settles before verification without duplicate fallback', async () => {
  const f = fixture({ paste: 'ignore' });
  let fallbacks = 0;
  f.context.document.execCommand = () => { fallbacks++; return true; };
  f.composer.dispatchEvent = (event) => {
    if (event.type === 'paste') {
      queueMicrotask(() => { f.composer.innerText = event.clipboardData.text; });
      return false;
    }
    return true;
  };
  await f.api.handoff('First line.\n\nSecond line.');
  f.tick();
  assert.equal(fallbacks, 0);
  assert.equal(f.button.clicks, 1);
  assert.equal(f.composer.innerText, 'First line.\n\nSecond line.');
});

test('restored clipboard draft is sent without pasting a second copy', async () => {
  const f = fixture({ draft: 'clipboard' });
  let pastes = 0;
  f.composer.dispatchEvent = () => { pastes++; return true; };
  await f.api.handoff('clipboard');
  f.tick();
  assert.equal(pastes, 0);
  assert.equal(f.button.clicks, 1);
});
test('handled paste can settle later than the first 50ms check', async () => {
  const f = fixture({ paste: 'ignore' });
  let checks = 0;
  const schedule = f.context.window.setTimeout;
  f.context.window.setTimeout = (fn, delay) => {
    if (delay === 50 && ++checks === 4) f.composer.innerText = 'clipboard';
    return schedule(fn, delay);
  };
  f.composer.dispatchEvent = () => false;
  await f.api.handoff('clipboard');
  f.tick();
  assert.equal(checks, 4);
  assert.equal(f.button.clicks, 1);
});

test('editor selection settles before pasting over a restored draft', async () => {
  const f = fixture({ draft: 'homepage draft' });
  let selectionReady = false;
  const schedule = f.context.window.setTimeout;
  f.context.window.setTimeout = (fn, delay) => schedule(() => { selectionReady = true; fn(); }, delay);
  f.composer.dispatchEvent = (event) => {
    if (event.type === 'paste') {
      assert.equal(selectionReady, true);
      f.composer.innerText = event.clipboardData.text;
      return false;
    }
    return true;
  };
  await f.api.handoff('clipboard');
  f.tick();
  assert.equal(f.button.clicks, 1);
  assert.equal(f.composer.innerText, 'clipboard');
});
