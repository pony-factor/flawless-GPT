const connected = Boolean(globalThis.chrome?.runtime?.id);
const $ = id => document.getElementById(id);
const pageUrl = new URL(location.href);
const suppliedId = pageUrl.searchParams.get('session');
const sessionId = /^(?:legacy|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(suppliedId || '')
  ? suppliedId : crypto.randomUUID();
if (suppliedId !== sessionId) {
  pageUrl.searchParams.set('session', sessionId);
  history.replaceState(null, '', pageUrl);
}
let state = { paused: true, tasks: [], workers: [], events: [] };
let sessions = [];
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const notice = text => { $('notice').textContent = text; $('notice').hidden = !text; };
async function request(message) {
  if (!connected) throw Error('Preview only. Open this dashboard from Flawless to connect your chats.');
  const response = await chrome.runtime.sendMessage({ ...message, sessionId, type: `ghrc-chat-dispatcher:${message.type}` });
  if (!response?.ok) throw Error(response?.error || 'The dispatcher did not respond.');
  return response;
}
async function action(message) {
  try { await request(message); notice(''); await refresh(); } catch (error) { notice(error.message); }
}

const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function formatEventTime(value, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - new Date(value).getTime()) / 1000));
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return 'Just now';
  for (const [unit, size] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (seconds >= size) return relativeTime.format(-Math.floor(seconds / size), unit);
  }
}
function refreshEventTimes() {
  for (const time of $('events').querySelectorAll('time[datetime]')) time.textContent = formatEventTime(time.dateTime);
}
setInterval(refreshEventTimes, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshEventTimes(); });

function render() {
  $('session-name').textContent = sessionId === 'legacy' ? 'Previous dispatcher' : `Dispatcher ${sessionId.slice(0, 8)}`;
  $('session-list').replaceChildren();
  for (const session of sessions) {
    if (session.id === sessionId) continue;
    const link = el('a', `${session.repository} · ${session.paused ? 'Paused' : 'Running'} · ${session.merged}/${session.tasks} merged`);
    link.href = `chat-dispatcher.html?session=${encodeURIComponent(session.id)}`;
    link.target = '_blank';
    link.rel = 'noopener';
    $('session-list').append(link);
  }
  if (!sessions.some(session => session.id !== sessionId)) $('session-list').append(el('span', 'No other dispatcher sessions yet.'));
  $('run-status').textContent = state.paused ? 'Paused' : 'Running';
  $('run-status').classList.toggle('live', !state.paused);
  $('repository').value = state.repository || 'PDF-magic/opener';
  $('repository').disabled = !state.paused;
  $('prefer-codex-pony').checked = Boolean(state.preferCodexPony);
  $('prefer-codex-pony').disabled = !state.paused || !connected;
  $('replace-existing-drafts').checked = state.replaceExistingDrafts === true;
  $('replace-existing-drafts').disabled = !state.paused || !connected;
  $('manifest').disabled = !state.paused || !connected;
  $('checklist-text').disabled = !state.paused || !connected;
  $('import-checklist').disabled = !state.paused || !connected;
  $('start').disabled = !connected || !state.paused || !state.tasks.length || Boolean(state.workers.length && state.workers.length !== 10);
  $('pause').disabled = !connected || state.paused;
  $('reset').disabled = !connected || !state.paused || !state.workers.length;
  $('merged-count').textContent = state.tasks.filter(t => t.status === 'merged').length;
  $('active-count').textContent = `${state.workers.length} / 10`;
  $('pending-count').textContent = state.tasks.filter(t => t.status === 'pending').length;
  $('review-count').textContent = state.workers.filter(w => ['review', 'dispatching'].includes(w.phase) || w.error).length;
  $('workers').replaceChildren();
  for (let i = 0; i < 10; i++) {
    const worker = state.workers[i];
    const card = el('article', undefined, `worker ${worker?.phase || ''}`);
    const top = el('div', undefined, 'worker-top');
    top.append(el('span', `CHAT ${String(i + 1).padStart(2, '0')}`), el('span', undefined, 'dot'));
    card.append(top, el('strong', worker?.taskId || 'Unbound chat'));
    card.append(el('p', worker ? worker.activity || worker.phase.replaceAll('-', ' ') : 'Start creates a fresh chat for this slot.'));
    if (worker?.url) {
      const link = el('a', 'Open chat ↗'); link.href = worker.url; link.target = '_blank'; link.rel = 'noopener'; card.append(link);
    }
    if (worker?.merge) {
      const link = el('a', `Merged PR #${worker.merge.number} ↗`); link.href = worker.merge.url; link.target = '_blank'; link.rel = 'noopener'; card.append(link);
    }
    if (worker?.error) card.append(el('p', worker.error, 'error'));
    if (worker && ['review', 'dispatching'].includes(worker.phase)) {
      const controls = el('div', undefined, 'review-actions');
      for (const [decision, title] of [['sent', 'I confirmed it sent'], ['not-sent', 'I confirmed it did not send']]) {
        const button = el('button', title); button.disabled = !state.paused;
        button.addEventListener('click', () => action({ type: 'review', slot: worker.slot, decision })); controls.append(button);
      }
      card.append(controls);
    }
    $('workers').append(card);
  }
  $('events').replaceChildren();
  if (!state.events.length) $('events').append(el('li', 'No tasks have been sent.'));
  for (const event of state.events) {
    const row = el('li'); const time = el('time', formatEventTime(event.time)); time.dateTime = event.time; time.title = new Date(event.time).toLocaleString();
    row.append(time, document.createTextNode(event.text)); $('events').append(row);
  }
}

