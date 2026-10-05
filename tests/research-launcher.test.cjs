const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function app({ enabled = true, connected = true } = {}) {
  const session = {};
  const calls = [];
  const windows = [];
  let nextId = 10;
  let listeners = [];
  let removed;
  let destination = { repository: 'research', branch: 'main' };
  let failPublish = false;
  let ready = true;
  const chrome = {
    storage: {
      local: { get: async defaults => ({ ...defaults, researchPublisherEnabled: enabled }), set: async () => {} },
      session: {
        get: async key => ({ [key]: session[key] && structuredClone(session[key]) }),
        set: async values => Object.assign(session, structuredClone(values)),
        remove: async key => { delete session[key]; },
      },
    },
    windows: {
      create: async options => {
        const id = nextId++;
        windows.push(options);
        return { id, tabs: [{ id }] };
      },
      remove: async () => {},
    },
    tabs: {
      update: async (id, options) => calls.push(['navigate', id, options]),
      create: async () => {},
      sendMessage: async () => ({ ready }),
      onRemoved: { addListener: fn => { removed = fn; } },
    },
    runtime: {
      id: 'extension',
      onMessage: { addListener: fn => listeners.push(fn) },
      sendNativeMessage: async (host, payload) => {
        calls.push([host, payload]);
        if (!connected) throw new Error('Missing native bridge');
        if (payload.action === 'publish' && failPublish) return { ok: false, error: 'Push failed' };
        return { ok: true, ...destination, categories: ['Markets'], path: 'Markets/report.md' };
      },
    },
  };
  const load = () => {
    listeners = [];
    const context = vm.createContext({ chrome, URL, TextEncoder, Date, crypto: { randomUUID: () => 'run-' + nextId }, console });
    for (const file of ['js/research-publisher-background.js', 'js/research-launcher-background.js'])
      vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  };
  load();
  const source = { id: 'extension', frameId: 0, url: 'https://chatgpt.com/c/source', tab: { id: 1, url: 'https://chatgpt.com/c/source' } };
  const host = id => ({ ...source, url: 'https://chatgpt.com/', tab: { id, url: 'https://chatgpt.com/c/research' } });
  const report = id => ({ id: 'extension', frameId: 2, origin: 'https://mcp-app-abc123.web-sandbox.oaiusercontent.com',
    url: 'about:blank', tab: { id, url: 'https://chatgpt.com/c/research' } });
  const send = (message, sender = source) => new Promise((resolve, reject) => {
    if (!listeners.some(listener => listener(message, sender, resolve) === true)) reject(new Error('No handler'));
  });
  const start = () => send({ type: 'start-research-launch', prompt: '# Investigate\nExact wording', title: 'Investigation', category: 'Markets', repository: 'research', branch: 'main' });
  return { session, calls, windows, send, start, source, host, report, restart: load, close: id => removed(id),
    changeDestination: value => { destination = value; }, failPublish: () => { failPublish = true; }, setReady: value => { ready = value; } };
}
async function submitted(a) {
  const { job } = await a.start();
  const sender = a.host(job.tabId);
  await a.send({ type: 'claim-research-launch', id: job.id }, sender);
  await a.send({ type: 'research-launch-sending', id: job.id }, sender);
  await a.send({ type: 'research-launch-submitted', id: job.id }, sender);
  return job;
}
function publish(job) {
  return { type: 'publish-research-report', title: 'Finished report', markdown: '# Finished report\nEvidence', automationJobId: job.id, category: 'Ignored' };
}

test('launcher checks the connection before opening a small window and retains the exact prompt', async () => {
  const a = app();
  const { job } = await a.start();
  assert.equal(a.windows[0].type, 'popup');
  assert.equal(a.windows[0].width, 560);
  assert.equal(a.windows[0].height, 760);
  assert.equal(a.windows[0].url, 'about:blank');
  assert.equal(a.session['researchLaunch:' + job.tabId].prompt, '# Investigate\nExact wording');
  assert.equal(a.calls.find(x => x[0] === 'navigate')[2].url, 'https://chatgpt.com/');
});

