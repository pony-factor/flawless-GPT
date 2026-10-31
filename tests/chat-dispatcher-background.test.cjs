const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');

const sha = 'a'.repeat(40);
async function harness(t, { confirmed = false, merged = true, busy = false, afterPrepare, phase = 'running' } = {}) {
  const sandbox = { Date, URL, AbortSignal, structuredClone, console, crypto: webcrypto, __GHRC_DISPATCHER_TEST__: {} };
  const calls = [];
  let handler;
  let pausedFlag = false;
  const sessionStorage = {};
  let state = { version: 1, paused: false, repository: 'PDF-magic/opener', events: [],
    tasks: [{ id: 'opener-0059', prompt: 'Old task', status: 'running' }, { id: 'opener-0060', prompt: 'Next task', status: 'pending' }],
    workers: Array.from({ length: 10 }, (_, slot) => ({ slot: slot + 1, tabId: slot + 1, url: `https://chatgpt.com/c/thread-${slot + 1}`, taskId: slot === 0 ? 'opener-0059' : `other-${slot}`, phase: slot === 0 ? phase : 'running', reminderSent: false })),
  };
  const snapshots = state.workers.map((worker, index) => ({ url: worker.url, known: true, composerReady: true,
    active: index !== 0 || busy, queueLength: 0, submissionPending: false, latestUserAnswered: true,
    assistantComplete: true, signature: `turn-${index}`, stableSince: Date.now() - 2000, observedAt: Date.now(), draftPresent: false,
    reply: confirmed ? `MERGE_CONFIRMED opener-0059 https://github.com/PDF-magic/opener/pull/27 ${sha}` : 'PR is open.' }));
  const event = { addListener() {} };
  sandbox.chrome = {
    storage: { local: { get: async keys => {
      const values = { ...sessionStorage, chatDispatcherState: structuredClone(state), chatDispatcherPaused: pausedFlag };
      return Object.fromEntries(keys.map(key => [key, values[key]]));
    }, set: async values => {
      if (values.chatDispatcherState) state = structuredClone(values.chatDispatcherState);
      if ('chatDispatcherPaused' in values) pausedFlag = values.chatDispatcherPaused;
      for (const [key, value] of Object.entries(values)) {
        if (!['chatDispatcherState', 'chatDispatcherPaused'].includes(key)) sessionStorage[key] = structuredClone(value);
      }
    } } },
    runtime: { id: 'test', getURL: path => `chrome-extension://test/${path}`, onMessage: { addListener: fn => { handler = fn; } }, onStartup: event, onInstalled: event },
    scripting: { executeScript: async () => {} },
    action: { onClicked: event }, alarms: { create: async () => {}, onAlarm: event },
    tabs: { onRemoved: event, get: async id => ({ id, url: snapshots[id - 1].url }),
      sendMessage: async (id, message) => {
        calls.push({ id, ...message });
        if (message.type === 'ghrc-chat-dispatcher:snapshot') return { ...snapshots[id - 1], observedAt: Date.now() };
        if (message.type === 'ghrc-chat-dispatcher:prepare') { if (afterPrepare) await afterPrepare({ setPaused: () => { state.paused = true; } }); return { ok: true }; }
        if (message.type === 'ghrc-chat-dispatcher:commit') { snapshots[id - 1].active = true; return { ok: true }; }
        if (message.type === 'ghrc-chat-dispatcher:review') return { ok: true };
      } },
  };
  sandbox.TokenVault = { loadTokens: async () => [{ token: 'fixture-only' }] };
  sandbox.fetchGitHub = async () => ({ number: 27, state: 'closed', merged, merge_commit_sha: sha,
    html_url: 'https://github.com/PDF-magic/opener/pull/27', base: { repo: { full_name: 'PDF-magic/opener' } } });
  vm.createContext(sandbox);
  for (const file of ['../js/dispatcher/core.js', '../js/dispatcher/background.js'])
    vm.runInContext(readFileSync(path.join(__dirname, file), 'utf8'), sandbox);
  return { module: sandbox.__GHRC_DISPATCHER_TEST__, calls, snapshots, state: () => state, handler: () => handler,
    sessionStorage, sandbox };

}

