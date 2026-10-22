const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function fixture({ supported = true, source = {}, partner = null, fail = false, windows = [{ id: 1, focused: true }] } = {}) {
  const calls = [];
  let listener;
  const navigation = {};
  const session = {};
  const context = vm.createContext({ URL, Map, Promise, chrome: {
    windows: {
      getAll: async () => windows,
      update: async (id, props) => { calls.push(['focus', id, props]); },
      create: async props => { calls.push(['window', props]); },
    },
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
  vm.runInContext(fs.readFileSync(require.resolve('../js/links/native-split-view.js'), 'utf8'), context);
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
test('places the website before the chat when the left-side setting is enabled', async () => {
  const f = fixture();
  assert.equal((await f.context.openNativeSplit('https://docs.github.com/en', 10, true)).ok, true);
  assert.deepEqual(f.calls.find(call => call[0] === 'split'), ['split', [20, 10]]);
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
test('successive websites and GitHub documentation reuse the owned pane without changing its placement', async () => {
  const f = fixture({ source: { splitViewId: 8 }, partner: { id: 20, splitViewId: 8 } });
  f.session['nativeSplitPane:10'] = 20;
  for (const url of ['https://www.random.org/', 'https://en.wikipedia.org/wiki/Special:Random', 'https://docs.github.com/en']) {
    const result = await f.context.openNativeSplit(url, 10);
    assert.equal(result.ok, true);
  }
  assert.deepEqual(f.calls.map(call => call.slice(0, 2)), [['update', 20], ['update', 20], ['update', 20]]);
});
test('split failure keeps the already opened tab without requesting a duplicate sidebar', async () => {
  const f = fixture({ fail: true });
  const result = await f.context.openNativeSplit('https://github.com/owner/repo', 10);
  assert.equal(result.ok, true);
  assert.equal(result.fallbackTab, true);
  assert.equal(f.calls.at(-1)[0], 'update');
});

test('blocked preview opens a regular tab only for the active watch, including popup sources', async () => {
  const f = fixture({ source: { windowId: 3 } });
  const url = 'https://doi.org/10.15779/Z38D795C24';
  f.session['linkPreviewWatch:10'] = { url, id: 'current' };
  const send = previewId => new Promise(resolve => f.listener({ type: 'open-blocked-link-preview', url, previewId },
    { id: 'extension', url: 'https://chatgpt.com/c/summary', tab: { id: 10 } }, resolve));
  assert.equal((await send('stale')).ok, false);
  assert.equal(f.calls.length, 0);
  assert.equal((await send('current')).ok, true);
  assert.equal(f.calls[0][0], 'create');
  assert.equal(f.calls[0][1].url, url);
  assert.equal(f.calls[0][1].windowId, 1);
  assert.equal(f.calls[0][1].active, true);
  assert.equal(f.calls[1][0], 'focus');
});

test('blocked preview creates a browser window only if no normal window exists', async () => {
  const f = fixture({ windows: [] });
  const url = 'https://example.org/';
  f.session['linkPreviewWatch:10'] = { url, id: 'current' };
  const result = await new Promise(resolve => f.listener({ type: 'open-blocked-link-preview', url, previewId: 'current' },
    { id: 'extension', url: 'https://chatgpt.com/c/summary', tab: { id: 10 } }, resolve));
  assert.equal(result.ok, true);
  assert.equal(f.calls[0][0], 'window');
  assert.equal(f.calls[0][1].type, 'normal');
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

test('a blocked link clicked inside the sidebar opens its destination instead of the original page', async () => {
  const f = fixture();
  const url = 'https://example.org/article';
  const destination = 'https://doi.org/10.15779/Z38D795C24';
  f.session['linkPreviewWatch:10'] = { url, id: 'preview' };
  f.navigation.before({ tabId: 10, frameId: 3, url });
  await new Promise(resolve => setImmediate(resolve));
  f.navigation.error({ tabId: 10, frameId: 3, url: destination, error: 'net::ERR_BLOCKED_BY_RESPONSE' });
  await new Promise(resolve => setImmediate(resolve));
  const notification = f.calls.find(call => call[0] === 'message')[2];
  assert.equal(notification.url, url);
  assert.equal(notification.destinationUrl, destination);
  const result = await new Promise(resolve => f.listener({ type: 'open-blocked-link-preview', url, previewId: 'preview' },
    { id: 'extension', url: 'https://chatgpt.com/c/summary', tab: { id: 10 } }, resolve));
  assert.equal(result.ok, true);
  assert.equal(f.calls.find(call => call[0] === 'create')[1].url, destination);
});
