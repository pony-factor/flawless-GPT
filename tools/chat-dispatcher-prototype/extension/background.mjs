import { POOL_SIZE, CHAT_URL, REPOSITORY, chatURL, validSnapshot, parseConfirmations, verifiedMerge, normalizeTasks, scopedPrompt, mergeReminder, canAssign } from './core.mjs';

const VERIFIER = 'http://127.0.0.1:8794';
const blank = () => ({ version: 1, paused: true, repository: 'PDF-magic/opener', tasks: [], workers: [], events: [] });
let serial = Promise.resolve();
let pauseRequested = false;
let pauseEpoch = 0;
const locked = action => {
  const next = serial.then(action);
  serial = next.catch(() => {});
  return next;
};
const readState = async () => {
  const values = await chrome.storage.local.get(['dispatcher', 'dispatcherPaused']);
  const state = values.dispatcher || blank();
  if (values.dispatcherPaused || pauseRequested) state.paused = true;
  return state;
};
const save = state => { if (pauseRequested) state.paused = true; return chrome.storage.local.set({ dispatcher: state }); };
const log = (state, text) => { state.events.unshift({ time: new Date().toISOString(), text }); state.events.length = Math.min(state.events.length, 200); };
const dashboardSender = sender => sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('dashboard.html');

async function snapshot(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!CHAT_URL.test(tab.url || '')) throw Error('The bound tab left its ChatGPT conversation. Rebind it explicitly.');
  const result = await chrome.tabs.sendMessage(tabId, { type: 'snapshot' });
  if (result.url !== tab.url) throw Error('Tab identity changed during observation.');
  return result;
}

async function sendToWorker(state, worker, task, prompt) {
  const observed = await snapshot(worker.tabId);
  if (!validSnapshot(observed) || observed.draftPresent) return false;
  if (worker.url !== observed.url) throw Error('Worker conversation changed.');
  const nonce = crypto.randomUUID();
  // Persist the reservation before any UI mutation. A service-worker restart
  // leaves this slot blocked for review instead of replaying an uncertain send.
  const previousPhase = worker.phase;
  worker.phase = 'dispatching';
  worker.reservation = { nonce, taskId: task?.id || worker.taskId, kind: task ? 'task' : 'follow-up', previousPhase, time: Date.now() };
  if (task) task.status = 'dispatching';
  await save(state);
  const ready = await chrome.tabs.sendMessage(worker.tabId, { type: 'prepare', nonce, signature: observed.signature, prompt: `${prompt}\n\nDispatch reference: ${nonce}` });
  if (!ready?.ok) {
    worker.phase = 'review';
    worker.error = ready?.reason || 'The composer refused the prompt.';
    log(state, `Slot ${worker.slot}: ${worker.error}`);
    await save(state);
    return false;
  }
  // Pause may have been pressed while prepare was in flight. Check persisted
  // state, not only the in-memory copy loaded at the start of this cycle.
  const latest = await readState();
  if (latest.paused) {
    state.paused = true;
    worker.phase = 'review';
    worker.error = 'Paused after preparation; the draft was left unsent.';
    await save(state);
    return false;
  }
  const sent = await chrome.tabs.sendMessage(worker.tabId, { type: 'commit', nonce });
  if (!sent?.ok) {
    worker.phase = 'review';
    worker.error = sent?.reason || 'Send was not confirmed. Review before retrying.';
    if (task) task.status = 'uncertain';
    log(state, `Slot ${worker.slot}: ${worker.error}`);
    await save(state);
    return false;
  }
  if (task) {
    task.status = 'running';
    worker.taskId = task.id;
    worker.reminderSent = false;
    worker.pendingTaskIds = [task.id];
    worker.verifiedTaskIds = [];
    delete worker.merge;
  } else {
    worker.reminderSent = true;
  }
  worker.phase = 'running';
  worker.error = '';
  delete worker.reservation;
  log(state, `Slot ${worker.slot}: sent ${task ? task.id : `merge follow-up for ${worker.taskId}`}.`);
  await save(state);
  return true;
}