test('active chats are observation-only', async t => {
  const h = await harness(t, { busy: true }); await h.module.tick();
  assert.equal(h.calls.filter(c => c.type !== 'ghrc-chat-dispatcher:snapshot').length, 0);
  assert.equal(h.state().tasks[1].status, 'pending');
});

test('a merge claim without GitHub merged=true cannot advance the task', async t => {
  const h = await harness(t, { confirmed: true, merged: false }); await h.module.tick();
  assert.equal(h.state().tasks[1].status, 'pending');
  const prepare = h.calls.find(c => c.type === 'ghrc-chat-dispatcher:prepare');
  assert.match(prepare.prompt, /Finish your existing.*opener-0059/);
  assert.equal(h.state().workers[0].reminderSent, true);
});

test('only an independently verified merge releases the next task', async t => {
  const h = await harness(t, { confirmed: true }); await h.module.tick();
  assert.equal(h.state().tasks[0].status, 'merged');
  assert.equal(h.state().tasks[1].status, 'running');
  assert.equal(h.state().workers[0].taskId, 'opener-0060');
  assert.equal(h.calls.filter(c => c.type === 'ghrc-chat-dispatcher:commit').length, 1);
  await h.module.tick();
  assert.equal(h.calls.filter(c => c.type === 'ghrc-chat-dispatcher:commit').length, 1, 'a second cycle must not duplicate the send');
});

test('pause during prepare prevents commit', async t => {
  const h = await harness(t, { confirmed: true, afterPrepare: async ({ setPaused }) => setPaused() }); await h.module.tick();
  assert.equal(h.calls.filter(c => c.type === 'ghrc-chat-dispatcher:commit').length, 0);
  assert.equal(h.state().paused, true);
  assert.equal(h.state().workers[0].phase, 'review');
});

test('an uncertain reservation after restart is not replayed', async t => {
  const h = await harness(t, { confirmed: true, phase: 'dispatching' }); await h.module.tick();
  assert.equal(h.calls.some(c => c.type === 'ghrc-chat-dispatcher:prepare' || c.type === 'ghrc-chat-dispatcher:commit'), false);
});

test('content scripts cannot import tasks or start the dispatcher', async t => {
  const h = await harness(t);
  let responded = false;
  h.handler()({ type: 'ghrc-chat-dispatcher:import', manifest: [] }, { id: 'test', tab: { id: 1 }, url: 'https://chatgpt.com/c/thread-1' }, () => { responded = true; });
  assert.equal(responded, false);
  assert.equal(h.state().tasks.length, 2);
});

test('merge follow-up is sent at most once and never advances new work itself', async t => {
  const h = await harness(t); await h.module.tick();
  h.snapshots[0].active = false;
  await h.module.tick();
  assert.equal(h.calls.filter(c => c.type === 'ghrc-chat-dispatcher:commit').length, 1);
  assert.equal(h.state().tasks[1].status, 'pending');
});

test('an earlier unverified task in an adopted chat also blocks advancement', async t => {
  const h = await harness(t, { confirmed: true });
  h.state().workers[0].pendingTaskIds = ['opener-0058', 'opener-0059'];
  await h.module.tick();
  assert.equal(h.state().tasks[1].status, 'pending');
  assert.match(h.calls.find(c => c.type === 'ghrc-chat-dispatcher:prepare').prompt, /opener-0058/);
  assert.deepEqual(h.state().workers[0].verifiedTaskIds, ['opener-0059']);
});

test('reviewing an unsent merge follow-up does not requeue its existing task', async t => {
  const h = await harness(t);
  h.state().paused = true;
  h.state().workers[0].phase = 'review';
  h.state().workers[0].reservation = { nonce: 'review-me', taskId: 'opener-0059', kind: 'follow-up', previousPhase: 'awaiting-merge' };
  await h.module.command({ type: 'review', slot: 1, decision: 'not-sent' });
  assert.equal(h.state().tasks[0].status, 'running');
  assert.equal(h.state().workers[0].phase, 'awaiting-merge');
});

