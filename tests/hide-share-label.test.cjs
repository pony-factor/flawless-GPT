const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../js/chat/hide-share-label.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../css/chat-display.css'), 'utf8');

function fixture(stored = true) {
  const textNode = { textContent: 'Share' };
  const attributes = new Map();
  const rootAttributes = new Map();
  let replaced = false;
  let observerCallback;
  let stop;
  let settingsChanged;
  const frames = [];
  const button = {
    textContent: 'Share',
    firstChild: textNode,
    isConnected: true,
    querySelector(selector) { return selector === 'svg' ? {} : null; },
    hasAttribute(name) { return attributes.has(name); },
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
    removeChild(node) {
      if (this.firstChild !== node) throw new Error('NotFoundError: host text node was replaced');
      this.firstChild = null;
    },
  };
  const document = {
    documentElement: {
      toggleAttribute(name, enabled) {
        if (enabled) rootAttributes.set(name, '');
        else rootAttributes.delete(name);
      },
      removeAttribute(name) { rootAttributes.delete(name); },
    },
    querySelectorAll() { return button.isConnected ? [button] : []; },
    createTreeWalker() { throw new Error('Host text nodes must not be traversed or replaced'); },
    createElement() { replaced = true; throw new Error('Host text nodes must not be wrapped'); },
  };
  const sandbox = {
    document,
    chrome: {
      storage: {
        local: { async get() { return { hideShareLabel: stored }; } },
        onChanged: { addListener(callback) { settingsChanged = callback; } },
      },
    },
    __ghrcExtensionContext: {
      active() { return true; },
      run(action) { return action(); },
      onStop(callback) { stop = callback; },
    },
    MutationObserver: class {
      constructor(callback) { observerCallback = callback; }
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame(callback) { frames.push(callback); },
  };
  vm.runInNewContext(source, sandbox);
  function flushFrames() {
    let limit = 20;
    while (frames.length && limit-- > 0) frames.shift()();
    assert.ok(limit > 0, 'scan must not schedule itself forever');
  }
  return {
    button, attributes, rootAttributes, textNode,
    get replaced() { return replaced; },
    async ready() { await new Promise(resolve => setImmediate(resolve)); flushFrames(); },
    mutate() { observerCallback(); flushFrames(); },
    setEnabled(value) { settingsChanged({ hideShareLabel: { newValue: value } }, 'local'); flushFrames(); },
    stop() { stop(); },
  };
}

test('hiding Share leaves the host text node intact when opening the native dialog', async () => {
  const f = fixture();
  await f.ready();
  assert.equal(f.rootAttributes.has('data-ghrc-hide-share-label'), true);
  assert.equal(f.attributes.has('data-ghrc-share-button'), true);
  assert.equal(f.attributes.get('aria-label'), 'Share');
  assert.equal(f.button.firstChild, f.textNode);
  assert.equal(f.replaced, false);
  assert.doesNotThrow(() => f.button.removeChild(f.textNode));
});

test('Share markers are removed when disabled, changed or unmounted', async () => {
  const f = fixture();
  await f.ready();
  f.setEnabled(false);
  assert.equal(f.attributes.has('data-ghrc-share-button'), false);
  assert.equal(f.rootAttributes.has('data-ghrc-hide-share-label'), false);
  f.setEnabled(true);
  assert.equal(f.attributes.has('data-ghrc-share-button'), true);
  f.button.textContent = 'Copy link';
  f.mutate();
  assert.equal(f.attributes.has('data-ghrc-share-button'), false);
  f.button.textContent = 'Share';
  f.mutate();
  assert.equal(f.attributes.has('data-ghrc-share-button'), true);
  f.button.isConnected = false;
  f.mutate();
  assert.equal(f.attributes.has('data-ghrc-share-button'), false);
  f.stop();
  assert.equal(f.rootAttributes.has('data-ghrc-hide-share-label'), false);
});

test('Share visibility uses scoped CSS rather than replacing native nodes', () => {
  assert.match(css, /\[data-ghrc-share-button\][\s\S]*font-size:\s*0\s*!important/);
  assert.match(css, /\[data-ghrc-share-button\]\s+svg\s*\{\s*font-size:\s*1rem\s*!important/);
  assert.doesNotMatch(source, /replaceWith|createTreeWalker|appendChild/);
});

test('default-off leaves the native Share button untouched', async () => {
  const f = fixture(false);
  await f.ready();
  assert.equal(f.rootAttributes.has('data-ghrc-hide-share-label'), false);
  assert.equal(f.attributes.has('data-ghrc-share-button'), false);
  assert.equal(f.attributes.has('aria-label'), false);
  assert.equal(f.button.firstChild, f.textNode);
});