async function verify(confirmation) {
  const response = await fetch(`${VERIFIER}/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repository: confirmation.repository, number: confirmation.number }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error(`GitHub verifier is unavailable (${response.status}).`);
  return response.json();
}

async function tick() {
  const state = await readState();
  if (state.paused || state.workers.length !== POOL_SIZE) return;
  for (const worker of state.workers) {
    if ((await readState()).paused) return;
    if (['review', 'dispatching'].includes(worker.phase)) continue;
    try {
      const observed = await snapshot(worker.tabId);
      if (observed.url !== worker.url) throw Error('Worker URL changed; automatic reassignment is disabled.');
      worker.lastSeen = Date.now();
      if (!validSnapshot(observed)) {
        worker.activity = observed.active ? 'Working' : 'Waiting for stable completion';
        await save(state);
        continue;
      }
      worker.activity = observed.draftPresent ? 'Draft present — left untouched' : 'Idle';
      if (worker.taskId && worker.phase !== 'merged') {
        worker.pendingTaskIds ||= [worker.taskId];
        worker.verifiedTaskIds ||= [];
        for (const taskId of worker.pendingTaskIds.filter(id => !worker.verifiedTaskIds.includes(id))) {
          const confirmations = parseConfirmations(observed.confirmationText || observed.reply, state.repository, taskId);
          for (const confirmation of confirmations) {
            const actual = await verify(confirmation);
            if (verifiedMerge(confirmation, actual)) {
              worker.verifiedTaskIds.push(taskId);
              worker.merge = actual;
              const finished = state.tasks.find(task => task.id === taskId);
              if (finished) { finished.status = 'merged'; finished.merge = actual; }
              log(state, `Slot ${worker.slot}: GitHub verified ${taskId} merged as PR #${actual.number}.`);
              break;
            }
          }
        }
        const merged = worker.pendingTaskIds.every(id => worker.verifiedTaskIds.includes(id));
        if (merged) worker.phase = 'merged';
        if (!merged) {
          worker.phase = 'awaiting-merge';
          if (!observed.draftPresent && !worker.reminderSent) {
            await sendToWorker(state, worker, null, mergeReminder(worker, state.repository));
          } else if (worker.reminderSent && !observed.draftPresent) {
            worker.activity = 'Awaiting a matching GitHub-verified merge confirmation';
          }
          await save(state);
          continue;
        }
      }
      if (canAssign(worker) && !observed.draftPresent) {
        const next = state.tasks.find(task => task.status === 'pending');
        if (next) await sendToWorker(state, worker, next, scopedPrompt(next, state.repository));
        else worker.activity = 'All imported tasks assigned';
      }
      await save(state);
    } catch (error) {
      worker.error = error.message;
      // A failed/uncertain send must never become a fresh dispatch after restart.
      if (worker.phase === 'dispatching') worker.phase = 'review';
      log(state, `Slot ${worker.slot}: ${error.message}`);
      await save(state);
    }
  }
}