test('immediate Pause changes only its separate gate and preserves task progress', async t => {
  const h = await harness(t);
  h.state().tasks[0].status = 'merged';
  await new Promise(resolve => h.handler()({ type: 'ghrc-chat-dispatcher:pause' }, { id: 'test', url: 'chrome-extension://test/chat-dispatcher.html' }, resolve));
  assert.equal(h.state().tasks[0].status, 'merged');
  assert.equal((await h.module.command({ type: 'state' })).state.paused, true);
});

test('the installed full-page extension dashboard can address its worker', async t => {
  const h = await harness(t);
  const response = await new Promise(resolve => h.handler()({ type: 'ghrc-chat-dispatcher:state' }, { id: 'test', tab: { id: 42 }, url: 'chrome-extension://test/chat-dispatcher.html' }, resolve));
  assert.equal(response.ok, true);
  assert.equal(response.state.workers.length, 10);
});

test('GitHub failure blocks advancement and never changes credentials', async t => {
  const h = await harness(t, { confirmed: true });
  h.sandbox.fetchGitHub = async () => { throw Error('Unavailable'); };
  await h.module.tick();
  assert.equal(h.state().tasks[1].status, 'pending');
  assert.equal(h.calls.some(c => c.type === 'ghrc-chat-dispatcher:prepare'), false);
  assert.match(h.state().workers[0].error, /GitHub verification failed/);
});

test('publishing preference can only change while paused', async t => {
  const h = await harness(t);
  await assert.rejects(h.module.command({ type: 'preferences', preferCodexPony: true }), /Pause/);
  h.state().paused = true;
  await h.module.command({ type: 'preferences', preferCodexPony: true });
  assert.equal(h.state().preferCodexPony, true);
});


test('first Start creates ten fresh tabs, and resume reuses them', async t => {
  const h = await harness(t);
  const state = h.state(); state.paused = true; state.workers = [];
  await h.sandbox.chrome.storage.local.set({ chatDispatcherState: state });
  const created = [];
  h.sandbox.chrome.tabs.create = async options => { created.push(options); return { id: 100 + created.length }; };
  await h.module.command({ type: 'start' });
  assert.equal(created.length, 10);
  assert.ok(created.every(tab => tab.url === 'https://chatgpt.com/' && tab.active === false));
  assert.ok(h.state().workers.every(worker => worker.fresh && worker.phase === 'ready'));
  await h.module.command({ type: 'start' });
  assert.equal(created.length, 10);
});

test('a fresh send waits for its unique assistant receipt without replaying', async t => {
  const h = await harness(t);
  const state = h.state();
  Object.assign(state.workers[0], { fresh: true, taskId: null, phase: 'ready', url: 'https://chatgpt.com/' });
  await h.sandbox.chrome.storage.local.set({ chatDispatcherState: state });
  Object.assign(h.snapshots[0], { url: 'https://chatgpt.com/', fresh: true });
  const send = h.sandbox.chrome.tabs.sendMessage;
  h.sandbox.chrome.tabs.sendMessage = async (id, message) => {
    const result = await send(id, message);
    return message.type === 'ghrc-chat-dispatcher:commit' ? { ok: true, pendingIdentity: true } : result;
  };
  await h.module.tick();
  assert.equal(h.state().workers[0].phase, 'identifying');
  const nonce = h.state().workers[0].dispatchNonce;
  Object.assign(h.snapshots[0], { url: 'https://chatgpt.com/c/fresh-thread', fresh: false, confirmationText: 'Unrelated reply' });
  await h.module.tick();
  assert.equal(h.state().workers[0].phase, 'identifying');
  h.snapshots[0].confirmationText = `DISPATCH_RECEIVED ${nonce}`;
  await h.module.tick();
  assert.equal(h.state().workers[0].phase, 'running');
  assert.equal(h.state().workers[0].url, 'https://chatgpt.com/c/fresh-thread');
  assert.equal(h.calls.filter(c => c.type === 'ghrc-chat-dispatcher:commit').length, 1);
});

