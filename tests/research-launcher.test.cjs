const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function app({ enabled = true, connected = true } = {}) {
  const session = {};
  const local = {};
  const tabs = new Map();
  let now = Date.now();
  let installed;
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
      local: {
        get: async defaults => typeof defaults === 'string' ? { [defaults]: structuredClone(local[defaults]) } : ({ ...defaults, researchPublisherEnabled: enabled }),
        set: async values => Object.assign(local, structuredClone(values)),
      },
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
        tabs.set(id, { id, windowId: id, url: 'https://chatgpt.com/c/research' });
        return { id, tabs: [{ id }] };
      },
      remove: async () => {},
    },
    webNavigation: { getFrame: async ({ tabId }) => ({ url: tabs.get(tabId)?.url }) },
    tabs: {
      get: async id => { if (!tabs.has(id)) throw new Error('No tab'); const { url, ...tab } = tabs.get(id); return tab; },
      reload: async id => calls.push(['reload', id]),
      update: async (id, options) => calls.push(['navigate', id, options]),
      create: async () => {},
      sendMessage: async () => ({ ready }),
      onRemoved: { addListener: fn => { removed = fn; } },
    },
    runtime: {
      id: 'extension',
      onInstalled: { addListener: fn => { installed = fn; } },
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
    const context = vm.createContext({ chrome, URL, TextEncoder, Date: { now: () => now }, crypto: { randomUUID: () => 'run-' + nextId }, console });
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
  return { session, local, tabs, calls, windows, advance: ms => { now += ms; }, update: () => installed(), send, start, source, host, report, restart: load, close: id => removed(id),
    changeDestination: value => { destination = value; }, failPublish: (value = true) => { failPublish = value; }, setReady: value => { ready = value; } };
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

test('destination changes stop imports while transient native failures wait for automatic retry', async () => {
  for (const changed of [false, true]) {
    const a = app();
    const job = await submitted(a);
    if (changed) a.changeDestination({ repository: 'other', branch: 'main' });
    else a.failPublish();
    assert.equal((await a.send(publish(job), a.report(job.tabId))).ok, false);
    assert.equal(a.session['researchLaunch:' + job.tabId].state, changed ? 'import-error' : 'import-retry');
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


test('submitted destination survives extension session loss and refuses a reused tab', async () => {
  const a = app();
  const job = await submitted(a);
  assert.equal(a.local.researchLaunchRecovery[job.tabId].category, 'Markets');
  assert.equal(a.local.researchLaunchRecovery[job.tabId].prompt, undefined);
  for (const key of Object.keys(a.session)) delete a.session[key];
  a.restart();
  assert.equal((await a.send({ type: 'research-launch-job' }, a.host(job.tabId))).job.state, 'submitted');
  assert.equal((await a.send(publish(job), a.report(job.tabId))).ok, true);
  delete a.session['researchLaunch:' + job.tabId];
  a.tabs.get(job.tabId).url = 'https://chatgpt.com/c/unrelated';
  assert.equal((await a.send({ type: 'research-launch-job' }, a.host(job.tabId))).job, null);
  assert.equal(a.local.researchLaunchRecovery[job.tabId], undefined);
});

test('extension update refreshes known research windows and preserves completed imports', async () => {
  const a = app();
  const job = await submitted(a);
  for (const key of Object.keys(a.session)) delete a.session[key];
  a.restart();
  a.update();
  await new Promise(setImmediate);
  assert.deepEqual(a.calls.filter(call => call[0] === 'reload'), [['reload', job.tabId]]);
  assert.equal((await a.send(publish(job), a.report(job.tabId))).ok, true);
  a.update();
  await new Promise(setImmediate);
  assert.equal(a.calls.filter(call => call[0] === 'reload').length, 2);
  assert.equal(a.calls.filter(call => call[1]?.action === 'publish').length, 1);
});

test('transient failure retries automatically and then records a single successful import', async () => {
  const a = app();
  const job = await submitted(a);
  a.failPublish();
  assert.equal((await a.send(publish(job), a.report(job.tabId))).ok, false);
  assert.equal((await a.send(publish(job), a.report(job.tabId))).ok, false);
  a.advance(5001);
  a.failPublish(false);
  assert.equal((await a.send(publish(job), a.report(job.tabId))).ok, true);
  assert.equal((await a.send(publish(job), a.report(job.tabId))).ok, false);
  assert.equal(a.session['researchLaunch:' + job.tabId].state, 'complete');
  assert.equal(a.calls.filter(call => call[1]?.action === 'publish').length, 2);
});

test('repeated failures stop after three attempts and interrupted workers can resume importing', async () => {
  const a = app();
  const job = await submitted(a);
  a.session['researchLaunch:' + job.tabId].state = 'importing';
  a.restart();
  assert.equal((await a.send({ type: 'research-launch-job' }, a.host(job.tabId))).job.state, 'submitted');
  a.failPublish();
  for (let i = 0; i < 3; i++) {
    assert.equal((await a.send(publish(job), a.report(job.tabId))).ok, false);
    a.advance(31000);
  }
  assert.equal(a.session['researchLaunch:' + job.tabId].state, 'import-error');
  assert.equal((await a.send(publish(job), a.report(job.tabId))).ok, false);
  assert.equal(a.calls.filter(call => call[1]?.action === 'publish').length, 3);
});
