const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture(fetch) {
  let listener;
  const windows = [];
  const context = vm.createContext({
    URL, TextDecoder, AbortSignal, fetch,
    chrome: {
      runtime: { id: 'extension', onMessage: { addListener(fn) { listener = fn; } } },
      windows: { create: async options => { windows.push(options); return { id: 20 }; } },
    },
  });
  vm.runInContext(fs.readFileSync(require.resolve('../js/links/website-link-preview.js'), 'utf8'), context);
  return { context, listener, windows };
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

test('manual verification opens the DOI in a popup with the normal browser session', async () => {
  const f = fixture(() => { throw new Error('Verification must navigate the site, not fetch it'); });
  const url = 'https://doi.org/10.15779/Z38D795C24';
  const result = await new Promise(resolve => f.listener({ type: 'open-website-verification', url },
    { id: 'extension', url: 'https://chatgpt.com/c/summary' }, resolve));
  assert.equal(result.ok, true);
  assert.equal(f.windows.length, 1);
  assert.equal(f.windows[0].url, url);
  assert.equal(f.windows[0].type, 'popup');
  assert.equal(f.windows[0].focused, true);
  assert.equal(f.windows[0].incognito, undefined);
});

test('verification rejects unsupported destinations and foreign callers without opening a window', async () => {
  const f = fixture(() => {});
  for (const url of ['javascript:alert(1)', 'file:///tmp/file', 'https://user:pass@example.org']) {
    const result = await new Promise(resolve => f.listener({ type: 'open-website-verification', url },
      { id: 'extension', url: 'https://chatgpt.com/c/summary' }, resolve));
    assert.equal(result.ok, false);
  }
  let result;
  assert.equal(f.listener({ type: 'open-website-verification', url: 'https://doi.org/' },
    { id: 'foreign', url: 'https://chatgpt.com/' }, value => { result = value; }), false);
  assert.equal(result.ok, false);
  assert.equal(f.windows.length, 0);
});
