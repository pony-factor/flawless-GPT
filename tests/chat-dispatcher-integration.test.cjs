const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');

test('dispatcher is registered after the existing GitHub and composer infrastructure', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.ok(manifest.permissions.includes('alarms'));
  assert.ok(manifest.permissions.includes('scripting'));
  const scripts = manifest.content_scripts.find(entry => entry.js?.includes('js/composer/message-queue.js')).js;
  assert.ok(scripts.indexOf('js/composer/chat-dispatcher.js') > scripts.indexOf('js/composer/message-queue.js'));
  const background = fs.readFileSync(path.join(root, 'js/core/background.js'), 'utf8');
  assert.ok(background.indexOf('../dispatcher/background.js') > background.indexOf('../core/service-worker.js'));
});

test('settings entry points preserve a single dispatcher link in each existing page', () => {
  for (const page of ['popup.html', 'options.html']) {
    const source = fs.readFileSync(path.join(root, page), 'utf8');
    assert.equal([...source.matchAll(/id="open-chat-dispatcher"/g)].length, 1);
    assert.match(source, /href="chat-dispatcher\.html"/);
  }
});

test('dashboard supplies all controls and uses namespaced storage and messages', () => {
  const script = fs.readFileSync(path.join(root, 'js/dispatcher/dashboard.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'chat-dispatcher.html'), 'utf8');
  const ids = [...script.matchAll(/\$\('([^']+)'\)/g)].map(match => match[1]);
  for (const id of new Set(ids)) assert.equal([...html.matchAll(new RegExp(`id="${id}"`, 'g'))].length, 1, id);
  assert.match(script, /ghrc-chat-dispatcher:/);
  assert.match(script, /chatDispatcherState/);
  assert.doesNotMatch(script, /127\.0\.0\.1|extension-id|setup-command/);
});

test('integrated worker uses existing GitHub access and has no companion dependency', () => {
  const script = fs.readFileSync(path.join(root, 'js/dispatcher/background.js'), 'utf8');
  assert.match(script, /TokenVault\.loadTokens/);
  assert.match(script, /fetchGitHub\(/);
  assert.doesNotMatch(script, /VERIFIER|127\.0\.0\.1|localhost/);
  const adapter = fs.readFileSync(path.join(root, 'js/composer/chat-dispatcher.js'), 'utf8');
  assert.match(adapter, /getDispatcherLifecycle/);
  assert.doesNotMatch(adapter, /\.enqueueText\(|\.sendClipboardText\(|\.stop\.click\(/);
});

test('dispatcher dashboard exposes independent session navigation', () => {
  const script = fs.readFileSync(path.join(root, 'js/dispatcher/dashboard.js'), 'utf8');
  const page = fs.readFileSync(path.join(root, 'chat-dispatcher.html'), 'utf8');
  assert.match(script, /sessionId/);
  assert.match(script, /history\.replaceState/);
  assert.match(script, /type: 'sessions'/);
  assert.match(page, /id="session-name"/);
  assert.match(page, /id="session-list"/);
  assert.match(page, /Open another dispatcher/);
});


test('unconnected dashboard preview cannot dispatch tasks', () => {
  const { JSDOM } = require('jsdom');
  const html = fs.readFileSync(path.join(root, 'chat-dispatcher.html'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'js/dispatcher/dashboard.js'), 'utf8');
  const dom = new JSDOM(html, { url: 'https://example.test/chat-dispatcher.html', runScripts: 'outside-only' });
  try {
    Object.defineProperty(dom.window.crypto, 'randomUUID', {
      configurable: true, value: () => '33333333-3333-4333-8333-333333333333',
    });
    dom.window.eval(script);
    const notice = dom.window.document.getElementById('notice');
    assert.match(notice.textContent, /Open the dispatcher from Flawless/);
    assert.equal(dom.window.document.getElementById('start').disabled, true);
    assert.equal(dom.window.document.getElementById('pause').disabled, true);
    assert.equal(dom.window.document.getElementById('active-count').textContent, '0 / 10');
    assert.doesNotMatch(script, /127\.0\.0\.1|localhost|companion\/server/);
  } finally {
    dom.window.close();
  }
});

test('all 27 archived Studio cases have active Flawless test counterparts', () => {
  const historical = ['core', 'background', 'content', 'server'].flatMap(group => {
    const source = fs.readFileSync(path.join(root, 'tools/chat-dispatcher-prototype/tests', group + '.test.mjs'), 'utf8');
    return [...source.matchAll(/\btest\(\s*['"\x60]([^'"\x60]+)['"\x60]/g)].map(match => match[1]);
  });
  const active = new Set(['core', 'background', 'content', 'integration'].flatMap(group => {
    const source = fs.readFileSync(path.join(root, 'tests', 'chat-dispatcher-' + group + '.test.cjs'), 'utf8');
    return [...source.matchAll(/\btest\(\s*['"\x60]([^'"\x60]+)['"\x60]/g)].map(match => match[1]);
  }));
  const replacements = new Map([
    ['the paired extension receives read-only merge metadata',
      'integrated GitHub connection reads only scoped merge metadata'],
    ['unpaired websites, arbitrary repositories, and command-like PR numbers are rejected',
      'unpaired pages and invalid GitHub inputs cannot control dispatch'],
    ['preview dashboard serves locally without dispatch authority',
      'unconnected dashboard preview cannot dispatch tasks'],
  ]);
  assert.equal(historical.length, 27, 'review the migration when archived test cases change');
  for (const name of historical) {
    assert.ok(active.has(replacements.get(name) || name), 'Studio case has no active counterpart: ' + name);
  }
});
