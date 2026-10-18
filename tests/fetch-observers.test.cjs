const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(fetch) {
  const messages = [];
  const attributes = new Map();
  const window = { fetch, addEventListener() {}, postMessage: data => messages.push(data) };
  const context = vm.createContext({
    window, Request, URL, AbortSignal,
    location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/c/test' },
    document: { documentElement: {
      setAttribute: (key, value) => attributes.set(key, value),
      removeAttribute: key => attributes.delete(key),
    } },
  });
  for (const name of ['sidebar/sidebar-chat-dates-main.js', 'research/deep-research-usage.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js', name), 'utf8'), context);
  }
  return { window, messages, attributes };
}

test('blocked unrelated fetch retains the native promise, rejection, arguments and receiver', async () => {
  const failure = new TypeError('Failed to fetch');
  const result = Promise.reject(failure);
  let observations = 0;
  const originalThen = result.then;
  result.then = function (...args) { observations++; return originalThen.apply(this, args); };
  const input = 'http://127.0.0.1:18765/missing-response-recovery.js';
  const options = { cache: 'no-store' };
  const receiver = {};
  let calls = 0;
  const f = fixture(function (...args) {
    calls++;
    assert.equal(this, receiver);
    assert.deepEqual(args, [input, options]);
    return result;
  });
  assert.equal(f.window.fetch.call(receiver, input, options), result);
  assert.equal(calls, 1);
  assert.equal(observations, 0);
  await assert.rejects(result, error => error === failure);
});

test('arbitrary fetch inputs are coerced only by native fetch', async () => {
  let coercions = 0;
  const input = { toString() { coercions++; return 'https://chatgpt.com/backend-api/conversations'; } };
  const response = Response.json({ items: [] });
  const result = Promise.resolve(response);
  const f = fixture(value => { String(value); return result; });
  assert.equal(f.window.fetch(input), result);
  assert.equal(await result, response);
  assert.equal(coercions, 1);
});

test('native synchronous failures propagate unchanged', () => {
  const failure = new Error('native failure');
  const f = fixture(() => { throw failure; });
  assert.throws(() => f.window.fetch('/unrelated'), error => error === failure);
});

test('date and quota observation preserve native responses and publish their metadata', async () => {
  for (const [input, payload] of [
    ['/backend-api/conversations', { items: [{ id: 'test', create_time: 123 }] }],
    [new URL('https://chatgpt.com/backend-api/conversation/init'), {
      limits_progress: [{ feature_name: 'deep_research', remaining: 7 }],
    }],
  ]) {
    const response = Response.json(payload);
    const result = Promise.resolve(response);
    const f = fixture(() => result);
    assert.equal(f.window.fetch(input), result);
    await new Promise(resolve => setImmediate(resolve));
    if (typeof input === 'string') {
      assert.equal(f.messages[0]?.items[0]?.createTime, 123);
    } else {
      assert.equal(JSON.parse(f.attributes.get('data-ghrc-deep-research-usage')).remaining, 7);
    }
    assert.equal(response.bodyUsed, false);
    assert.deepEqual(await response.json(), payload);
  }
});

test('optional metadata failures leave the native response usable', async () => {
  const response = new Response('not JSON');
  const result = Promise.resolve(response);
  const f = fixture(() => result);
  assert.equal(f.window.fetch('/backend-api/conversations'), result);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await response.text(), 'not JSON');
  assert.equal(f.messages.length, 0);
});
