const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function fixture({ supported = true, source = {}, partner = null, fail = false } = {}) {
  const calls = [];
  let listener;
  const context = vm.createContext({ URL, Map, Promise, chrome: {
    runtime: { id: 'extension', onMessage: { addListener(fn) { listener = fn; } } },
    tabs: {
      get: async id => ({ id, windowId: 1, index: 2, pinned: false, groupId: -1, splitViewId: -1, ...source }),
      query: async () => partner ? [partner] : [],
      create: async props => { calls.push(['create', props]); return { id: 20 }; },
      createSplit: supported ? async ids => { calls.push(['split', Array.from(ids)]); if (fail) throw new Error('Unavailable'); } : undefined,
      update: async (id, props) => { calls.push(['update', id, props]); },
      group: async props => { calls.push(['group', props]); },
    },
  } });
  vm.runInContext(fs.readFileSync(require.resolve('../js/github-split-view.js'), 'utf8'), context);
  return { context, calls, listener };
}
test('creates adjacent grouped tabs and splits them before activating GitHub', async () => {
  const f = fixture({ source: { groupId: 7 } });
  assert.equal((await f.context.openGitHubNativeSplit('https://github.com/owner/repo', 10)).ok, true);
  assert.equal(f.calls[0][0], 'create');
  assert.equal(f.calls[0][1].index, 3);
  assert.equal(f.calls[0][1].active, false);
  assert.equal(f.calls[1][0], 'group');
  assert.deepEqual(f.calls[2], ['split', [10, 20]]);
  assert.equal(f.calls[3][0], 'update');
});
test('unsupported browsers do not create an ordinary tab disguised as a split', async () => {
  const f = fixture({ supported: false });
  assert.equal((await f.context.openGitHubNativeSplit('https://github.com/owner/repo', 10)).unavailable, true);
  assert.equal(f.calls.length, 0);
});
test('reuses the GitHub half of an existing split', async () => {
  const f = fixture({ source: { splitViewId: 8 }, partner: { id: 20, splitViewId: 8, url: 'https://github.com/owner/repo' } });
  assert.equal((await f.context.openGitHubNativeSplit('https://github.com/owner/repo/pull/42', 10)).ok, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], 'update');
  assert.equal(f.calls[0][2].url, 'https://github.com/owner/repo/pull/42');
});
test('preserves an unrelated website in an existing split', async () => {
  const f = fixture({ source: { splitViewId: 8 }, partner: { id: 20, splitViewId: 8, url: 'https://example.org/' } });
  assert.equal((await f.context.openGitHubNativeSplit('https://github.com/owner/repo', 10)).unavailable, true);
  assert.equal(f.calls.length, 0);
});
test('split failure keeps the full page available and reports the fallback honestly', async () => {
  const f = fixture({ fail: true });
  assert.equal((await f.context.openGitHubNativeSplit('https://github.com/owner/repo', 10)).ok, false);
  assert.equal(f.calls.at(-1)[0], 'update');
});
test('rejects foreign origins and callers outside ChatGPT', () => {
  const f = fixture();
  for (const url of ['https://github.com.evil.test/repo', 'http://github.com/repo', 'https://user@github.com/repo']) assert.throws(() => f.context.githubSplitURL(url));
  let response;
  assert.equal(f.listener({ type: 'open-github-split-view' }, { id: 'extension', url: 'https://evil.test/', tab: { id: 10 } }, value => { response = value; }), false);
  assert.equal(response.ok, false);
});