test('disabled, disconnected, invalid-category and foreign launches do not open windows', async () => {
  for (const options of [{ enabled: false }, { connected: false }]) {
    const a = app(options);
    assert.equal((await a.start()).ok, false);
    assert.equal(a.windows.length, 0);
  }
  const a = app();
  assert.equal((await a.send({ type: 'start-research-launch', prompt: 'Topic', title: 'Title', category: '../outside' })).ok, false);
  assert.equal((await a.send({ type: 'start-research-launch', prompt: 'Topic', title: 'Title', category: '' }, { ...a.source, id: 'foreign' })).ok, false);
  assert.equal(a.windows.length, 0);
});

test('only the new top-level tab can claim a prompt and it is claimed once across worker restart', async () => {
  const a = app();
  const { job } = await a.start();
  assert.equal((await a.send({ type: 'claim-research-launch', id: job.id })).ok, false);
  assert.equal((await a.send({ type: 'claim-research-launch', id: job.id }, { ...a.host(job.tabId), frameId: 1 })).ok, false);
  const claims = await Promise.all([a.send({ type: 'claim-research-launch', id: job.id }, a.host(job.tabId)),
    a.send({ type: 'claim-research-launch', id: job.id }, a.host(job.tabId))]);
  assert.equal(claims.filter(result => result.job?.prompt).length, 1);
  a.restart();
  assert.equal((await a.send({ type: 'claim-research-launch', id: job.id }, a.host(job.tabId))).job.prompt, undefined);
});

test('changing the selected repository before launch requires choosing it again', async () => {
  const a = app();
  a.changeDestination({ repository: 'other', branch: 'main' });
  assert.equal((await a.start()).ok, false);
  assert.equal(a.windows.length, 0);
});

test('submission acknowledgements survive navigation and cannot submit twice', async () => {
  const a = app();
  const job = await submitted(a);
  assert.equal(a.session['researchLaunch:' + job.tabId].prompt, undefined);
  assert.equal((await a.send({ type: 'research-launch-sending', id: job.id }, a.host(job.tabId))).ok, false);
  a.restart();
  assert.equal((await a.send({ type: 'research-launch-job' }, a.host(job.tabId))).job.state, 'submitted');
});

test('completed report imports to the category chosen at launch exactly once', async () => {
  const a = app();
  const job = await submitted(a);
  a.restart();
  assert.equal((await a.send(publish(job), a.report(job.tabId))).ok, true);
  const payload = a.calls.filter(x => x[1]?.action === 'publish');
  assert.equal(payload.length, 1);
  assert.equal(payload[0][1].category, 'Markets');
  assert.equal(payload[0][1].source, 'https://chatgpt.com/c/research');
  assert.equal((await a.send(publish(job), a.report(job.tabId))).ok, false);
  assert.equal(a.calls.filter(x => x[1]?.action === 'publish').length, 1);
  assert.equal((await a.send({ type: 'research-launch-status', tabId: job.tabId, id: job.id })).job.state, 'complete');
});

test('active research and an unrelated report tab cannot trigger import', async () => {
  const a = app();
  const job = await submitted(a);
  a.setReady(false);
  assert.equal((await a.send(publish(job), a.report(job.tabId))).ok, false);
  assert.equal(a.session['researchLaunch:' + job.tabId].state, 'submitted');
  a.setReady(true);
  assert.equal((await a.send(publish(job), a.report(999))).ok, false);
  assert.equal(a.calls.filter(x => x[1]?.action === 'publish').length, 0);
});

test('destination changes and native failures require a deliberate manual retry', async () => {
  for (const changed of [false, true]) {
    const a = app();
    const job = await submitted(a);
    if (changed) a.changeDestination({ repository: 'other', branch: 'main' });
    else a.failPublish();
    assert.equal((await a.send(publish(job), a.report(job.tabId))).ok, false);
    assert.equal(a.session['researchLaunch:' + job.tabId].state, 'import-error');
    assert.equal((await a.send(publish(job), a.report(job.tabId))).ok, false);
    assert.equal(a.calls.filter(x => x[1]?.action === 'publish').length, changed ? 0 : 1);
  }
});

test('closing the popup clears its handoff and reports the closure only to its source tab', async () => {
  const a = app();
  const { job } = await a.start();
  assert.equal((await a.send({ type: 'research-launch-status', id: job.id, tabId: job.tabId }, a.host(999))).job, null);
  a.close(job.tabId);
  assert.equal((await a.send({ type: 'research-launch-status', id: job.id, tabId: job.tabId })).job, null);
});
