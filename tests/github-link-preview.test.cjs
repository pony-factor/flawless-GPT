const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function fixture(fetchGitHub, tokens = []) {
  let listener;
  const context = vm.createContext({
    URL, TokenVault: { loadTokens: async () => tokens }, fetchGitHub,
    chrome: { runtime: { id: 'extension', onMessage: { addListener(fn) { listener = fn; } } } },
  });
  vm.runInContext(fs.readFileSync(require.resolve('../js/github-link-preview.js'), 'utf8'), context);
  return { context, listener };
}
test('commit preview returns display data and patches', async () => {
  const f = fixture(async (url, token) => {
    assert.equal(url, 'https://api.github.com/repos/owner/repo/commits/abcdef1');
    assert.equal(token, '');
    return { commit: { message: 'Fix preview\n\nDetails', author: { name: 'Author', date: '2026-10-05' } }, stats: { additions: 2, deletions: 1 }, files: [{ filename: 'file.js', additions: 2, deletions: 1, patch: '+change', raw_url: 'excluded' }] };
  });
  const result = await f.context.loadGitHubLinkPreview('https://github.com/owner/repo/commit/abcdef1');
  assert.equal(result.title, 'Fix preview');
  assert.equal(result.body, 'Details');
  assert.equal(result.files[0].patch, '+change');
  assert.equal(result.files[0].raw_url, undefined);
});
test('PR file failure still returns the description', async () => {
  const f = fixture(async url => {
    if (url.includes('/files?')) throw new Error('Unavailable');
    return { title: 'PR title', body: 'Description', state: 'closed', merged_at: 'today', user: { login: 'author' } };
  });
  const result = await f.context.loadGitHubLinkPreview('https://github.com/owner/repo/pull/123/files');
  assert.equal(result.title, 'PR title');
  assert.equal(result.details, 'Merged · author');
  assert.match(result.note, /diffs could not be loaded/);
});
test('private access retries with saved credentials only at the fixed API origin', async () => {
  const f = fixture(async (url, token) => {
    assert.equal(new URL(url).origin, 'https://api.github.com');
    if (!token) throw new Error('Not found');
    return { full_name: 'owner/repo', private: true, description: 'Private description', stargazers_count: 0 };
  }, [{ token: 'fixture-credential' }]);
  const result = await f.context.loadGitHubLinkPreview('https://github.com/owner/repo');
  assert.equal(result.body, 'Private description');
  assert.equal(JSON.stringify(result).includes('fixture-credential'), false);
});
test('rejects foreign origins, credentials, unsupported routes, and encoded separators', () => {
  const f = fixture();
  for (const url of ['https://github.com.evil.test/owner/repo', 'https://user@github.com/owner/repo', 'http://github.com/owner/repo', 'https://github.com/owner/repo/settings', 'https://github.com/owner%2frepo/repo']) {
    assert.throws(() => f.context.githubPreviewRoute(url));
  }
});
test('message listener rejects callers outside the ChatGPT content script', () => {
  const f = fixture();
  let response;
  const accepted = f.listener({ type: 'load-github-link-preview', url: 'https://github.com/owner/repo' }, { id: 'extension', url: 'https://evil.test/' }, value => { response = value; });
  assert.equal(accepted, false);
  assert.equal(response.ok, false);
});
