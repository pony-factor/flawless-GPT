const { test } = require('node:test');
const assert = require('node:assert/strict');
const { missingAnswer, answerForTurn, entryFor, shouldCoolDown, savedAnswers, retryDelay } = require('../js/chat/missing-response-recovery.js');

test('server Retry-After supports seconds and dates with a safe minimum cooldown', () => {
  const now = Date.parse('2026-10-27T12:00:00Z');
  assert.equal(retryDelay('300', now), 300_000);
  assert.equal(retryDelay('Tue, 27 Oct 2026 12:10:00 GMT', now), 600_000);
  for (const header of [null, '', 'nonsense', '-1', '0']) assert.equal(retryDelay(header, now), 60_000);
});

const prefix = () => ({ errorMessage: null, turn: { status: 'complete', items: [
  { type: 'user-message' },
  { type: 'chatgpt-reasoning-group', completed: true, items: [] },
] } });
const user = (id, parent) => ({ id, parent, message: { author: { role: 'user' } } });
const answer = (id, parent, text = 'Saved reply') => ({ id, parent, message: {
  id, author: { role: 'assistant' }, channel: 'final', status: 'finished_successfully',
  content: { content_type: 'text', parts: [text] },
} });

test('cached recovery keeps only selected missing finals and drops large tool and attachment data', () => {
  const nodes = [user('u1', null), answer('a1', 'u1'), user('u2', 'a1'), answer('a2', 'u2'), answer('sibling', 'u1')];
  nodes[1].message.metadata = { toolResults: 'x'.repeat(1_000_000) };
  nodes[1].message.content.parts.push({ attachment: 'large binary data' });
  const payload = { current_node: 'a2', mapping: Object.fromEntries(nodes.map(n => [n.id, n])) };
  const cache = savedAnswers(payload, ['u1', 'unknown']);
  assert.deepEqual([...cache], [['u1', { id: 'a1', content: { parts: ['Saved reply'] } }]]);
  nodes[1].message.content.parts[0] = 'Changed native payload';
  assert.equal(cache.get('u1').content.parts[0], 'Saved reply');
  assert.ok(JSON.stringify([...cache]).length < 150);
});

test('only the observed completed prefix-only state is a candidate', () => {
  assert.equal(missingAnswer(prefix()), true);
  const withSteps = prefix();
  withSteps.turn.items[1].items = Array.from({ length: 4 }, () => ({ type: 'reasoning', completed: true }));
  assert.equal(missingAnswer(withSteps), true);
  for (const mutate of [
    e => { e.turn.status = 'in_progress'; },
    e => { e.errorMessage = 'Cancelled'; },
    e => { e.turn.items.push({ type: 'assistant-message' }); },
    e => { e.turn.items.push({ type: 'image-generation' }); },
    e => { e.turn.items[1].items.push({ type: 'reasoning' }); },
    e => { e.turn.items[1].items.push({ type: 'reasoning', completed: false }); },
    e => { e.turn.items[1].items.push({ type: 'assistant-message', completed: false }); },
    e => { e.turn.items[1].items.push({ type: 'future-renderer', completed: true }); },
    e => { e.turn.items[1].completed = false; },
    e => { e.turn.items.pop(); },
  ]) {
    const entry = prefix(); mutate(entry);
    assert.equal(missingAnswer(entry), false);
  }
});

test('completed tool reasoning without a top-level answer is recoverable', () => {
  const entry = prefix();
  entry.turn.items[1].items = [
    { type: 'assistant-message', completed: true },
    { type: 'mcp-tool-call', completed: false },
    { type: 'reasoning', completed: true },
  ];
  assert.equal(missingAnswer(entry), true);
  entry.turn.items.push({ type: 'assistant-message', completed: true });
  assert.equal(missingAnswer(entry), false);
});

test('finds an earlier missing answer on the selected branch after later replies', () => {
  const nodes = [user('u1', null), answer('a1', 'u1'), user('u2', 'a1'), answer('a2', 'u2')];
  const payload = { current_node: 'a2', mapping: Object.fromEntries(nodes.map(n => [n.id, n])) };
  assert.equal(answerForTurn(payload, 'u1'), 'a1');
  assert.equal(answerForTurn(payload, 'u2'), 'a2');
});

