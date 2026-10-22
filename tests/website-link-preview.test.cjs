const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture(fetch) {
  let listener;
  const context = vm.createContext({
    URL, TextDecoder, AbortSignal, fetch,
    chrome: { runtime: { id: 'extension', onMessage: { addListener(fn) { listener = fn; } } } },
  });
  vm.runInContext(fs.readFileSync(require.resolve('../js/links/website-link-preview.js'), 'utf8'), context);
  return { context, listener };
}

test('fetches public archive HTML without cookies or referrer', async () => {
  const url = 'https://oac.cdlib.org/findaid/ark:/13030/tf8t1nb3tc';
  const f = fixture(async (href, options) => {
    assert.equal(href, url);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.ok(options.signal);
    return new Response('<main>School of Law Papers</main>', { headers: { 'content-type': 'text/html' } });
  });
  assert.equal((await f.context.loadWebsiteLinkPreview(url)).html, '<main>School of Law Papers</main>');
});

test('rejects unsupported URLs, downloads, HTTP errors, and oversized pages', async () => {
  const f = fixture(async () => { throw new Error('Should not fetch'); });
  for (const url of ['file:///tmp/file', 'javascript:alert(1)', 'https://user:pass@example.org']) {
    await assert.rejects(f.context.loadWebsiteLinkPreview(url), /Unsupported/);
  }
  for (const [response, pattern] of [
    [new Response('PDF', { headers: { 'content-type': 'application/pdf' } }), /no text preview/],
    [new Response('', { status: 403 }), /HTTP 403/],
    [new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'text/html' } }), /too large/],
  ]) {
    await assert.rejects(fixture(async () => response).context.loadWebsiteLinkPreview('https://example.org'), pattern);
  }
});

test('only ChatGPT callers from this extension can request a preview', () => {
  const f = fixture(() => { throw new Error('Should not fetch'); });
  for (const sender of [{ id: 'foreign', url: 'https://chatgpt.com/' }, { id: 'extension', url: 'https://evil.test/' }]) {
    let response;
    assert.equal(f.listener({ type: 'load-website-link-preview', url: 'https://example.org' }, sender, value => { response = value; }), false);
    assert.equal(response.ok, false);
  }
});
