(() => {
"use strict";
const { POOL_SIZE, CHAT_URL, REPOSITORY, chatURL, validSnapshot, parseConfirmations, verifiedMerge, normalizeTasks, scopedPrompt, mergeReminder, canAssign } = globalThis.__ghrcDispatcherCore;

const temporaryChat = url => /^https:\/\/chatgpt\.com\/c\/local-chatgpt(?:%3a|:)[A-Za-z0-9-]+(?:[?#].*)?$/i.test(url || '');
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
  const values = await chrome.storage.local.get(['chatDispatcherState', 'chatDispatcherPaused']);
  const state = values.chatDispatcherState || blank();
  if (values.chatDispatcherPaused || pauseRequested) state.paused = true;
  return state;
};
const save = state => { if (pauseRequested) state.paused = true; return chrome.storage.local.set({ chatDispatcherState: state }); };
const log = (state, text) => { state.events.unshift({ time: new Date().toISOString(), text }); state.events.length = Math.min(state.events.length, 200); };
const dashboardSender = sender => sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('chat-dispatcher.html');

async function snapshot(tabId, allowFresh = false) {
  const tab = await chrome.tabs.get(tabId);
  if (!CHAT_URL.test(tab.url || '') && !temporaryChat(tab.url) && !(allowFresh && tab.url === 'https://chatgpt.com/')) throw Error('The bound tab left its ChatGPT conversation. Rebind it explicitly.');
  let result;
  try { result = await chrome.tabs.sendMessage(tabId, { type: 'ghrc-chat-dispatcher:snapshot' }); }
  catch {
    // Extension reloads invalidate old content listeners without reloading the chat.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['js/composer/chat-dispatcher.js'] });
    result = await chrome.tabs.sendMessage(tabId, { type: 'ghrc-chat-dispatcher:snapshot' });
  }
  if (result.url !== tab.url) {
    const frame = temporaryChat(tab.url) ? await chrome.webNavigation.getFrame({ tabId, frameId: 0 }) : null;
    if (frame?.url !== result.url || !CHAT_URL.test(result.url || '')) throw Error('Tab identity changed during observation.');
  }
  return result;
}

async function sendToWorker(state, worker, task, prompt) {
  const observed = await snapshot(worker.tabId, worker.fresh === true);
  if (!validSnapshot(observed, Date.now(), worker.fresh === true) || observed.draftPresent) return false;
  if (worker.url !== observed.url) throw Error('Worker conversation changed.');
  const nonce = crypto.randomUUID();
  // Persist the reservation before any UI mutation. A service-worker restart
  // leaves this slot blocked for review instead of replaying an uncertain send.
  const previousPhase = worker.phase;
  worker.phase = 'dispatching';
  worker.reservation = { nonce, taskId: task?.id || worker.taskId, kind: task ? 'task' : 'follow-up', previousPhase, time: Date.now() };
  if (task) task.status = 'dispatching';
  await save(state);
  const ready = await chrome.tabs.sendMessage(worker.tabId, { type: 'ghrc-chat-dispatcher:prepare', nonce, signature: observed.signature, prompt: `${prompt}\n\nStart your response with this exact receipt line, then complete the task:\nDISPATCH_RECEIVED ${nonce}\n\nDispatch reference: ${nonce}` });
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
  const sent = await chrome.tabs.sendMessage(worker.tabId, { type: 'ghrc-chat-dispatcher:commit', nonce });
  if (!sent?.ok) {
    worker.phase = 'review';
    worker.error = sent?.reason || 'Send was not confirmed. Review before retrying.';
    if (task) task.status = 'uncertain';
    log(state, `Slot ${worker.slot}: ${worker.error}`);
    await save(state);
    return false;
  }
  if (task) {
    task.chatUrl = worker.url;
    task.status = 'running';
    worker.taskId = task.id;
    worker.reminderSent = false;
    worker.pendingTaskIds = [task.id];
    worker.verifiedTaskIds = [];
    delete worker.merge;
  } else {
    worker.reminderSent = true;
  }
  worker.phase = sent.pendingIdentity ? 'identifying' : 'running';
  worker.error = '';
  worker.activity = sent.pendingIdentity ? 'Waiting for the unique task receipt' : 'Working';
  if (sent.pendingIdentity) worker.dispatchNonce = nonce;
  else delete worker.reservation;
  log(state, `Slot ${worker.slot}: sent ${task ? task.id : `merge follow-up for ${worker.taskId}`}.`);
  await save(state);
  return true;
}

async function githubRead(repository, suffix = '') {
  if (!REPOSITORY.test(repository)) throw Error('Invalid repository.');
  const tokens = await TokenVault.loadTokens({ refresh: true });
  for (const token of [...tokens.map(entry => entry.token), '']) {
    try { return await fetchGitHub(`https://api.github.com/repos/${repository}${suffix}`, token); }
    catch { /* Try another existing Flawless connection, then public access. */ }
  }
  throw Error('GitHub verification failed. Check Flawless GitHub access and network connectivity; no task advanced.');
}

async function verify(confirmation) {
  const pr = await githubRead(confirmation.repository, `/pulls/${confirmation.number}`);
  return { repository: pr.base?.repo?.full_name || confirmation.repository, number: pr.number,
    url: pr.html_url, state: pr.state, merged: pr.merged === true,
    mergeCommit: pr.merged === true ? pr.merge_commit_sha : null };
}

async function tick() {
  const state = await readState();
  if (state.paused || state.workers.length !== POOL_SIZE) return;
  for (const worker of state.workers) {
    if ((await readState()).paused) return;
    if (worker.phase === 'review' && worker.reservation?.kind === 'task') {
      // Recovery observes exact task merge proof only; it never retries a send.
      try {
        const tab = await chrome.tabs.get(worker.tabId);
        if (CHAT_URL.test(tab.url || '')) {
          await chrome.scripting.executeScript({ target: { tabId: worker.tabId }, files: ['js/composer/chat-dispatcher.js'] });
          const proofSnapshot = await snapshot(worker.tabId);
          for (const proof of parseConfirmations(proofSnapshot.confirmationText || proofSnapshot.reply, state.repository, worker.reservation.taskId)) {
            if (!verifiedMerge(proof, await verify(proof))) continue;
            worker.taskId = worker.reservation.taskId; worker.pendingTaskIds = [worker.taskId]; worker.verifiedTaskIds = [];
            worker.url = proofSnapshot.url; worker.fresh = false; worker.phase = 'running'; worker.error = '';
            const task = state.tasks.find(task => task.id === worker.taskId);
            if (task) { task.status = 'running'; task.chatUrl = worker.url; }
            delete worker.reservation;
            log(state, `Slot ${worker.slot}: recovered ${worker.taskId} using GitHub-verified merge proof; no prompt replayed.`);
            await save(state); break;
          }
        }
      } catch { /* Keep the uncertain slot blocked until its proof is available. */ }
    }
    if (['review', 'dispatching', 'opening'].includes(worker.phase)) continue;
    try {
      if (worker.phase === 'identifying') {
        const tab = await chrome.tabs.get(worker.tabId);
        if (tab.url === 'https://chatgpt.com/') continue;
        if (!CHAT_URL.test(tab.url || '') && !temporaryChat(tab.url)) {
          if (tab.pendingUrl || /^https:\/\/chatgpt\.com\/(?:[?#].*)?$/.test(tab.url || '') || /^https:\/\/chatgpt\.com\/c\/local-chatgpt(?:%3A|:)[A-Za-z0-9-]+(?:[?#].*)?$/i.test(tab.url || '')) { worker.activity = 'Waiting for new-chat navigation'; await save(state); continue; }
          throw Error(`New chat left ChatGPT before its task receipt: ${tab.url || 'URL unavailable'}`);
        }
        await chrome.scripting.executeScript({ target: { tabId: worker.tabId }, files: ['js/composer/chat-dispatcher.js'] });
        const receipt = await snapshot(worker.tabId);
        if (!CHAT_URL.test(receipt.url || '')) { worker.activity = 'Waiting for the permanent conversation URL'; await save(state); continue; }
        if (!(receipt.confirmationText || receipt.reply || '').includes(`DISPATCH_RECEIVED ${worker.dispatchNonce}`)) {
          worker.activity = 'Waiting for the unique task receipt'; await save(state); continue;
        }
        const accepted = await chrome.tabs.sendMessage(worker.tabId, { type: 'ghrc-chat-dispatcher:review', nonce: worker.dispatchNonce, decision: 'sent' });
        if (!accepted?.ok) throw Error('The task receipt could not release its submission guard.');
        worker.url = receipt.url; worker.fresh = false; worker.phase = 'running'; worker.error = '';
        delete worker.reservation;
        const assigned = state.tasks.find(task => task.id === worker.taskId);
        if (assigned) assigned.chatUrl = worker.url;
        log(state, `Slot ${worker.slot}: confirmed the unique receipt for ${worker.taskId}.`);
      }
      if (worker.fresh) {
        await chrome.scripting.executeScript({ target: { tabId: worker.tabId }, files: ['js/composer/chat-dispatcher.js'] });
      }
      const observed = await snapshot(worker.tabId, worker.fresh === true);
      if (observed.url !== worker.url) throw Error('Worker URL changed; automatic reassignment is disabled.');
      worker.lastSeen = Date.now();
      worker.error = '';
      if (!validSnapshot(observed, Date.now(), worker.fresh === true)) {
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
        if (next) await sendToWorker(state, worker, next, scopedPrompt(next, state.repository, { preferCodexPony: Boolean(state.preferCodexPony) }));
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
  if (message.type === 'preferences') {
    if (!state.paused) throw Error('Pause before changing publishing preferences.');
    state.preferCodexPony = message.preferCodexPony === true;
    await save(state);
    return { ok: true };
  }
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
      await chrome.scripting.executeScript({ target: { tabId }, files: ['js/composer/chat-dispatcher.js'] });
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
    if (state.workers.some(worker => worker.phase === 'opening' || !worker.tabId)) throw Error('Pool creation was interrupted. Pause and detach the incomplete pool before starting again.');
    if (state.workers.length && state.workers.length !== POOL_SIZE) throw Error('The pool is incomplete. Pause and detach it before starting again.');
    if (!state.tasks.some(task => task.status === 'pending') && !state.workers.length) throw Error('Import checklist tasks first.');
    await githubRead(state.repository);
    if (!state.workers.length) {
      // Persist each opening reservation before creating a tab. A crash never replays it.
      state.workers = Array.from({ length: POOL_SIZE }, (_, i) => ({ slot: i + 1, phase: 'opening', fresh: true }));
      await save(state);
      for (const worker of state.workers) {
        if (message.pauseEpoch !== undefined && message.pauseEpoch !== pauseEpoch) throw Error('Start was canceled by Pause.');
        const tab = await chrome.tabs.create({ url: 'https://chatgpt.com/', active: false });
        Object.assign(worker, { tabId: tab.id, url: 'https://chatgpt.com/', phase: 'ready', reminderSent: false });
        await save(state);
      }
      log(state, 'Created ten fresh chats. These same chats will be reused after verified merges.');
    }
    if (message.pauseEpoch !== undefined && message.pauseEpoch !== pauseEpoch) throw Error('Start was canceled by Pause.');
    pauseRequested = false;
    await chrome.storage.local.set({ chatDispatcherPaused: false });
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
    await chrome.scripting.executeScript({ target: { tabId: worker.tabId }, files: ['js/composer/chat-dispatcher.js'] });
    const reviewed = await chrome.tabs.sendMessage(worker.tabId, { type: 'ghrc-chat-dispatcher:review', nonce: held.nonce, decision: message.decision });
    if (!reviewed?.ok && message.decision === 'sent') {
      const observed = await snapshot(worker.tabId);
      for (const proof of parseConfirmations(observed.confirmationText || observed.reply, state.repository, held.taskId)) {
        if (verifiedMerge(proof, await verify(proof))) { reviewed.ok = true; reviewed.url = observed.url; break; }
      }
    }
    if (!reviewed?.ok) throw Error(reviewed?.reason || 'The chat could not confirm that review decision.');
    const candidate = held.kind === 'task' ? state.tasks.find(t => t.id === held.taskId) : null;
    if (message.decision === 'sent') {
      if (worker.fresh) {
        const tab = await chrome.tabs.get(worker.tabId);
        if (!CHAT_URL.test(reviewed.url || '') || tab.url !== reviewed.url) throw Error('Review could not confirm the new conversation identity.');
        worker.url = reviewed.url; worker.fresh = false;
      }
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
  if (message?.type === 'ghrc-chat-dispatcher:wake' && sender.id === chrome.runtime.id && sender.tab && CHAT_URL.test(sender.url || '')) {
    locked(tick).catch(() => {});
    respond({ ok: true });
    return;
  }
  if (!dashboardSender(sender) || !message?.type?.startsWith('ghrc-chat-dispatcher:')) return;
  message = { ...message, type: message.type.slice('ghrc-chat-dispatcher:'.length) };
  // Pause is immediate, even while a send's two-phase preparation is in flight.
  if (message?.type === 'pause') {
    pauseRequested = true;
    pauseEpoch++;
    chrome.storage.local.set({ chatDispatcherPaused: true }).then(() => respond({ ok: true }), error => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'start') message = { ...message, pauseEpoch };
  locked(() => command(message)).then(result => {
    respond(result);
    if (message.type === 'start') locked(tick).catch(() => {});
  }, error => respond({ ok: false, error: error.message }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'chat-dispatcher') locked(tick).catch(() => {}); });
chrome.tabs.onRemoved.addListener(tabId => locked(async () => {
  const state = await readState();
  const worker = state.workers.find(w => w.tabId === tabId);
  if (worker) { worker.phase = 'review'; worker.error = 'Bound tab was closed. Rebind explicitly; no replacement tab was opened.'; await save(state); }
}));
const pauseOnStartup = () => { pauseRequested = true; pauseEpoch++; return chrome.storage.local.set({ chatDispatcherPaused: true }); };
chrome.runtime.onStartup.addListener(pauseOnStartup);
chrome.runtime.onInstalled.addListener(pauseOnStartup);
chrome.alarms.create('chat-dispatcher', { periodInMinutes: 0.5 }).catch(() => console.error('Could not schedule the dispatcher alarm.'));

if (globalThis.__GHRC_DISPATCHER_TEST__) Object.assign(globalThis.__GHRC_DISPATCHER_TEST__, { tick, command, sendToWorker });

})();
