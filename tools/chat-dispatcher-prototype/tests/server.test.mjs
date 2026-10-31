import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../companion/server.mjs';

async function server(t) {
  const lookups = [];
  const origin = `chrome-extension://${'a'.repeat(32)}`;
  const instance = createServer({ extensionId: 'a'.repeat(32), port: 0, lookup: async (repository, number) => {
    lookups.push({ repository, number }); return { repository, number, state: 'closed', merged: true, mergeCommit: 'b'.repeat(40) };
  } });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => instance.close(resolve)));
  const url = `http://127.0.0.1:${instance.address().port}`;
  const verify = (value, from = origin) => fetch(`${url}/verify`, { method: 'POST', headers: { Origin: from, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  return { url, origin, verify, lookups };
}

test('the paired extension receives read-only merge metadata', async t => {
  const h = await server(t); const response = await h.verify({ repository: 'PDF-magic/opener', number: 27 });
  assert.equal(response.status, 200); assert.equal((await response.json()).merged, true);
  assert.deepEqual(h.lookups, [{ repository: 'PDF-magic/opener', number: 27 }]);
});

test('unpaired websites, arbitrary repositories, and command-like PR numbers are rejected', async t => {
  const h = await server(t);
  assert.equal((await h.verify({ repository: 'PDF-magic/opener', number: 27 }, 'https://chatgpt.com')).status, 403);
  assert.equal((await h.verify({ repository: 'other/repo', number: 27 })).status, 400);
  assert.equal((await h.verify({ repository: 'PDF-magic/opener', number: '27; echo unsafe' })).status, 400);
  assert.equal(h.lookups.length, 0);
});

test('preview dashboard serves locally without dispatch authority', async t => {
  const h = await server(t);
  const response = await fetch(h.url); assert.equal(response.status, 200);
  assert.match(await response.text(), /Chat Dispatcher/);
  assert.match(response.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(`${h.url}/../package.json`)).status, 404);
  const script = await fetch(`${h.url}/dashboard.js`, { headers: { Origin: h.url } });
  assert.equal(script.status, 200, 'same-origin module scripts must load in the preview');
  assert.match(await script.text(), /function render/);
});
