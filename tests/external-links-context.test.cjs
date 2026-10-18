const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../js/links/external-links.js'), 'utf8');

function fixture(failure) {
  const writes = [];
  const messages = [];
  const listeners = {};
  const rootStyles = new Map();
  const rootStyleWrites = [];
  let removed = false;
  const apiCall = (calls, value) => {
    calls.push(value);
    if (failure === 'throw') throw new Error('Extension context invalidated.');
    if (failure === 'reject') return Promise.reject(new Error('Extension context invalidated.'));
    return Promise.resolve();
  };
  const context = {
    removed: () => { removed = true; },
    chrome: {
      storage: { local: { set: value => apiCall(writes, value) } },
      runtime: {
        getURL: file => `chrome-extension://test/${file}`,
        sendMessage: value => apiCall(messages, value),
      },
    },
    document: {
      documentElement: {
        removeAttribute() {},
        style: {
          setProperty(name, value) {
            rootStyleWrites.push(["set", name, value]);
            rootStyles.set(name, value);
          },
          removeProperty(name) {
            rootStyleWrites.push(["remove", name]);
            rootStyles.delete(name);
          },
        },
      },
      createElement: () => ({
        setAttribute() {},
        addEventListener: (name, callback) => { listeners[name] = callback; },
      }),
    },
    window: {
      innerWidth: 1280,
      addEventListener: (name, callback) => { listeners[name] = callback; },
      removeEventListener: name => { delete listeners[name]; },
    },
  };
  const boundary = source.indexOf('  function showLinkPreview');
  vm.runInNewContext(source.slice(0, boundary) + `
    previewWidthPx = 612.4;
    previewPanel = { remove() { removed(); }, getBoundingClientRect() { return { width: 612 }; } };
    previewWatch = { id: 'preview-1' };
    globalThis.api = { savePreviewWidth, unwatchLinkPreview, createPreviewResizer, closeLinkPreview, applyPreviewWidth };
  })();`, context);
  return { api: context.api, writes, messages, listeners, rootStyles, rootStyleWrites, removed: () => removed };
}

for (const failure of ['throw', 'reject', null]) {
  test(`preview width persistence handles ${failure || 'successful calls'}`, async () => {
    const f = fixture(failure);
    await f.api.savePreviewWidth();
    assert.equal(f.writes[0].linkPreviewWidth, 612);
  });

  test(`drag completion and closing remain usable with ${failure || 'successful calls'}`, async () => {
    const f = fixture(failure);
    f.api.createPreviewResizer();
    f.listeners.pointerdown({ button: 0, preventDefault() {} });
    assert.doesNotThrow(() => f.listeners.pointerup());
    assert.equal(f.listeners.pointermove, undefined);
    assert.equal(f.listeners.pointerup, undefined);
    assert.doesNotThrow(() => f.api.closeLinkPreview(false));
    await Promise.resolve();
    assert.equal(f.removed(), true);
    assert.equal(f.messages[0].type, 'unwatch-link-preview');
    assert.equal(f.messages[0].previewId, 'preview-1');
  });
}

test('preview width is only written to ChatGPT when a preview is open', () => {
  const f = fixture(null);
  f.api.applyPreviewWidth();
  assert.equal(f.rootStyles.get('--ghrc-preview-width'), '612px');
  assert.deepEqual(f.rootStyleWrites, [['set', '--ghrc-preview-width', '612px']]);

  f.api.closeLinkPreview(false);
  assert.equal(f.rootStyles.has('--ghrc-preview-width'), false);
  assert.deepEqual(f.rootStyleWrites.at(-1), ['remove', '--ghrc-preview-width']);

  const writesAfterClose = f.rootStyleWrites.length;
  f.api.applyPreviewWidth();
  assert.equal(f.rootStyleWrites.length, writesAfterClose);
});
