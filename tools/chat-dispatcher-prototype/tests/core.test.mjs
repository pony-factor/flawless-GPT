import test from 'node:test';
import assert from 'node:assert/strict';
import { validSnapshot, parseConfirmations, verifiedMerge, normalizeTasks, scopedPrompt, canAssign } from '../extension/core.mjs';

const sha = 'a'.repeat(40);
const snapshot = () => ({ url: 'https://chatgpt.com/c/thread-1', known: true, composerReady: true, active: false,
  queueLength: 0, submissionPending: false, latestUserAnswered: true, assistantComplete: true,
  signature: 'finished-turn', stableSince: 1000, observedAt: 2600 });

test('unknown, active, incomplete, queued, stale, and unsettled chats cannot send', () => {
  assert.equal(validSnapshot(snapshot(), 2600), true);
  for (const change of [{ known: false }, { active: true }, { composerReady: false }, { queueLength: 1 },
    { submissionPending: true }, { latestUserAnswered: false }, { assistantComplete: false },
    { stableSince: 2000 }, { observedAt: -5000 }, { url: 'https://chatgpt.com/' }]) {
    assert.equal(validSnapshot({ ...snapshot(), ...change }, 2600), false, JSON.stringify(change));
  }
});

test('only exact current-task merge confirmations in the scoped repository are accepted', () => {
  const line = `MERGE_CONFIRMED opener-0059 https://github.com/PDF-magic/opener/pull/27 ${sha}`;
  const [confirmation] = parseConfirmations(line, 'PDF-magic/opener', 'opener-0059');
  assert.equal(confirmation.number, 27);
  assert.deepEqual(parseConfirmations(line, 'PDF-magic/opener', 'opener-0060'), []);
  assert.deepEqual(parseConfirmations(line, 'somewhere/else', 'opener-0059'), []);
  assert.deepEqual(parseConfirmations(line.replace(sha, 'abc1234'), 'PDF-magic/opener', 'opener-0059'), []);
  assert.deepEqual(parseConfirmations('Please write ' + line, 'PDF-magic/opener', 'opener-0059'), []);
});

test('open and closed-unmerged PRs, wrong merge commits, and wrong repositories never release a slot', () => {
  const c = { repository: 'PDF-magic/opener', number: 27, sha };
  const actual = { repository: c.repository, number: 27, merged: true, state: 'closed', mergeCommit: sha, url: 'https://github.com/PDF-magic/opener/pull/27' };
  assert.equal(verifiedMerge(c, actual), true);
  for (const change of [{ state: 'open' }, { merged: false }, { mergeCommit: 'b'.repeat(40) }, { repository: 'other/repo' }, { number: 28 }]) {
    assert.equal(verifiedMerge(c, { ...actual, ...change }), false);
  }
  assert.equal(canAssign({ taskId: 'opener-0059', phase: 'awaiting-merge' }), false);
  assert.equal(canAssign({ taskId: 'opener-0059', phase: 'merged' }), true);
});

test('imports preserve already-sent exclusions and reject duplicates', () => {
  assert.deepEqual(normalizeTasks({ tasks: [{ task_id: 'a', prompt: 'one', status: 'sent' }, { task_id: 'b', prompt: 'two', status: 'prepared' }] }).map(t => t.status), ['previously-sent', 'pending']);
  assert.throws(() => normalizeTasks([{ id: 'a', prompt: 'x' }, { id: 'a', prompt: 'y' }]), /duplicate/);
  assert.equal(normalizeTasks([{ id: 'exported', prompt: 'Resume this', status: 'pending' }])[0].status, 'pending');
  const prompt = scopedPrompt({ id: 'opener-0059', prompt: 'Preserve integrity.' }, 'PDF-magic/opener');
  assert.match(prompt, /squash-merging/);
  assert.match(prompt, /MERGE_CONFIRMED opener-0059/);
  assert.doesNotMatch(prompt, /switch.*main|delete.*branch/);
});