async function command(message) {
  const state = await readState();
  if (message.type === 'state') return { ok: true, state };
  if (message.type === 'tabs') {
    const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/c/*' });
    return { ok: true, tabs: tabs.map(({ id, windowId, title, url }) => ({ id, windowId, title, url })) };
  }
  if (message.type === 'import') {
    if (!state.paused) throw Error('Pause before importing tasks.');
    if (state.workers.some(worker => worker.taskId)) throw Error('Export the current session and reset its pool before replacing tasks.');
    if (!REPOSITORY.test(message.repository || '')) throw Error('Enter owner/repository.');
    const tasks = normalizeTasks(message.manifest);
    state.repository = message.repository;
    state.tasks = tasks;
    state.workerHints = (message.manifest?.worker_pool || []).map(worker => ({ ...worker, url: chatURL(worker.url) })).filter(worker => worker.url);
    log(state, `Imported ${tasks.length} tasks; previously sent tasks are excluded from new assignments.`);
    await save(state);
    return { ok: true };
  }
  if (message.type === 'bind') {
    if (!state.paused) throw Error('Pause before changing the pool.');
    if (state.workers.length) throw Error('Reset the existing pool before rebinding.');
    if (!Array.isArray(message.tabIds) || message.tabIds.length !== POOL_SIZE || new Set(message.tabIds).size !== POOL_SIZE) throw Error('Select exactly ten different conversation tabs.');
    const workers = [];
    for (const tabId of message.tabIds) {
      const tab = await chrome.tabs.get(tabId);
      if (!CHAT_URL.test(tab.url || '')) throw Error('Only existing ChatGPT conversation tabs can be bound.');
      // Inject into already-open tabs without reloading or interrupting them.
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      const s = await snapshot(tabId);
      const taskId = message.assignments?.[tabId] || s.taskId;
      if (!taskId || !/^[A-Za-z0-9_-]{1,80}$/.test(taskId)) throw Error(`Identify the current task for ${tab.title} before adopting it.`);
      if (workers.some(worker => worker.taskId === taskId)) throw Error('Two selected chats have the same task. Resolve duplicates before starting.');
      const history = state.tasks.filter(task => task.chatUrl === tab.url && task.status !== 'pending').map(task => task.id);
      workers.push({ slot: workers.length + 1, tabId, url: tab.url, title: tab.title, taskId, phase: 'running', reminderSent: false,
        pendingTaskIds: [...new Set([...history, taskId])], verifiedTaskIds: [] });
      const task = state.tasks.find(candidate => candidate.id === taskId);
      if (task) task.status = 'running';
    }
    state.workers = workers;
    log(state, 'Adopted ten existing chats. No prompts were sent.');
    await save(state);
    return { ok: true };
  }
  if (message.type === 'start') {
    if (message.pauseEpoch !== undefined && message.pauseEpoch !== pauseEpoch) throw Error('Start was canceled by Pause.');
    if (state.workers.length !== POOL_SIZE) throw Error('Bind exactly ten chats first.');
    const health = await fetch(`${VERIFIER}/health`, { signal: AbortSignal.timeout(3000) });
    if (!health.ok) throw Error('Start the local GitHub verifier first.');
    const details = await health.json();
    if (details.repository !== state.repository) throw Error('The verifier is scoped to a different repository.');
    if (!details.configured) throw Error('Restart the verifier with this extension ID.');
    if (message.pauseEpoch !== undefined && message.pauseEpoch !== pauseEpoch) throw Error('Start was canceled by Pause.');
    pauseRequested = false;
    await chrome.storage.local.set({ dispatcherPaused: false });
    state.paused = false;
    log(state, 'Dispatching started. Busy chats are observation-only.');
    await save(state);
    return { ok: true };
  }
  if (message.type === 'reset-pool') {
    if (!state.paused) throw Error('Pause first.');
    state.workers = [];
    log(state, 'Pool detached. Browser tabs and their running work were left untouched.');
    await save(state);
    return { ok: true };
  }
  if (message.type === 'review') {
    if (!state.paused) throw Error('Pause before resolving an uncertain slot.');
    const worker = state.workers.find(w => w.slot === message.slot);
    if (!worker || !['review', 'dispatching'].includes(worker.phase)) throw Error('This slot does not need review.');
    const held = worker.reservation;
    if (!held?.nonce) throw Error('No submission reference is recorded. Detach and re-adopt this chat after reviewing it.');
    const reviewed = await chrome.tabs.sendMessage(worker.tabId, { type: 'review', nonce: held.nonce, decision: message.decision });
    if (!reviewed?.ok) throw Error(reviewed?.reason || 'The chat could not confirm that review decision.');
    const candidate = held.kind === 'task' ? state.tasks.find(t => t.id === held.taskId) : null;
    if (message.decision === 'sent') {
      if (candidate) { candidate.status = 'running'; worker.taskId = candidate.id; worker.pendingTaskIds = [candidate.id]; worker.verifiedTaskIds = []; delete worker.merge; }
      else worker.reminderSent = true;
      worker.phase = 'running';
    } else if (message.decision === 'not-sent') {
      if (candidate) candidate.status = 'pending';
      worker.phase = held.previousPhase || 'awaiting-merge';
    } else throw Error('Review whether the message was sent first.');
    delete worker.reservation;
    worker.error = '';
    await save(state);
    return { ok: true };
  }
  throw Error('Unsupported command.');
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === 'wake' && sender.id === chrome.runtime.id && sender.tab && CHAT_URL.test(sender.url || '')) {
    locked(tick).catch(() => {});
    respond({ ok: true });
    return;
  }
  if (!dashboardSender(sender)) return;
  // Pause is immediate, even while a send's two-phase preparation is in flight.
  if (message?.type === 'pause') {
    pauseRequested = true;
    pauseEpoch++;
    chrome.storage.local.set({ dispatcherPaused: true }).then(() => respond({ ok: true }), error => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'start') message = { ...message, pauseEpoch };
  locked(() => command(message)).then(result => {
    respond(result);
    if (message.type === 'start') locked(tick).catch(() => {});
  }, error => respond({ ok: false, error: error.message }));
  return true;
});
chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') }));
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'dispatcher') locked(tick).catch(() => {}); });
chrome.tabs.onRemoved.addListener(tabId => locked(async () => {
  const state = await readState();
  const worker = state.workers.find(w => w.tabId === tabId);
  if (worker) { worker.phase = 'review'; worker.error = 'Bound tab was closed. Rebind explicitly; no replacement tab was opened.'; await save(state); }
}));
const pauseOnStartup = () => { pauseRequested = true; pauseEpoch++; return chrome.storage.local.set({ dispatcherPaused: true }); };
chrome.runtime.onStartup.addListener(pauseOnStartup);
chrome.runtime.onInstalled.addListener(pauseOnStartup);
chrome.alarms.create('dispatcher', { periodInMinutes: 0.5 }).catch(() => console.error('Could not schedule the dispatcher alarm.'));

export { tick, command, sendToWorker };
