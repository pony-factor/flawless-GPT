const test = require('node:test');
const assert = require('node:assert/strict');
const { validSnapshot, parseConfirmations, verifiedMerge, normalizeTasks, checklistManifest, scopedPrompt, mergeReminder, canAssign } = require('../js/dispatcher/core.js');

const sha = 'a'.repeat(40);
const snapshot = () => ({ url: 'https://chatgpt.com/c/thread-1', known: true, composerReady: true, active: false,
  queueLength: 0, submissionPending: false, latestUserAnswered: true, assistantComplete: true,
  signature: 'finished-turn', stableSince: 1000, observedAt: 2600 });

test('bulk merge prompts and continuation reminders suppress redundant PR comments', () => {
  const task = { id: 'opener-0059', prompt: 'Preserve integrity.' };
  const worker = { taskId: task.id, pendingTaskIds: [task.id], verifiedTaskIds: [] };
  const prompts = [
    scopedPrompt(task, 'PDF-magic/opener'),
    scopedPrompt(task, 'PDF-magic/opener', { preferCodexPony: true }),
    mergeReminder(worker, 'PDF-magic/opener'),
  ];
  for (const prompt of prompts) {
    assert.match(prompt, /Do not publish routine CI polling/);
    assert.match(prompt, /branch synchronization confirmations, merge readiness/);
    assert.match(prompt, /Report those updates only in ChatGPT/);
    assert.match(prompt, /substantive implementation decisions/);
    assert.match(prompt, /review existing PR comments/);
    assert.match(prompt, /never repeat previously documented findings/);
  }
});

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
  assert.doesNotMatch(prompt, /Codex Pony\/Kefania/);
  assert.match(scopedPrompt({ id: 'opener-0059', prompt: 'Preserve integrity.' }, 'PDF-magic/opener', { preferCodexPony: true }), /configured Codex Pony\/Kefania publishing tool/);
});


test('pasted Markdown checklists exclude checked items and keep section context', () => {
  const manifest = checklistManifest('# Tasks\n## Mnemonic generation\n- [x] Existing worker\n- [ ] Generate BIP-39 entropy\n- [ ] Derive SEP-5 keys\n## Browser UI\n1. [ ] Add mnemonic selector');
  assert.equal(manifest.tasks.length, 3);
  assert.deepEqual(manifest.tasks.map(task => task.task_id), ['checklist-0001', 'checklist-0002', 'checklist-0003']);
  assert.match(manifest.tasks[0].prompt, /Mnemonic generation\nGenerate BIP-39 entropy/);
  assert.match(manifest.tasks[2].prompt, /Browser UI\nAdd mnemonic selector/);
  assert.deepEqual(normalizeTasks(manifest).map(task => task.status), ['pending', 'pending', 'pending']);
});

test('pasted checklists accept plain lines or bullets and reject empty work', () => {
  assert.equal(checklistManifest('First action\nSecond action').tasks.length, 2);
  assert.equal(checklistManifest('- First action\n* Second action').tasks.length, 2);
  assert.throws(() => checklistManifest('- [x] Already complete'), /No incomplete/);
  assert.throws(() => checklistManifest('   '), /Paste checklist/);
  assert.throws(() => checklistManifest('a'.repeat(100001)), /100,000/);
  assert.throws(() => checklistManifest('a'.repeat(5001)), /5,000/);
  assert.equal(checklistManifest('## Context\n- [ ] Pending\nThis is not a checklist item').tasks.length, 1);
});

test('fresh startup snapshots require explicit dispatcher ownership', () => {
  const s = { url: 'https://chatgpt.com/', fresh: true, known: true, composerReady: true, active: false, queueLength: 0, submissionPending: false, signature: 'fresh', stableSince: Date.now() - 2000, observedAt: Date.now() };
  assert.equal(validSnapshot(s), false);
  assert.equal(validSnapshot(s, Date.now(), true), true);
});
