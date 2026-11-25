const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../js/core/service-worker.js'), 'utf8');
const sender = { url: 'https://chatgpt.com/', frameId: 0, tab: { id: 17 } };

function worker({ failUpdate = false } = {}) {
  const updates = [];
  let listener;
  const chrome = {
    tabs: {
      async update(id, options) {
        if (failUpdate) throw new Error('Navigation failed');
        updates.push([id, options.url]);
      },
      create() { throw new Error('WootenLink search must not create a new tab'); },
    },
    runtime: { onMessage: { addListener(callback) { listener = callback; } } },
  };
  chrome.runtime.onInstalled = { addListener() {} };
  vm.runInNewContext(source, { URL, chrome, importScripts() {}, TokenVault: { loadTokens: async () => [] } });
  return {
    updates,
    listener,
    search: (url, origin = sender) => new Promise(resolve => {
      assert.equal(listener({ type: 'open-wooten-link', url }, origin, response => resolve(JSON.parse(JSON.stringify(response)))), true);
    }),
  };
}

test('WootenLink search navigates the originating ChatGPT tab instead of creating a new one', async () => {
  const w = worker();
  const first = 'https://wooten.link/search?q=Sweetie+Belle';
  assert.deepEqual(await w.search(first), { ok: true });
  assert.deepEqual(w.updates, [[17, first]]);
  assert.deepEqual(await w.search('https://wooten.link/stellar'), { ok: true });
  assert.deepEqual(w.updates[1], [17, 'https://wooten.link/stellar']);
});

test('subsequent searches each navigate the tab that submitted them', async () => {
  const w = worker();
  assert.deepEqual(await w.search('https://wooten.link/search?q=pony'), { ok: true });
  assert.deepEqual(await w.search('https://wooten.link/search?q=friendship', {
    ...sender, tab: { id: 28 },
  }), { ok: true });
  assert.deepEqual(w.updates, [
    [17, 'https://wooten.link/search?q=pony'],
    [28, 'https://wooten.link/search?q=friendship'],
  ]);
});

test('only WootenLink results from a top-level ChatGPT tab can navigate', async () => {
  const w = worker();
  for (const badSender of [
    { ...sender, url: 'https://example.org/' },
    { ...sender, frameId: 1 },
    { ...sender, tab: undefined },
  ]) {
    assert.equal((await w.search('https://wooten.link/search?q=test', badSender)).ok, false);
  }
  for (const badUrl of [
    'https://wooten.link.example.org/search?q=test',
    'http://wooten.link/search?q=test',
    'https://example.com/results?search_query=test',
    'not a url',
  ]) {
    assert.equal((await w.search(badUrl)).ok, false);
  }
  assert.deepEqual(w.updates, []);
  assert.equal(w.listener({ type: 'unrelated' }, sender, () => {}), false);
});

test('navigation failures are reported without trying a new tab', async () => {
  const w = worker({ failUpdate: true });
  assert.deepEqual(await w.search('https://wooten.link/search?q=test'), {
    ok: false, error: 'Navigation failed',
  });
  assert.deepEqual(w.updates, []);
});
