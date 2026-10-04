const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function background(enabled, nativeResult = { ok: true, repository: 'research', branch: 'main' }) {
  let listener;
  const calls = [];
  const opened = [];
  const saved = {};
  const chrome = {
    tabs: { create: async value => opened.push(value) },
    storage: {
      local: {
        get: async (defaults) => ({ ...defaults, ...(enabled === undefined ? {} : { researchPublisherEnabled: enabled }) }),
        set: async (values) => Object.assign(saved, values),
      },
    },
    runtime: {
      id: 'test-extension',
      onMessage: { addListener: (fn) => { listener = fn; } },
      sendNativeMessage: async (...args) => {
        calls.push(args);
        if (nativeResult instanceof Error) throw nativeResult;
        return nativeResult;
      },
    },
  };
  vm.runInNewContext(fs.readFileSync('js/research-publisher-background.js', 'utf8'), { chrome, URL, TextEncoder, Date, Error });
  const sender = { id: 'test-extension', url: 'https://connector-openai-deep-research.web-sandbox.oaiusercontent.com/', tab: { id: 1, url: 'https://chatgpt.com/c/example' } };
  return {
    calls,
    opened,
    saved,
    listener,
    send: (message = { type: 'publish-research-report', title: 'Report', markdown: '# Report\nFull text', app: '/ignored.app' }, from = sender) => new Promise((resolve) => {
      assert.equal(listener(message, from, resolve), true);
    }),
  };
}

test('unset and disabled preferences never contact the native host', async () => {
  for (const enabled of [undefined, false]) {
    const app = background(enabled);
    assert.equal((await app.send()).ok, false);
    assert.equal(app.calls.length, 0);
  }
});

test('enabled launch sends a fixed action without caller-supplied paths', async () => {
  const app = background(true);
  assert.equal((await app.send()).ok, true);
  assert.equal(JSON.stringify(app.calls), JSON.stringify([['org.research.publisher', { action: 'publish', title: 'Report', markdown: '# Report\nFull text', source: 'https://chatgpt.com/c/example' }]]));
});

test('successful status checks record a confirmed repository connection', async () => {
  const app = background(true);
  const result = await app.send({ type: 'research-publisher-status' });
  assert.equal(result.ok, true);
  assert.equal(app.calls[0][1].action, 'status');
  assert.equal(app.saved.researchPublisherConnection.ok, true);
  assert.equal(app.saved.researchPublisherConnection.repository, 'research');
  assert.equal(app.saved.researchPublisherConnection.branch, 'main');
});

test('foreign sender cannot launch the app', async () => {
  const app = background(true);
  assert.equal((await app.send(undefined, { id: 'other-extension' })).ok, false);
  assert.equal(app.calls.length, 0);
});

test('missing bridge records a failed connection and exposes the browser error', async () => {
  const app = background(true, new Error('Specified native messaging host not found.'));
  const result = await app.send({ type: 'research-publisher-status' });
  assert.equal(result.ok, false);
  assert.match(result.error, /Specified native messaging host not found/);
  assert.match(result.error, /Link repository/);
  assert.equal(app.saved.researchPublisherConnection.ok, false);
});

test('native publish failures remain publishing errors', async () => {
  const app = background(true, { ok: false, error: 'Push was not confirmed.' });
  const result = await app.send();
  assert.equal(result.ok, false);
  assert.match(result.error, /Push was not confirmed/);
});

test('unrelated messages are left for existing handlers', () => {
  assert.equal(background(false).listener({ type: 'load-repositories' }, {}, () => assert.fail()), false);
});

test('current MCP report origin forwards the selected category', async () => {
  const app = background(true);
  const sender = { id: 'test-extension', origin: 'https://mcp-app-abc123.web-sandbox.oaiusercontent.com', url: 'about:blank', tab: { id: 1, url: 'https://chatgpt.com/c/report' } };
  assert.equal((await app.send({ type: 'publish-research-report', title: 'Report', markdown: '# Report', category: 'Markets/Ownership' }, sender)).ok, true);
  assert.equal(app.calls[0][1].category, 'Markets/Ownership');
  assert.equal((await app.send({ type: 'publish-research-report', title: 'Report', markdown: '# Report', category: '../outside' }, sender)).ok, false);
  assert.equal(app.calls.length, 1);
});

test('report links open without a publishing connection and reject unsafe destinations', async () => {
  const app = background(false);
  assert.equal((await app.send({ type: 'open-research-link', url: 'https://example.org/source' })).ok, true);
  assert.deepEqual(app.opened.map(x => x.url), ['https://example.org/source']);
  assert.equal((await app.send({ type: 'open-research-link', url: 'javascript:alert(1)' })).ok, false);
  assert.equal((await app.send({ type: 'open-research-link', url: 'https://example.org/' }, { id: 'test-extension', url: 'https://other.example', tab: { url: 'https://chatgpt.com/' } })).ok, false);
  assert.equal(app.calls.length, 0);
});

test('settings default off, confirm on enable, and recheck on click', async () => {
  const elements = new Map();
  for (const id of ['research-publisher-enabled', 'research-publisher-controls', 'check-research-publisher', 'research-publisher-status']) {
    elements.set(id, { listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } });
  }
  const checkbox = elements.get('research-publisher-enabled');
  const controls = elements.get('research-publisher-controls');
  const launch = elements.get('check-research-publisher');
  const status = elements.get('research-publisher-status');
  const saved = {};
  let sends = 0;
  let onChange;
  const chrome = {
    storage: {
      local: { get: async (defaults) => defaults, set: async (values) => Object.assign(saved, values) },
      onChanged: { addListener(fn) { onChange = fn; } },
    },
    runtime: { sendMessage: async () => { sends++; return { ok: true, repository: 'research', branch: 'main' }; } },
  };
  vm.runInNewContext(fs.readFileSync('js/research-publisher-options.js', 'utf8'), {
    chrome, document: { getElementById: (id) => elements.get(id) },
  });
  await new Promise(setImmediate);
  assert.equal(checkbox.checked, false);
  assert.equal(controls.hidden, true);
  assert.equal(sends, 0);
  checkbox.checked = true;
  await checkbox.listeners.change();
  assert.equal(saved.researchPublisherEnabled, true);
  assert.equal(controls.hidden, false);
  assert.equal(sends, 1);
  assert.match(status.textContent, /Add to repo is available/);
  await launch.listeners.click();
  await new Promise(setImmediate);
  assert.equal(sends, 2);
  onChange({ researchPublisherEnabled: { newValue: false } }, 'local');
  assert.equal(checkbox.checked, false);
  assert.equal(controls.hidden, true);
  assert.equal(launch.disabled, true);
});

test('import launcher stays available while the enabled publisher is disconnected', () => {
  const source = fs.readFileSync('js/research-publisher.js', 'utf8');
  const boundary = source.indexOf('  chrome.storage.local.get');
  const context = { WeakSet, TextEncoder, URL };
  vm.createContext(context);
  vm.runInContext(source.slice(0, boundary) + `
    globalThis.available = (setting, connection) => {
      enabled = setting;
      return publisherAvailable();
    };
  })();`, context);
  assert.equal(context.available(false, false), false);
  assert.equal(context.available(true, false), true);
  assert.equal(context.available(false, true), false);
  assert.equal(context.available(true, true), true);
});
