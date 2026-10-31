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
  assert.match(html, /id="replace-existing-drafts"/);
  assert.match(script, /replaceExistingDrafts/);
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

test('all 27 Studio scenarios remain covered after removing the obsolete prototype', () => {
  const inventory = JSON.parse(fs.readFileSync(
    path.join(root, 'tests/fixtures/chat-dispatcher-studio-coverage.json'), 'utf8'));
  assert.equal(inventory.length, 27, 'preserve the 27 original Studio scenarios');
  assert.equal(new Set(inventory.map(item => item.legacy)).size, 27, 'legacy cases must be unique');
  assert.equal(new Set(inventory.map(item => item.active)).size, 27, 'each case needs a distinct active counterpart');

  const activeSuites = new Map(['core', 'background', 'content', 'integration'].map(group => {
    const source = fs.readFileSync(path.join(root, 'tests', 'chat-dispatcher-' + group + '.test.cjs'), 'utf8');
    return [group, new Set([...source.matchAll(/\btest\(\s*['"\x60]([^'"\x60]+)['"\x60]/g)]
      .map(match => match[1]))];
  }));
  for (const item of inventory) {
    assert.ok(activeSuites.get(item.activeSuite)?.has(item.active),
      'Missing active test for former Studio case: ' + item.legacy);
  }
  assert.equal(fs.existsSync(path.join(root, 'tools/chat-dispatcher-prototype')), false,
    'the unused standalone Studio runtime must not be restored');
});

test('the preserved PDF Opener manifest is importable without a Studio runtime', () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(root, 'tools/task-manifests/opener-tasks.json'), 'utf8'));
  assert.equal(manifest.repository, 'PDF-magic/opener');
  assert.ok(Array.isArray(manifest.tasks) && manifest.tasks.length > 0);
  assert.ok(manifest.tasks.every(item => typeof item.task_id === 'string' && typeof item.prompt === 'string'));
});
