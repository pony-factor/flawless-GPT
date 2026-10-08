const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function fixture({ supported = true, source = {}, partner = null, fail = false } = {}) {
  const calls = [];
  let listener;
  const navigation = {};
  const session = {};
  const context = vm.createContext({ URL, Map, Promise, chrome: {
    storage: { session: { get: async key => ({ [key]: session[key] }), set: async values => Object.assign(session, values), remove: async key => { delete session[key]; } } },
    webNavigation: { onBeforeNavigate: { addListener(fn) { navigation.before = fn; } }, onErrorOccurred: { addListener(fn) { navigation.error = fn; } } },
    runtime: { id: 'extension', onMessage: { addListener(fn) { listener = fn; } } },
    tabs: {
      get: async id => ({ id, windowId: 1, index: 2, pinned: false, groupId: -1, splitViewId: -1, ...source }),
      query: async () => partner ? [partner] : [],
      create: async props => { calls.push(['create', props]); return { id: 20 }; },
      createSplit: supported ? async ids => { calls.push(['split', Array.from(ids)]); if (fail) throw new Error('Unavailable'); } : undefined,
      update: async (id, props) => { calls.push(['update', id, props]); },
      sendMessage: async (id, message) => { calls.push(["message", id, message]); },
      group: async props => { calls.push(['group', props]); },
    },
  } });
  vm.runInContext(fs.readFileSync(require.resolve('../js/native-split-view.js'), 'utf8'), context);
  return { context, calls, listener, navigation, session };
}
test('creates adjacent grouped tabs and splits them before activating GitHub', async () => {
  const f = fixture({ source: { groupId: 7 } });
  assert.equal((await f.context.openNativeSplit('https://github.com/owner/repo', 10)).ok, true);
  assert.equal(f.calls[0][0], 'create');
  assert.equal(f.calls[0][1].index, 3);
  assert.equal(f.calls[0][1].active, false);
  assert.equal(f.calls[1][0], 'group');
  assert.deepEqual(f.calls[2], ['split', [10, 20]]);
  assert.equal(f.calls[3][0], 'update');
});
test('unsupported browsers do not create an ordinary tab disguised as a split', async () => {
  const f = fixture({ supported: false });
  assert.equal((await f.context.openNativeSplit('https://github.com/owner/repo', 10)).unavailable, true);
  assert.equal(f.calls.length, 0);
});
test('reuses the GitHub half of an existing split', async () => {
  const f = fixture({ source: { splitViewId: 8 }, partner: { id: 20, splitViewId: 8, url: 'https://github.com/owner/repo' } });
  f.session['nativeSplitPane:10'] = 20;
  assert.equal((await f.context.openNativeSplit('https://github.com/owner/repo/pull/42', 10)).ok, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], 'update');
  assert.equal(f.calls[0][2].url, 'https://github.com/owner/repo/pull/42');
});
test('preserves an unrelated website in an existing split', async () => {
  const f = fixture({ source: { splitViewId: 8 }, partner: { id: 20, splitViewId: 8, url: 'https://example.org/' } });
  assert.equal((await f.context.openNativeSplit('https://github.com/owner/repo', 10)).unavailable, true);
  assert.equal(f.calls.length, 0);
});
test('split failure keeps the full page available and reports the fallback honestly', async () => {
  const f = fixture({ fail: true });
  assert.equal((await f.context.openNativeSplit('https://github.com/owner/repo', 10)).ok, false);
  assert.equal(f.calls.at(-1)[0], 'update');
});
test('rejects foreign origins and callers outside ChatGPT', () => {
  const f = fixture();
  for (const url of ['javascript:alert(1)', 'file:///tmp/test', 'https://user@github.com/repo']) assert.throws(() => f.context.nativeSplitURL(url));
  let response;
  assert.equal(f.listener({ type: 'open-native-split-view' }, { id: 'extension', url: 'https://evil.test/', tab: { id: 10 } }, value => { response = value; }), false);
  assert.equal(response.ok, false);
});

test('blocked preview navigation forwards only the active matching frame, including redirects', async () => {
  const f = fixture();
  f.session['linkPreviewWatch:10'] = { url: 'https://example.org/article', id: 'preview' };
  f.navigation.before({ tabId: 10, frameId: 3, parentFrameId: 2, url: 'https://example.org/article' });
  await new Promise(resolve => setImmediate(resolve));
  f.navigation.error({ tabId: 10, frameId: 4, url: 'https://unrelated.test', error: 'net::ERR_BLOCKED_BY_RESPONSE' });
  f.navigation.error({ tabId: 10, frameId: 0, url: 'https://example.org/article', error: 'net::ERR_BLOCKED_BY_RESPONSE' });
  f.navigation.error({ tabId: 10, frameId: 3, url: 'https://example.org/article', error: 'net::ERR_ABORTED' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 0);
  f.navigation.error({ tabId: 10, frameId: 3, url: 'https://redirect.test', error: 'net::ERR_BLOCKED_BY_RESPONSE' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][2].previewId, 'preview');
});
test('stale close requests cannot unregister the current preview', async () => {
  const f = fixture();
  f.session['linkPreviewWatch:10'] = { url: 'https://example.org', id: 'current' };
  await new Promise(resolve => f.listener({ type: 'unwatch-link-preview', previewId: 'old' }, { id: 'extension', url: 'https://chatgpt.com/c/chat', tab: { id: 10 } }, resolve));
  assert.equal(f.session['linkPreviewWatch:10'].id, 'current');
});
