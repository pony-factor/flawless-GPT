import test from 'node:test';
import assert from 'node:assert/strict';

const sha = 'a'.repeat(40);
async function harness(t, { confirmed = false, merged = true, busy = false, afterPrepare, phase = 'running' } = {}) {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const calls = [];
  let handler;
  let pausedFlag = false;
  let state = { version: 1, paused: false, repository: 'PDF-magic/opener', events: [],
    tasks: [{ id: 'opener-0059', prompt: 'Old task', status: 'running' }, { id: 'opener-0060', prompt: 'Next task', status: 'pending' }],
    workers: Array.from({ length: 10 }, (_, slot) => ({ slot: slot + 1, tabId: slot + 1, url: `https://chatgpt.com/c/thread-${slot + 1}`, taskId: slot === 0 ? 'opener-0059' : `other-${slot}`, phase: slot === 0 ? phase : 'running', reminderSent: false })),
  };
  const snapshots = state.workers.map((worker, index) => ({ url: worker.url, known: true, composerReady: true,
    active: index !== 0 || busy, queueLength: 0, submissionPending: false, latestUserAnswered: true,
    assistantComplete: true, signature: `turn-${index}`, stableSince: Date.now() - 2000, observedAt: Date.now(), draftPresent: false,
    reply: confirmed ? `MERGE_CONFIRMED opener-0059 https://github.com/PDF-magic/opener/pull/27 ${sha}` : 'PR is open.' }));
  const event = { addListener() {} };
  globalThis.chrome = {
    storage: { local: { get: async () => ({ dispatcher: structuredClone(state), dispatcherPaused: pausedFlag }), set: async value => {
      if (value.dispatcher) state = structuredClone(value.dispatcher);
      if ('dispatcherPaused' in value) pausedFlag = value.dispatcherPaused;
    } } },
    runtime: { id: 'test', getURL: path => `chrome-extension://test/${path}`, onMessage: { addListener: fn => { handler = fn; } }, onStartup: event, onInstalled: event },
    action: { onClicked: event }, alarms: { create: async () => {}, onAlarm: event },
    tabs: { onRemoved: event, get: async id => ({ id, url: snapshots[id - 1].url }),
      sendMessage: async (id, message) => {
        calls.push({ id, ...message });
        if (message.type === 'snapshot') return { ...snapshots[id - 1], observedAt: Date.now() };
        if (message.type === 'prepare') { if (afterPrepare) await afterPrepare({ setPaused: () => { state.paused = true; } }); return { ok: true }; }
        if (message.type === 'commit') { snapshots[id - 1].active = true; return { ok: true }; }
        if (message.type === 'review') return { ok: true };
      } },
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ repository: 'PDF-magic/opener', number: 27, state: 'closed', merged, mergeCommit: sha, url: 'https://github.com/PDF-magic/opener/pull/27' }) });
  t.after(() => { globalThis.chrome = originalChrome; globalThis.fetch = originalFetch; });
  const module = await import(`../extension/background.mjs?case=${crypto.randomUUID()}`);
  return { module, calls, snapshots, state: () => state, handler: () => handler };
}

test('active chats are observation-only', async t => {
  const h = await harness(t, { busy: true }); await h.module.tick();
  assert.equal(h.calls.filter(c => c.type !== 'snapshot').length, 0);
  assert.equal(h.state().tasks[1].status, 'pending');
});

test('a merge claim without GitHub merged=true cannot advance the task', async t => {
  const h = await harness(t, { confirmed: true, merged: false }); await h.module.tick();
  assert.equal(h.state().tasks[1].status, 'pending');
  const prepare = h.calls.find(c => c.type === 'prepare');
  assert.match(prepare.prompt, /Finish your existing.*opener-0059/);
  assert.equal(h.state().workers[0].reminderSent, true);
});

test('only an independently verified merge releases the next task', async t => {
  const h = await harness(t, { confirmed: true }); await h.module.tick();
  assert.equal(h.state().tasks[0].status, 'merged');
  assert.equal(h.state().tasks[1].status, 'running');
  assert.equal(h.state().workers[0].taskId, 'opener-0060');
  assert.equal(h.calls.filter(c => c.type === 'commit').length, 1);
  await h.module.tick();
  assert.equal(h.calls.filter(c => c.type === 'commit').length, 1, 'a second cycle must not duplicate the send');
});

test('pause during prepare prevents commit', async t => {
  const h = await harness(t, { confirmed: true, afterPrepare: async ({ setPaused }) => setPaused() }); await h.module.tick();
  assert.equal(h.calls.filter(c => c.type === 'commit').length, 0);
  assert.equal(h.state().paused, true);
  assert.equal(h.state().workers[0].phase, 'review');
});

test('an uncertain reservation after restart is not replayed', async t => {
  const h = await harness(t, { confirmed: true, phase: 'dispatching' }); await h.module.tick();
  assert.equal(h.calls.some(c => c.type === 'prepare' || c.type === 'commit'), false);
});

test('content scripts cannot import tasks or start the dispatcher', async t => {
  const h = await harness(t);
  let responded = false;
  h.handler()({ type: 'import', manifest: [] }, { id: 'test', tab: { id: 1 }, url: 'https://chatgpt.com/c/thread-1' }, () => { responded = true; });
  assert.equal(responded, false);
  assert.equal(h.state().tasks.length, 2);
});

test('merge follow-up is sent at most once and never advances new work itself', async t => {
  const h = await harness(t); await h.module.tick();
  h.snapshots[0].active = false;
  await h.module.tick();
  assert.equal(h.calls.filter(c => c.type === 'commit').length, 1);
  assert.equal(h.state().tasks[1].status, 'pending');
});

test('an earlier unverified task in an adopted chat also blocks advancement', async t => {
  const h = await harness(t, { confirmed: true });
  h.state().workers[0].pendingTaskIds = ['opener-0058', 'opener-0059'];
  await h.module.tick();
  assert.equal(h.state().tasks[1].status, 'pending');
  assert.match(h.calls.find(c => c.type === 'prepare').prompt, /opener-0058/);
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
  await new Promise(resolve => h.handler()({ type: 'pause' }, { id: 'test', url: 'chrome-extension://test/dashboard.html' }, resolve));
  assert.equal(h.state().tasks[0].status, 'merged');
  assert.equal((await h.module.command({ type: 'state' })).state.paused, true);
});

test('the installed full-page extension dashboard can address its worker', async t => {
  const h = await harness(t);
  const response = await new Promise(resolve => h.handler()({ type: 'state' }, { id: 'test', tab: { id: 42 }, url: 'chrome-extension://test/dashboard.html' }, resolve));
  assert.equal(response.ok, true);
  assert.equal(response.state.workers.length, 10);
});