test('uncertain submission recovers only through exact independently verified merge proof', async t => {
  const h = await harness(t, { confirmed: true, phase: 'review' });
  const state = h.state();
  state.workers[0].reservation = { kind: 'task', taskId: 'opener-0059', nonce: 'old-send' };
  state.workers[0].error = 'Uncertain send';
  await h.sandbox.chrome.storage.local.set({ chatDispatcherState: state });
  await h.module.tick();
  assert.equal(h.state().tasks[0].status, 'merged');
  assert.equal(h.state().workers[0].taskId, 'opener-0060');
  assert.equal(h.calls.filter(c => c.type === 'ghrc-chat-dispatcher:prepare').length, 1);
  assert.match(h.calls.find(c => c.type === 'ghrc-chat-dispatcher:prepare').prompt, /Task: opener-0060/);
});

test('a missing content listener reconnects without reloading or sending a prompt', async t => {
  const h = await harness(t, { busy: true });
  const send = h.sandbox.chrome.tabs.sendMessage;
  let first = true; let injections = 0;
  h.sandbox.chrome.scripting.executeScript = async () => { injections++; };
  h.sandbox.chrome.tabs.sendMessage = async (id, message) => {
    if (first) { first = false; throw Error('Receiving end does not exist'); }
    return send(id, message);
  };
  await h.module.tick();
  assert.equal(injections, 1);
  assert.equal(h.calls.filter(c => c.type !== 'ghrc-chat-dispatcher:snapshot').length, 0);
  assert.equal(h.state().workers[0].error, '');
});

test('temporary tab URLs bind through the authoritative main frame and unique receipt', async t => {
  const h = await harness(t, { busy: true });
  const state = h.state();
  Object.assign(state.workers[0], { phase: 'identifying', fresh: true, dispatchNonce: 'frame-receipt' });
  await h.sandbox.chrome.storage.local.set({ chatDispatcherState: state });
  h.snapshots[0].confirmationText = 'DISPATCH_RECEIVED frame-receipt';
  const get = h.sandbox.chrome.tabs.get;
  h.sandbox.chrome.tabs.get = async id => id === 1 ? { id, url: 'https://chatgpt.com/c/local-chatgpt%3Atemporary-thread' } : get(id);
  h.sandbox.chrome.webNavigation = { getFrame: async () => ({ url: h.snapshots[0].url }) };
  await h.module.tick();
  assert.equal(h.state().workers[0].phase, 'running');
  assert.equal(h.state().workers[0].url, h.snapshots[0].url);
  assert.equal(h.calls.some(c => c.type === 'ghrc-chat-dispatcher:commit'), false);
});

test('the third GitHub-verified job closes only the idle old chat and opens a fresh one', async t => {
  const h = await harness(t, { confirmed: true });
  const original = h.state().workers[0].url;
  h.state().tasks.unshift(
    { id: 'prior-1', status: 'merged', chatUrl: original },
    { id: 'prior-2', status: 'merged', chatUrl: original },
  );
  const created = [], removed = [];
  h.sandbox.chrome.tabs.create = async options => { created.push(options); return { id: 101, url: options.url }; };
  h.sandbox.chrome.tabs.remove = async id => { removed.push(id); };
  const get = h.sandbox.chrome.tabs.get;
  h.sandbox.chrome.tabs.get = async id => id === 101 ? { id, url: 'https://chatgpt.com/' } : get(id);
  await h.module.tick();
  assert.equal(h.state().tasks.find(task => task.id === 'opener-0059').status, 'merged');
  assert.equal(h.state().tasks.find(task => task.id === 'opener-0060').status, 'pending');
  assert.equal(created.length, 1);
  assert.equal(created[0].url, 'https://chatgpt.com/');
  assert.equal(created[0].active, false);
  assert.deepEqual(removed, [1]);
  assert.equal(h.state().workers[0].tabId, 101);
  assert.equal(h.state().workers[0].url, 'https://chatgpt.com/');
  assert.equal(h.state().workers[0].taskId, null);
  assert.equal(h.state().workers[0].fresh, true);
  assert.equal(h.state().workers[0].phase, 'ready');
  assert.equal(h.calls.filter(c => c.type === 'ghrc-chat-dispatcher:commit').length, 0);
  assert.equal(h.state().tasks[0].chatUrl, original, 'completed task history stays attached to its old conversation');
});