test('never borrows a later answer or an unselected regeneration', () => {
  const nodes = [user('u1', null), user('u2', 'u1'), answer('a2', 'u2'), answer('sibling', 'u1')];
  const payload = { current_node: 'a2', mapping: Object.fromEntries(nodes.map(n => [n.id, n])) };
  assert.equal(answerForTurn(payload, 'u1'), null);
  assert.equal(answerForTurn(payload, 'unknown'), null);
});

test('requires successfully saved nonempty final text; malformed ancestry terminates', () => {
  for (const mutate of [
    n => { n.message.channel = 'analysis'; },
    n => { n.message.status = 'in_progress'; },
    n => { n.message.content.parts = ['']; },
    n => { n.parent = n.id; },
  ]) {
    const n = answer('a', 'u'); mutate(n);
    assert.equal(answerForTurn({ current_node: 'a', mapping: { u: user('u'), a: n } }, 'u'), null);
  }
  assert.equal(answerForTurn(null, 'u'), null);
});

test('reads the current React tree rather than stale host-fiber props', () => {
  const oldEntry = prefix();
  const currentEntry = prefix(); currentEntry.turn.items.push({ type: 'assistant-message' });
  const current = { memoizedProps: { entry: currentEntry } };
  const old = { memoizedProps: { entry: oldEntry }, alternate: current };
  const root = { stateNode: { current: {} } }; old.return = root;
  assert.equal(entryFor({ '__reactFiber$fixture': old }), currentEntry);
  assert.equal(entryFor({}), null);
});

test('missing-response polling cools down only after fifteen minutes without prompting', () => {
  const now = 1_000_000;
  const elapsed = 15 * 60_000;
  assert.equal(shouldCoolDown(now, now), false);
  assert.equal(shouldCoolDown(now, now + elapsed - 1), false);
  assert.equal(shouldCoolDown(now, now + elapsed), true);
  assert.equal(shouldCoolDown(now, now + elapsed + 100_000), true);
  // A new composer interaction establishes a fresh 15-minute active window.
  const resumedAt = now + elapsed + 100_000;
  assert.equal(shouldCoolDown(resumedAt, resumedAt + elapsed - 1), false);
  assert.equal(shouldCoolDown(resumedAt, resumedAt + elapsed), true);
});

test('recovery timers stay asleep on the homepage and restart only for prompt activity', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const path = require('node:path');
  const events = new Map();
  const intervals = new Map();
  let nextInterval = 0;
  let now = 1_000;
  class FakeElement {
    closest(selector) { return selector.includes('#prompt-textarea') ? this : null; }
  }
  const location = { pathname: '/' };
  const window = { addEventListener: (name, listener) => events.set('window:' + name, listener) };
  const document = {
    addEventListener: (name, listener) => events.set('document:' + name, listener),
    querySelectorAll: () => [],
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../js/chat/missing-response-recovery.js'), 'utf8'),
    {
      module: undefined, window, document, location, Element: FakeElement,
      Date: { now: () => now },
      setInterval: (callback, ms) => {
        assert.equal(ms, 2_000);
        const id = ++nextInterval;
        intervals.set(id, callback);
        return id;
      },
      clearInterval: id => intervals.delete(id),
    },
  );
  const input = () => events.get('document:input')({
    isTrusted: true, target: new FakeElement(),
  });
  const route = pathname => {
    location.pathname = pathname;
    events.get('window:ghrc:route-change')();
  };
  assert.equal(intervals.size, 0, 'a new-chat homepage has no idle recovery timer');
  input();
  assert.equal(intervals.size, 1, 'typing a new prompt wakes the scanner');
  route('/c/another');
  assert.equal(intervals.size, 0, 'navigation without a submitted prompt suspends recovery');

  route('/');
  input();
  events.get('document:click')({
    isTrusted: true, type: 'click',
    target: { closest: selector => selector.startsWith('button')
      ? { closest: () => ({}) } : null },
  });
  route('/c/created');
  assert.equal(intervals.size, 1, 'submitted new-chat prompts keep polling across URL creation');

  now += 15 * 60_000;
  for (const callback of [...intervals.values()]) callback();
  assert.equal(intervals.size, 0, 'fifteen minutes without prompting cancels the recurring timer');
  input();
  assert.equal(intervals.size, 1, 'typing again wakes an idle conversation');
  route('/c/unrelated');
  assert.equal(intervals.size, 0, 'navigating to another conversation immediately stops checks');
  events.get('window:pagehide')();
  assert.equal(intervals.size, 0);
});
