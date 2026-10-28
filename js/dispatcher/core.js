(() => {
"use strict";
const SETTLE_MS = 1500;
const POOL_SIZE = 10;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CHAT_URL = /^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]+\/?(?:[?#].*)?$/;

function chatURL(value) {
  const url = String(value || '').startsWith('chatgpt.com/') ? `https://${value}` : String(value || '');
  return CHAT_URL.test(url) ? url : null;
}

function validSnapshot(s, now = Date.now(), allowFresh = false) {
  return Boolean(s && (CHAT_URL.test(s.url) || allowFresh && s.fresh && s.url === 'https://chatgpt.com/') && s.known && s.composerReady
    && !s.active && !s.queueLength && !s.submissionPending
    && (allowFresh && s.fresh || s.latestUserAnswered && s.assistantComplete) && s.signature && Number.isFinite(s.stableSince)
    && Number.isFinite(s.observedAt) && now - s.stableSince >= SETTLE_MS
    && now >= s.observedAt && now - s.observedAt < 5000);
}

function parseConfirmations(reply, repository, taskId) {
  if (!REPOSITORY.test(repository)) return [];
  const confirmations = [];
  const pattern = /(?:^|\n)\s*MERGE_CONFIRMED\s+(opener-\d+|[A-Za-z0-9_-]+)\s+https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)\s+([a-f0-9]{40})\b/g;
  for (const match of String(reply || '').matchAll(pattern)) {
    if (match[1] === taskId && match[2].toLowerCase() === repository.toLowerCase()) {
      confirmations.push({ taskId, repository, number: Number(match[3]), sha: match[4] });
    }
  }
  return confirmations;
}

function verifiedMerge(confirmation, actual) {
  return Boolean(actual && actual.merged === true && actual.state === 'closed'
    && actual.repository?.toLowerCase() === confirmation.repository.toLowerCase()
    && actual.number === confirmation.number && actual.mergeCommit === confirmation.sha
    && actual.url === `https://github.com/${actual.repository}/pull/${actual.number}`);
}

function normalizeTasks(input) {
  const source = Array.isArray(input) ? input : input?.tasks;
  if (!Array.isArray(source) || source.length > 10000) throw Error('Import a task array or manifest (maximum 10,000 tasks).');
  const seen = new Set();
  return source.map((item, index) => {
    const id = item.task_id || item.id || `task-${index + 1}`;
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || seen.has(id)) throw Error(`Invalid or duplicate task ID: ${id}`);
    seen.add(id);
    const prompt = String(item.prompt || '').trim();
    if (!prompt || prompt.length > 100000) throw Error(`Task ${id} needs a prompt under 100,000 characters.`);
    return { id, prompt, chatUrl: chatURL(item.chat_url || item.chatUrl), status: ['prepared', 'pending', undefined].includes(item.status) ? 'pending' : 'previously-sent' };
  });
}

function scopedPrompt(task, repository, { preferCodexPony = false } = {}) {
  if (!REPOSITORY.test(repository)) throw Error('Use an owner/repository name.');
  return `Repository: https://github.com/${repository}\nTask: ${task.id}\n\n${task.prompt}\n\n`
    + `Work only in ${repository}. Use a fresh isolated checkout and a short descriptive branch without slashes. `
    + 'Read applicable AGENTS.md instructions. Preserve unrelated changes and user customizations. '
    + 'Implement this scoped task, add necessary CI coverage, and run required checks. '
    + 'This request authorizes committing and pushing this task, opening one focused PR, and squash-merging after completion and passing required checks. '
    + 'Use an emoji imperative PR title and explain what changed and why. Do not access secret-bearing files. '
    + (preferCodexPony ? 'If the configured Codex Pony/Kefania publishing tool is available in this chat, use it to create the PR as Codex Pony. Otherwise use the available authorized GitHub workflow and report which identity created the PR. Never read or copy credentials to change identities. ' : '')
    + 'Leave automatic branch deletion and checkout cleanup to the existing workflow. '
    + 'Do not finish at an open PR, a closed-unmerged PR, or passing CI alone. Verify GitHub reports merged=true. '
    + 'If already implemented, identify the existing merged PR that satisfies this task instead of opening an empty PR. '
    + `End with exactly this confirmation format, using the actual full merge SHA:\nMERGE_CONFIRMED ${task.id} https://github.com/${repository}/pull/<number> <40-character merge commit SHA>`;
}

function mergeReminder(worker, repository) {
  const outstanding = (worker.pendingTaskIds || [worker.taskId]).filter(id => !(worker.verifiedTaskIds || []).includes(id));
  return `Finish your existing ${repository} task ${worker.taskId} before taking another checklist item. `
    + `Also finish and confirm any earlier tasks assigned to this same chat that remain unverified: ${outstanding.join(', ')}. `
    + 'Complete the implementation, resolve PR conflicts safely, pass required checks, and squash-merge the PR. '
    + 'Confirm GitHub actually reports merged=true. Do not create a duplicate PR. '
    + 'Leave automatic branch deletion and checkout cleanup to the existing workflow. '
    + 'Provide a separate confirmation line for each outstanding task, using its actual task ID: '
    + `MERGE_CONFIRMED ${worker.taskId} https://github.com/${repository}/pull/<number> <40-character merge commit SHA>`;
}

function canAssign(worker) {
  return !worker.taskId || worker.phase === 'merged';
}

const api = { SETTLE_MS, POOL_SIZE, REPOSITORY, CHAT_URL, chatURL, validSnapshot, parseConfirmations, verifiedMerge, normalizeTasks, scopedPrompt, mergeReminder, canAssign };
globalThis.__ghrcDispatcherCore = api;
if (typeof module !== "undefined") module.exports = api;
})();