async function refresh() {
  if (connected) {
    state = (await request({ type: 'state' })).state;
    sessions = (await request({ type: 'sessions' })).sessions;
  }
  render();
}

$('manifest').addEventListener('change', async event => {
  try {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) throw Error('Choose a task manifest under 20 MB.');
    const manifest = JSON.parse(await file.text());
    await action({ type: 'import', manifest, repository: $('repository').value.trim() });
  } catch (error) { notice(error.message); }
  event.target.value = '';
});
$('import-checklist').addEventListener('click', async () => {
  try {
    const manifest = globalThis.__ghrcDispatcherCore.checklistManifest($('checklist-text').value);
    await request({ type: 'import', manifest, repository: $('repository').value.trim() });
    $('checklist-text').value = '';
    await refresh();
    notice('Imported ' + manifest.tasks.length + ' incomplete checklist items. Start when ready.');
  } catch (error) { notice(error.message); }
});
$('start').addEventListener('click', () => action({ type: 'start' }));
$('pause').addEventListener('click', () => action({ type: 'pause' }));
$('prefer-codex-pony').addEventListener('change', () => action({ type: 'preferences', preferCodexPony: $('prefer-codex-pony').checked }));
$('replace-existing-drafts').addEventListener('change', () => action({ type: 'preferences', replaceExistingDrafts: $('replace-existing-drafts').checked }));
$('reset').addEventListener('click', () => action({ type: 'reset-pool' }));
$('export').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }));
  const link = el('a'); link.href = url; link.download = 'chat-dispatcher-session.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});

if (connected) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const currentKey = sessionId === 'legacy' ? 'chatDispatcherState' : `chatDispatcherState:${sessionId}`;
    const currentPauseKey = sessionId === 'legacy' ? 'chatDispatcherPaused' : `chatDispatcherPaused:${sessionId}`;
    if (changes[currentKey]) { state = changes[currentKey].newValue; render(); }
    if (changes[currentPauseKey] || changes.chatDispatcherSessionIds || Object.keys(changes).some(key =>
      key.startsWith('chatDispatcherState:') || key === 'chatDispatcherState')) {
      refresh().catch(error => notice(error.message));
    }
  });
} else {
  notice('Open the dispatcher from Flawless ChatGPT to bind chats and run it.');
}
refresh().catch(error => notice(error.message));