test('fewer than three merged jobs do not rotate a chat', async t => {
  const h = await harness(t, { confirmed: true });
  h.state().tasks.unshift({ id: 'prior-1', status: 'merged', chatUrl: h.state().workers[0].url });
  let created = 0, removed = 0;
  h.sandbox.chrome.tabs.create = async () => { created++; };
  h.sandbox.chrome.tabs.remove = async () => { removed++; };
  await h.module.tick();
  assert.equal(created, 0);
  assert.equal(removed, 0);
  assert.equal(h.state().tasks.find(task => task.id === 'opener-0060').status, 'running');
});

test('interrupted rotation reuses the reserved new chat and never resends a job', async t => {
  const h = await harness(t, { confirmed: true });
  const original = h.state().workers[0].url;
  h.state().tasks.unshift(
    { id: 'prior-1', status: 'merged', chatUrl: original },
    { id: 'prior-2', status: 'merged', chatUrl: original },
  );
  let creations = 0, attempts = 0;
  h.sandbox.chrome.tabs.create = async () => { creations++; return { id: 101 }; };
  const get = h.sandbox.chrome.tabs.get;
  h.sandbox.chrome.tabs.get = async id => id === 101 ? { id, url: 'https://chatgpt.com/' } : get(id);
  h.sandbox.chrome.tabs.remove = async () => { if (++attempts === 1) throw Error('Closing the tab failed'); };
  await h.module.tick();
  assert.equal(h.state().workers[0].phase, 'rotating');
  assert.equal(h.state().workers[0].tabId, 1);
  assert.equal(h.state().workers[0].rotation.newTabId, 101);
  assert.equal(h.state().tasks.find(task => task.id === 'opener-0060').status, 'pending');
  await h.module.tick();
  assert.equal(creations, 1);
  assert.equal(attempts, 2);
  assert.equal(h.state().workers[0].phase, 'ready');
  assert.equal(h.state().workers[0].tabId, 101);
  assert.equal(h.calls.filter(c => c.type === 'ghrc-chat-dispatcher:commit').length, 0);
});

test('busy or drafted chats are not closed during rotation', async t => {
  const h = await harness(t, { confirmed: true });
  const original = h.state().workers[0].url;
  h.state().tasks.unshift(
    { id: 'prior-1', status: 'merged', chatUrl: original },
    { id: 'prior-2', status: 'merged', chatUrl: original },
  );
  h.snapshots[0].draftPresent = true;
  let created = 0, closed = 0;
  h.sandbox.chrome.tabs.create = async () => { created++; return { id: 101 }; };
  h.sandbox.chrome.tabs.remove = async () => { closed++; };
  await h.module.tick();
  assert.equal(created, 0);
  assert.equal(closed, 0);
  assert.equal(h.state().tasks.find(task => task.id === 'opener-0060').status, 'pending');
  h.snapshots[0].draftPresent = false;
  const get = h.sandbox.chrome.tabs.get;
  h.sandbox.chrome.tabs.get = async id => id === 101 ? { id, url: 'https://chatgpt.com/' } : get(id);
  const send = h.sandbox.chrome.tabs.sendMessage;
  h.sandbox.chrome.tabs.sendMessage = async (id, msg) => {
    if (id === 1 && msg.type === 'ghrc-chat-dispatcher:snapshot' && created) h.snapshots[0].active = true;
    return send(id, msg);
  };
  await h.module.tick();
  assert.equal(created, 1);
  assert.equal(closed, 0);
  assert.equal(h.state().workers[0].phase, 'rotating');
});

