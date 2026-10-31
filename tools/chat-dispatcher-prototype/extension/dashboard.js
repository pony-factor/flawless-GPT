const connected = Boolean(globalThis.chrome?.runtime?.id);
const $ = id => document.getElementById(id);
let state = { paused: true, tasks: [], workers: [], events: [] };
let availableTabs = [];
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const notice = text => { $('notice').textContent = text; $('notice').hidden = !text; };
async function request(message) {
  if (!connected) throw Error('Preview only. Load the extension in Brave to connect your chats.');
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw Error(response?.error || 'The dispatcher did not respond.');
  return response;
}
async function action(message) {
  try { await request(message); notice(''); await refresh(); } catch (error) { notice(error.message); }
}

function render() {
  $('run-status').textContent = state.paused ? 'Paused' : 'Running';
  $('run-status').classList.toggle('live', !state.paused);
  $('repository').value = state.repository || 'PDF-magic/opener';
  $('repository').disabled = !state.paused;
  $('manifest').disabled = !state.paused || !connected;
  $('start').disabled = !connected || !state.paused || state.workers.length !== 10;
  $('pause').disabled = !connected || state.paused;
  $('choose-tabs').disabled = !connected || !state.paused || state.workers.length > 0;
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
    card.append(el('p', worker ? worker.activity || worker.phase.replaceAll('-', ' ') : 'Choose an existing chat to begin.'));
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
    const row = el('li'); const time = el('time', new Date(event.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })); time.dateTime = event.time;
    row.append(time, document.createTextNode(event.text)); $('events').append(row);
  }
}

async function refresh() {
  if (connected) state = (await request({ type: 'state' })).state;
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
$('start').addEventListener('click', () => action({ type: 'start' }));
$('pause').addEventListener('click', () => action({ type: 'pause' }));
$('reset').addEventListener('click', () => action({ type: 'reset-pool' }));
$('export').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }));
  const link = el('a'); link.href = url; link.download = 'chat-dispatcher-session.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('choose-tabs').addEventListener('click', async () => {
  try {
    availableTabs = (await request({ type: 'tabs' })).tabs;
    $('tab-list').replaceChildren();
    for (const tab of availableTabs) {
      const row = el('label', undefined, 'tab-option');
      const check = el('input'); check.type = 'checkbox'; check.value = String(tab.id);
      const title = el('span', tab.title); title.append(el('small', `Window ${tab.windowId} · ${tab.url}`));
      const task = el('input'); task.type = 'text'; task.placeholder = 'Current task ID'; task.setAttribute('aria-label', `Current task for ${tab.title}`);
      task.value = state.workerHints?.find(hint => hint.url === tab.url || `https://${hint.url}` === tab.url)?.task || '';
      task.dataset.tabId = tab.id;
      check.addEventListener('change', () => { $('selected-count').textContent = `${$('tab-list').querySelectorAll('input[type="checkbox"]:checked').length} selected`; });
      row.append(check, title, task); $('tab-list').append(row);
    }
    $('selected-count').textContent = '0 selected';
    $('tab-dialog').showModal();
  } catch (error) { notice(error.message); }
});
$('bind').addEventListener('click', async () => {
  const tabIds = [...$('tab-list').querySelectorAll('input[type="checkbox"]:checked')].map(input => Number(input.value));
  const assignments = Object.fromEntries([...$('tab-list').querySelectorAll('input[data-tab-id]')].map(input => [input.dataset.tabId, input.value.trim()]).filter(([, value]) => value));
  try { await request({ type: 'bind', tabIds, assignments }); $('tab-dialog').close(); notice(''); await refresh(); } catch (error) { notice(error.message); }
});

if (connected) {
  $('extension-id').textContent = chrome.runtime.id;
  $('setup-command').textContent = `npm start -- --repo PDF-magic/opener --extension-id ${chrome.runtime.id}`;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.dispatcher) { state = changes.dispatcher.newValue; render(); }
    if (changes.dispatcherPaused) refresh().catch(error => notice(error.message));
  });
} else {
  notice('Dashboard preview. Load the extension connector in Brave to bind chats and run the dispatcher.');
  $('choose-tabs').disabled = true;
}
refresh().catch(error => notice(error.message));
