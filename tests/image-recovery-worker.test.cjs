const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../js/image-recovery-worker.js'), 'utf8');
function fixture(fetch) {
  const sandbox = { URL, URLSearchParams, AbortController, setTimeout, clearTimeout, TextDecoder, Uint8Array, fetch, chrome: { runtime: { id: 'fixture', onMessage: { addListener(fn) { sandbox.listener = fn; } } } } };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox;
}
test('public source fetch omits authentication and rejects private redirects', async () => {
  const requests = [];
  const s = fixture(async (url, options) => { requests.push({ url, options }); return new Response('', { status: 302, headers: { location: 'https://127.0.0.1/private' } }); });
  await assert.rejects(s.loadImageRecoverySource('https://catalog.example/'), /Unsupported/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.credentials, 'omit');
  assert.equal(requests[0].options.redirect, 'manual');
  for (const url of ['http://catalog.example/', 'https://localhost/', 'https://192.168.1.1/', 'https://host.local/', 'https://user:password@catalog.example/']) assert.throws(() => s.imageRecoveryPublicUrl(url));
});
test('source fetch accepts HTML and rejects non-HTML and oversized responses', async () => {
  const good = fixture(async () => new Response('<img src="photo.png">', { headers: { 'content-type': 'text/html' } }));
  assert.equal((await good.loadImageRecoverySource('https://catalog.example/')).html, '<img src="photo.png">');
  const binary = fixture(async () => new Response('image', { headers: { 'content-type': 'image/png' } }));
  await assert.rejects(binary.loadImageRecoverySource('https://catalog.example/'), /unavailable/);
  const huge = fixture(async () => new Response('a'.repeat(2_000_001), { headers: { 'content-type': 'text/html' } }));
  await assert.rejects(huge.loadImageRecoverySource('https://catalog.example/'), /too large/);
  assert.equal(good.listener({ type: 'recover-image-source', url: 'https://catalog.example/' }, { id: 'fixture', url: 'https://unrelated.example/' }, () => {}), false);
});

test('recover the same cited Fandom article through its anonymous public API', async () => {
  const requests = [];
  const s = fixture(async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ parse: { text: { '*': '<img alt="End Zone" src="pony.png">' } } }), { headers: { 'content-type': 'application/json' } });
  });
  const result = await s.loadImageRecoverySource('https://mlp.fandom.com/wiki/List_of_ponies/Earth_ponies');
  assert.equal(result.url, 'https://mlp.fandom.com/wiki/List_of_ponies/Earth_ponies');
  assert.match(result.html, /End Zone/);
  assert.equal(requests.length, 1);
  const api = new URL(requests[0].url);
  assert.equal(api.pathname, '/api.php');
  assert.equal(api.searchParams.get('page'), 'List_of_ponies/Earth_ponies');
  assert.equal(requests[0].options.credentials, 'omit');
  assert.equal(requests[0].options.redirect, 'error');
});