const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';

test('independent dispatchers retain separate task manifests and preferences', async t => {
  const h = await harness(t);
  await h.module.command({ type: 'import', repository: 'PDF-magic/opener',
    manifest: [{ id: 'one', prompt: 'First manifest' }] }, SESSION_A);
  await h.module.command({ type: 'import', repository: 'pony-factor/flawless-GPT',
    manifest: [{ id: 'two', prompt: 'Second manifest' }] }, SESSION_B);
  await h.module.command({ type: 'preferences', preferCodexPony: true }, SESSION_A);
  const a = (await h.module.command({ type: 'state' }, SESSION_A)).state;
  const b = (await h.module.command({ type: 'state' }, SESSION_B)).state;
  assert.equal(a.id, SESSION_A);
  assert.equal(b.id, SESSION_B);
  assert.equal(a.repository, 'PDF-magic/opener');
  assert.equal(b.repository, 'pony-factor/flawless-GPT');
  assert.deepEqual(a.tasks.map(t => t.id), ['one']);
  assert.deepEqual(b.tasks.map(t => t.id), ['two']);
  assert.equal(a.preferCodexPony, true);
  assert.equal(Boolean(b.preferCodexPony), false);
  assert.equal(h.state().tasks[0].id, 'opener-0059', 'legacy progress remains intact');
  const sessions = await h.module.listSessions();
  assert.deepEqual(Array.from(sessions, s => s.id), ['legacy', SESSION_A, SESSION_B]);
});

test('two dispatchers can start their own ten-chat pools without cross-session changes', async t => {
  const h = await harness(t);
  for (const [id, name] of [[SESSION_A, 'one'], [SESSION_B, 'two']]) {
    await h.module.command({ type: 'import', repository: 'PDF-magic/opener',
      manifest: [{ id: name, prompt: 'Independent task' }] }, id);
  }
  let nextTab = 100;
  h.sandbox.chrome.tabs.create = async options => ({ id: ++nextTab, url: options.url });
  await h.module.command({ type: 'start' }, SESSION_A);
  await h.module.command({ type: 'start' }, SESSION_B);
  const first = (await h.module.command({ type: 'state' }, SESSION_A)).state;
  const second = (await h.module.command({ type: 'state' }, SESSION_B)).state;
  assert.equal(first.workers.length, 10);
  assert.equal(second.workers.length, 10);
  assert.equal(new Set([...first.workers.map(w => w.tabId), ...second.workers.map(w => w.tabId)]).size, 20);
  assert.equal(first.tasks[0].id, 'one');
  assert.equal(second.tasks[0].id, 'two');
  assert.equal(h.state().workers[0].tabId, 1, 'legacy pool must be unchanged');
});

