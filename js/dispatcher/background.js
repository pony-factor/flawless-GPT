(() => {
"use strict";
const { POOL_SIZE, CHAT_URL, REPOSITORY, chatURL, validSnapshot, parseConfirmations, verifiedMerge, normalizeTasks, scopedPrompt, mergeReminder, canAssign, shouldRotate } = globalThis.__ghrcDispatcherCore;

const temporaryChat = url => /^https:\/\/chatgpt\.com\/c\/local-chatgpt(?:%3a|:)[A-Za-z0-9-]+(?:[?#].*)?$/i.test(url || '');
const REGISTRY_KEY = 'chatDispatcherSessionIds';
const SESSION_ID = /^(?:legacy|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
const stateKey = id => id === 'legacy' ? 'chatDispatcherState' : `chatDispatcherState:${id}`;
const pausedKey = id => id === 'legacy' ? 'chatDispatcherPaused' : `chatDispatcherPaused:${id}`;
const blank = id => ({ id, version: 2, paused: true, repository: 'PDF-magic/opener', replaceExistingDrafts: false, tasks: [], workers: [], events: [] });
const serials = new Map();
const pauseRequested = new Set();
const pauseEpoch = new Map();
let registrySerial = Promise.resolve();
const locked = (id, action) => {
  const next = (serials.get(id) || Promise.resolve()).then(action);
  serials.set(id, next.catch(() => {}));
  return next;
};
async function sessionIds() {
  const values = await chrome.storage.local.get([REGISTRY_KEY, 'chatDispatcherState']);
  const ids = Array.isArray(values[REGISTRY_KEY]) ? values[REGISTRY_KEY] : [];
  // Older single-dispatcher sessions remain accessible and are never overwritten.
  return [...new Set([...(values.chatDispatcherState ? ['legacy'] : []), ...ids.filter(id => SESSION_ID.test(id))])];
}
function registerSession(id) {
  const next = registrySerial.then(async () => {
    const ids = await sessionIds();
    if (!ids.includes(id)) await chrome.storage.local.set({ [REGISTRY_KEY]: [...ids, id] });
  });
  registrySerial = next.catch(() => {});
  return next;
}
const readState = async (id = 'legacy') => {
  const values = await chrome.storage.local.get([stateKey(id), pausedKey(id)]);
  const state = values[stateKey(id)] || blank(id);
  state.id = id;
  if (values[pausedKey(id)] || pauseRequested.has(id)) state.paused = true;
  return state;
};
const save = state => {
  if (pauseRequested.has(state.id)) state.paused = true;
  return chrome.storage.local.set({ [stateKey(state.id)]: state });
};
const log = (state, text) => { state.events.unshift({ time: new Date().toISOString(), text }); state.events.length = Math.min(state.events.length, 200); };
const dashboardSession = sender => {
  if (sender.id !== chrome.runtime.id || !sender.url) return null;
  const url = new URL(sender.url);
  if (`${url.protocol}//${url.host}${url.pathname}` !== chrome.runtime.getURL('chat-dispatcher.html')) return null;
  const id = url.searchParams.get('session') || 'legacy';
  return SESSION_ID.test(id) ? id : null;
};
async function listSessions() {
  const sessions = [];
  for (const id of await sessionIds()) {
    const state = await readState(id);
    sessions.push({ id, repository: state.repository, paused: state.paused, tasks: state.tasks.length,
      merged: state.tasks.filter(task => task.status === 'merged').length, workers: state.workers.length });
  }
  return sessions;
}

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

// A draft can only be replaced with explicit consent and positive evidence that
// it consists of ordinary text. Unknown/older adapters and contextual content block.
function draftBlocksDispatch(state, observed) {
  if (observed.hasContext === true) return true;
  if (!observed.draftPresent) return false;
  return !(state.replaceExistingDrafts === true && observed.draftTextPresent === true && observed.hasContext === false);
}

async function sendToWorker(state, worker, task, prompt) {
  const observed = await snapshot(worker.tabId, worker.fresh === true);
  if (!validSnapshot(observed, Date.now(), worker.fresh === true) || draftBlocksDispatch(state, observed)) return false;
  if (worker.url !== observed.url) throw Error('Worker conversation changed.');
  const nonce = crypto.randomUUID();
  // Persist the reservation before any UI mutation. A service-worker restart
  // leaves this slot blocked for review instead of replaying an uncertain send.
  const previousPhase = worker.phase;
  worker.phase = 'dispatching';
  worker.reservation = { nonce, taskId: task?.id || worker.taskId, kind: task ? 'task' : 'follow-up', previousPhase, time: Date.now() };
  if (task) task.status = 'dispatching';
  await save(state);
  const ready = await chrome.tabs.sendMessage(worker.tabId, { type: 'ghrc-chat-dispatcher:prepare', nonce, signature: observed.signature, replaceDraft: state.replaceExistingDrafts === true && observed.draftTextPresent === true && observed.hasContext === false, prompt: `${prompt}\n\nStart your response with this exact receipt line, then complete the task:\nDISPATCH_RECEIVED ${nonce}\n\nDispatch reference: ${nonce}` });
  if (!ready?.ok) {
    worker.phase = 'review';
    worker.error = ready?.reason || 'The composer refused the prompt.';
    log(state, `Slot ${worker.slot}: ${worker.error}`);
    await save(state);
    return false;
  }
  // Pause may have been pressed while prepare was in flight. Check persisted
  // state, not only the in-memory copy loaded at the start of this cycle.
  const latest = await readState(state.id);
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

// Rotation is reserved before opening a tab. Once its replacement ID is saved,
 // a restarted service worker can complete the same handoff without creating
 // another chat or dispatching a fourth task to the old conversation.
async function finishRotation(state, worker) {
  const rotation = worker.rotation;
  if (!rotation?.newTabId) {
    worker.phase = 'review';
    worker.error = 'Chat rotation was interrupted before the replacement was recorded. Inspect open chats and rebind the slot.';
    await save(state);
    return false;
  }
  if ((await readState(state.id)).paused) {
    worker.activity = 'Rotation paused; original chat retained';
    await save(state);
    return false;
  }
  const replacement = await chrome.tabs.get(rotation.newTabId);
  if (replacement.url && !/^https:\/\/chatgpt\.com\/(?:[?#].*)?$/.test(replacement.url)) {
    throw Error('Replacement tab left the new-chat page. Original chat was not closed.');
  }
  const original = await chrome.tabs.get(rotation.previousTabId).catch(() => null);
  if (original) {
    if (original.url !== rotation.previousUrl || original.pendingUrl) {
      throw Error('Original chat navigated during rotation. It was not closed.');
    }
    const observed = await snapshot(rotation.previousTabId);
    if (!validSnapshot(observed) || observed.draftPresent) {
      worker.activity = 'Waiting for original chat to become idle before closing it';
      await save(state);
      return false;
    }
    await chrome.tabs.remove(rotation.previousTabId);
  }
  Object.assign(worker, {
    tabId: rotation.newTabId, url: 'https://chatgpt.com/', title: 'New chat',
    fresh: true, phase: 'ready', taskId: null, reminderSent: false,
    pendingTaskIds: [], verifiedTaskIds: [], activity: 'Fresh chat ready', error: '',
  });
  delete worker.rotation;
  delete worker.reservation;
  delete worker.dispatchNonce;
  delete worker.merge;
  log(state, `Slot ${worker.slot}: detached and closed the previous chat after three verified jobs; opened a fresh chat.`);
  await save(state);
  return true;
}

async function rotateWorker(state, worker) {
  worker.phase = 'rotating';
  worker.activity = 'Opening a new chat after three verified jobs';
  worker.rotation = { previousTabId: worker.tabId, previousUrl: worker.url };
  await save(state);
  try {
    const replacement = await chrome.tabs.create({ url: 'https://chatgpt.com/', active: false });
    worker.rotation.newTabId = replacement.id;
    await save(state);
  } catch (error) {
    // If creating the replacement failed, leave the verified old chat intact.
    // Do not automatically repeat a possibly successful, unrecorded creation.
    worker.phase = 'review';
    worker.error = 'Could not record a replacement chat. Inspect browser tabs before retrying: ' + error.message;
    await save(state);
    return false;
  }
  return finishRotation(state, worker);
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

async function tick(id = 'legacy') {
  const state = await readState(id);
  if (state.paused || state.workers.length !== POOL_SIZE) return;
  for (const worker of state.workers) {
    if ((await readState(id)).paused) return;
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
    if (worker.phase === 'rotating') {
      try { await finishRotation(state, worker); }
      catch (error) {
        worker.error = error.message;
        log(state, `Slot ${worker.slot}: ${error.message}`);
        await save(state);
      }
      continue;
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
      worker.activity = draftBlocksDispatch(state, observed) ? 'Draft or composer context present — left untouched' : 'Idle';
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
              if (finished) { finished.status = 'merged'; finished.merge = actual; finished.chatUrl = worker.url; }
              log(state, `Slot ${worker.slot}: GitHub verified ${taskId} merged as PR #${actual.number}.`);
              break;
            }
          }
        }
        const merged = worker.pendingTaskIds.every(id => worker.verifiedTaskIds.includes(id));
        if (merged) worker.phase = 'merged';
        if (!merged) {
          worker.phase = 'awaiting-merge';
          if (!draftBlocksDispatch(state, observed) && !worker.reminderSent) {
            await sendToWorker(state, worker, null, mergeReminder(worker, state.repository));
          } else if (worker.reminderSent && !draftBlocksDispatch(state, observed)) {
            worker.activity = 'Awaiting a matching GitHub-verified merge confirmation';
          }
          await save(state);
          continue;
        }
      }
      if (canAssign(worker) && !draftBlocksDispatch(state, observed)) {
        if (shouldRotate(state.tasks, worker)) {
          // Replacing a draft for a send never authorizes deleting its tab.
          if (observed.draftPresent) {
            worker.activity = 'Draft present — waiting to rotate without closing it';
            await save(state);
            continue;
          }
          await rotateWorker(state, worker);
          continue;
        }
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

async function command(message, id = 'legacy') {
  if (!SESSION_ID.test(id)) throw Error('Invalid dispatcher session.');
  await registerSession(id);
  const state = await readState(id);
  if (message.type === 'state') return { ok: true, state };
  if (message.type === 'sessions') return { ok: true, sessions: await listSessions() };
  if (message.type === 'preferences') {
    if (!state.paused) throw Error('Pause before changing dispatcher preferences.');
    if ('preferCodexPony' in message) {
      if (typeof message.preferCodexPony !== 'boolean') throw Error('Invalid publishing preference.');
      state.preferCodexPony = message.preferCodexPony;
    }
    if ('replaceExistingDrafts' in message) {
      if (typeof message.replaceExistingDrafts !== 'boolean') throw Error('Invalid draft replacement preference.');
      state.replaceExistingDrafts = message.replaceExistingDrafts;
    }
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
    // Prevent two independent dispatchers from controlling the same browser tab.
    for (const otherId of await sessionIds()) {
      if (otherId === id) continue;
      const other = await readState(otherId);
      if (other.workers.some(worker => message.tabIds.includes(worker.tabId)
        || message.tabIds.includes(worker.rotation?.newTabId))) {
        throw Error('A selected chat is already owned by another dispatcher.');
      }
    }
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
      if (task) { task.status = 'running'; task.chatUrl = tab.url; }
    }
    state.workers = workers;
    log(state, 'Adopted ten existing chats. No prompts were sent.');
    await save(state);
    return { ok: true };
  }
  if (message.type === 'start') {
    if (message.pauseEpoch !== undefined && message.pauseEpoch !== (pauseEpoch.get(id) || 0)) throw Error('Start was canceled by Pause.');
    if (state.workers.some(worker => worker.phase === 'opening' || !worker.tabId)) throw Error('Pool creation was interrupted. Pause and detach the incomplete pool before starting again.');
    if (state.workers.length && state.workers.length !== POOL_SIZE) throw Error('The pool is incomplete. Pause and detach it before starting again.');
    if (!state.tasks.some(task => task.status === 'pending') && !state.workers.length) throw Error('Import checklist tasks first.');
    await githubRead(state.repository);
    if (!state.workers.length) {
      // Persist each opening reservation before creating a tab. A crash never replays it.
      state.workers = Array.from({ length: POOL_SIZE }, (_, i) => ({ slot: i + 1, phase: 'opening', fresh: true }));
      await save(state);
      for (const worker of state.workers) {
        if (message.pauseEpoch !== undefined && message.pauseEpoch !== (pauseEpoch.get(id) || 0)) throw Error('Start was canceled by Pause.');
        const tab = await chrome.tabs.create({ url: 'https://chatgpt.com/', active: false });
        Object.assign(worker, { tabId: tab.id, url: 'https://chatgpt.com/', phase: 'ready', reminderSent: false });
        await save(state);
      }
      log(state, 'Created ten fresh chats. These same chats will be reused after verified merges.');
    }
    if (message.pauseEpoch !== undefined && message.pauseEpoch !== (pauseEpoch.get(id) || 0)) throw Error('Start was canceled by Pause.');
    pauseRequested.delete(id);
    await chrome.storage.local.set({ [pausedKey(id)]: false });
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

// Independent session queues allow overlapping manifests and background work.
async function tickAll(tabId = null) {
  const ids = await sessionIds();
  await Promise.all(ids.map(id => locked(id, async () => {
    if (tabId !== null) {
      const state = await readState(id);
      if (!state.workers.some(worker => worker.tabId === tabId
        || worker.rotation?.newTabId === tabId)) return;
    }
    await tick(id);
  })));
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === 'ghrc-chat-dispatcher:wake' && sender.id === chrome.runtime.id && sender.tab && CHAT_URL.test(sender.url || '')) {
    tickAll(sender.tab.id).catch(() => {});
    respond({ ok: true });
    return;
  }
  const id = dashboardSession(sender);
  if (!id || !message?.type?.startsWith('ghrc-chat-dispatcher:')) return;
  if ((message.sessionId || 'legacy') !== id) {
    respond({ ok: false, error: 'Dispatcher session does not match its dashboard.' });
    return;
  }
  message = { ...message, type: message.type.slice('ghrc-chat-dispatcher:'.length) };
  // Pause bypasses the worker lock and applies only to this session.
  if (message.type === 'pause') {
    pauseRequested.add(id);
    pauseEpoch.set(id, (pauseEpoch.get(id) || 0) + 1);
    chrome.storage.local.set({ [pausedKey(id)]: true })
      .then(() => respond({ ok: true }), error => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === 'start') message = { ...message, pauseEpoch: pauseEpoch.get(id) || 0 };
  locked(id, () => command(message, id)).then(result => {
    respond(result);
    if (message.type === 'start') locked(id, () => tick(id)).catch(() => {});
  }, error => respond({ ok: false, error: error.message }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'chat-dispatcher') tickAll().catch(() => {});
});
chrome.tabs.onRemoved.addListener(tabId => {
  sessionIds().then(ids => Promise.all(ids.map(id => locked(id, async () => {
    const state = await readState(id);
    const worker = state.workers.find(w => w.tabId === tabId);
    if (worker && worker.phase === 'rotating' && worker.rotation?.previousTabId === tabId) return;
    if (worker) {
      worker.phase = 'review';
      worker.error = 'Bound tab was closed. Rebind explicitly; no replacement tab was opened.';
      await save(state);
    }
    const rotating = state.workers.find(w => w.phase === 'rotating' && w.rotation?.newTabId === tabId);
    if (rotating) {
      rotating.phase = 'review';
      rotating.error = 'Replacement chat was closed during rotation. Inspect the original tab and rebind.';
      await save(state);
    }
  })))).catch(() => {});
});
const pauseOnStartup = async () => {
  const ids = await sessionIds();
  for (const id of ids) {
    pauseRequested.add(id);
    pauseEpoch.set(id, (pauseEpoch.get(id) || 0) + 1);
  }
  await chrome.storage.local.set(Object.fromEntries(ids.map(id => [pausedKey(id), true])));
};
chrome.runtime.onStartup.addListener(pauseOnStartup);
chrome.runtime.onInstalled.addListener(pauseOnStartup);
chrome.alarms.create('chat-dispatcher', { periodInMinutes: 0.5 }).catch(() => console.error('Could not schedule the dispatcher alarm.'));

if (globalThis.__GHRC_DISPATCHER_TEST__) Object.assign(globalThis.__GHRC_DISPATCHER_TEST__, {
  tick, tickAll, command, sendToWorker, sessionIds, readState, listSessions,
});

})();