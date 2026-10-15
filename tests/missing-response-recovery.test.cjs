const { test } = require('node:test');
const assert = require('node:assert/strict');
const { missingAnswer, answerForTurn, entryFor } = require('../js/missing-response-recovery.js');

const prefix = () => ({ errorMessage: null, turn: { status: 'complete', items: [
  { type: 'user-message' },
  { type: 'chatgpt-reasoning-group', completed: true, items: [] },
] } });
const user = (id, parent) => ({ id, parent, message: { author: { role: 'user' } } });
const answer = (id, parent, text = 'Saved reply') => ({ id, parent, message: {
  id, author: { role: 'assistant' }, channel: 'final', status: 'finished_successfully',
  content: { content_type: 'text', parts: [text] },
} });

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
    e => { e.turn.items[1].items.push({ type: 'assistant-message', completed: true }); },
    e => { e.turn.items[1].items.push({ type: 'future-renderer', completed: true }); },
    e => { e.turn.items[1].completed = false; },
    e => { e.turn.items.pop(); },
  ]) {
    const entry = prefix(); mutate(entry);
    assert.equal(missingAnswer(entry), false);
  }
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