test('pausing a dashboard leaves the other dispatcher running', async t => {
  const h = await harness(t);
  for (const id of [SESSION_A, SESSION_B]) {
    await h.module.command({ type: 'import', repository: 'PDF-magic/opener',
      manifest: [{ id: 'job', prompt: 'Run me' }] }, id);
  }
  h.sessionStorage['chatDispatcherState:' + SESSION_A].paused = false;
  h.sessionStorage['chatDispatcherState:' + SESSION_B].paused = false;
  let pauseResponse;
  h.handler()({ type: 'ghrc-chat-dispatcher:pause', sessionId: SESSION_A },
    { id: 'test', url: 'chrome-extension://test/chat-dispatcher.html?session=' + SESSION_A },
    value => { pauseResponse = value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pauseResponse.ok, true);
  assert.equal((await h.module.command({ type: 'state' }, SESSION_A)).state.paused, true);
  assert.equal((await h.module.command({ type: 'state' }, SESSION_B)).state.paused, false);
  assert.equal(h.sessionStorage['chatDispatcherPaused:' + SESSION_B], undefined);
});

test('a dashboard cannot impersonate another dispatcher session', async t => {
  const h = await harness(t);
  let reply;
  h.handler()({ type: 'ghrc-chat-dispatcher:pause', sessionId: SESSION_B },
    { id: 'test', url: 'chrome-extension://test/chat-dispatcher.html?session=' + SESSION_A },
    value => { reply = value; });
  assert.match(reply.error, /does not match/);
  assert.equal(h.sessionStorage['chatDispatcherPaused:' + SESSION_B], undefined);
});

test('binding rejects chats already managed by another dispatcher', async t => {
  const h = await harness(t);
  await h.module.command({ type: 'state' }, SESSION_A);
  await assert.rejects(h.module.command({ type: 'bind', tabIds: Array.from({ length: 10 }, (_, i) => i + 1) }, SESSION_A),
    /already owned by another dispatcher/);
  assert.equal((await h.module.command({ type: 'state' }, SESSION_A)).state.workers.length, 0);
});

test('session IDs reject unexpected values', async t => {
  const h = await harness(t);
  await assert.rejects(h.module.command({ type: 'state' }, '../other'), /Invalid dispatcher session/);
});


test('integrated GitHub connection reads only scoped merge metadata', async t => {
  const h = await harness(t, { confirmed: true });
  const reads = [];
  h.sandbox.fetchGitHub = async (url, token) => {
    reads.push({ url, token });
    return { number: 27, state: 'closed', merged: true, merge_commit_sha: sha,
      html_url: 'https://github.com/PDF-magic/opener/pull/27',
      base: { repo: { full_name: 'PDF-magic/opener' } } };
  };
  await h.module.tick();
  assert.deepEqual(reads, [{
    url: 'https://api.github.com/repos/PDF-magic/opener/pulls/27',
    token: 'fixture-only',
  }], 'merge verification should only read the selected PR through Flawless GitHub access');
  assert.equal(h.state().tasks[0].status, 'merged');
  assert.equal(h.state().tasks[1].status, 'running');
});

test('unpaired pages and invalid GitHub inputs cannot control dispatch', async t => {
  const h = await harness(t, { confirmed: true });
  const message = { type: 'ghrc-chat-dispatcher:import', repository: 'other/repo',
    manifest: [{ id: 'injected', prompt: 'Unauthorized task' }] };
  for (const sender of [
    { id: 'test', tab: { id: 1 }, url: 'https://chatgpt.com/c/thread-1' },
    { id: 'test', url: 'https://untrusted.example/chat-dispatcher.html' },
    { id: 'unrelated', url: 'chrome-extension://unrelated/chat-dispatcher.html' },
  ]) {
    let responded = false;
    h.handler()(message, sender, () => { responded = true; });
    assert.equal(responded, false, 'an unpaired sender must not receive dispatcher authority');
  }
  assert.equal(h.state().tasks.length, 2);

  h.sandbox.fetchGitHub = async () => ({ number: 27, state: 'closed', merged: true,
    merge_commit_sha: sha, html_url: 'https://github.com/other/repo/pull/27',
    base: { repo: { full_name: 'other/repo' } } });
  await h.module.tick();
  assert.equal(h.state().tasks[1].status, 'pending', 'a PR from another repository cannot release a slot');

  // Validate repository inputs in a separate, paused session with no assigned workers.
  // An active pool rejects all imports before reaching repository validation.
  await assert.rejects(h.module.command({ type: 'import',
    repository: 'PDF-magic/opener; echo unsafe', manifest: [{ id: 'new', prompt: 'No' }] }, SESSION_A),
  /Enter owner\/repository/);
  const forged = 'MERGE_CONFIRMED opener-0059 https://github.com/PDF-magic/opener/pull/27;echo ' + sha;
  assert.equal(h.sandbox.__ghrcDispatcherCore.parseConfirmations(
    forged, 'PDF-magic/opener', 'opener-0059').length, 0);
});
