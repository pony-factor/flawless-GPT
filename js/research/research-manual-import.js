(() => {
  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;
  const ARM_KEY = 'ghrc-manual-deep-research-first-turn';
  const MENTION = '[app-mention-path="app://connector_openai_deep_research"]';
  const BAR_ID = 'ghrc-manual-research-import-status';
  let enabled = false;
  let checking = false;
  let retryAt = 0;
  const composer = () => document.querySelector('[data-composer-markdown][contenteditable="true"], #prompt-textarea');
  const turns = () => {
    const explicit = document.querySelectorAll('[data-message-author-role="user"]');
    return explicit.length ? [...explicit] : [...document.querySelectorAll('[data-content-search-unit-key$=":user"]')];
  };
  function draftText(node) {
    if (!node) return '';
    if ('value' in node) return node.value;
    return node.innerText || node.textContent || '';
  }
  function armFirstTurn() {
    if (location.pathname !== '/' || turns().length) return;
    const input = composer();
    if (input?.querySelector(MENTION)) sessionStorage.setItem(ARM_KEY, String(Date.now()));
    else if (draftText(input).trim()) sessionStorage.removeItem(ARM_KEY);
  }
  function firstResearchMessage() {
    const first = turns();
    const armedAt = Number(sessionStorage.getItem(ARM_KEY));
    if (first.length !== 1 || !armedAt || Date.now() - armedAt > 3 * 60_000
      || !(/^\/c\//.test(location.pathname) || location.pathname === '/')) return null;
    return first[0].textContent.trim().slice(0, 500) || 'Deep Research';
  }
  function status(job) {
    if (job.state === 'complete' && job.result) return null;
    if (job.state === 'import-retry') return 'Import interrupted · retrying automatically…';
    if (job.error) return job.error;
    if (job.state === 'importing') return 'Adding completed research to the repository…';
    return 'Research import queued · ' + (job.category ? '/' + job.category : 'repository root');
  }
  function style() {
    if (document.getElementById('ghrc-manual-research-style')) return;
    const sheet = document.createElement('style');
    sheet.id = 'ghrc-manual-research-style';
    sheet.textContent = '#ghrc-manual-research-import-status{position:fixed;right:16px;bottom:88px;z-index:9998;display:flex;align-items:center;gap:10px;max-width:min(420px,calc(100vw - 32px));box-sizing:border-box;padding:9px 12px;border:1px solid #8886;border-radius:10px;background:light-dark(#fff,#202123);color:light-dark(#111,#fff);box-shadow:0 3px 16px #0002;font:12px/1.4 system-ui;overflow-wrap:anywhere}#ghrc-manual-research-import-status .ghrc-manual-label{min-width:0}#ghrc-manual-research-import-status button{white-space:nowrap;border:1px solid #8886;border-radius:6px;background:transparent;color:inherit;padding:5px 8px;cursor:pointer}#ghrc-manual-research-import-status button[hidden]{display:none}';
    (document.head || document.documentElement).append(sheet);
  }
  function position(bar) {
    const form = composer()?.closest('form') || document.querySelector('[data-type="unified-composer"]');
    const top = form?.getBoundingClientRect().top;
    bar.style.bottom = top > 0 && top < innerHeight
      ? Math.max(12, Math.ceil(innerHeight - top + 8)) + 'px' : '88px';
  }
  async function request(message) {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || 'Research publisher unavailable.');
    return result;
  }
  function render(job) {
    if (!document.body) return;
    style();
    let bar = document.getElementById(BAR_ID);
    if (!bar) {
      bar = document.createElement('div');
      bar.id = BAR_ID;
      bar.setAttribute('role', 'status');
      bar.setAttribute('aria-live', 'polite');
      const label = document.createElement('span');
      label.className = 'ghrc-manual-label';
      const move = document.createElement('button');
      move.type = 'button';
      move.textContent = 'Move…';
      move.setAttribute('aria-label', 'Change research import folder');
      move.addEventListener('click', event => {
        if (!event.isTrusted || move.disabled) return;
        void context.run(async () => {
          move.disabled = true;
          try {
            const current = (await request({ type: 'research-launch-job' })).job;
            if (!current?.manual || !['submitted', 'import-retry'].includes(current.state))
              throw new Error('This report is already importing.');
            const connection = await request({ type: 'research-publisher-status' });
            if (connection.repository !== current.repository || connection.branch !== current.branch)
              throw new Error('The linked repository changed during this research.');
            const category = await globalThis.__ghrcChooseResearchCategory(document, connection, 'move');
            if (category === null) return;
            const changed = await request({ type: 'set-research-launch-category', id: current.id, category });
            render(changed.job);
          } catch (error) { label.textContent = error.message; }
          finally { move.disabled = false; }
        });
      });
      bar.append(label, move);
      document.body.append(bar);
    }
    const label = bar.querySelector('.ghrc-manual-label');
    const move = bar.querySelector('button');
    if (job.state === 'complete' && job.result) globalThis.__ghrcResearchImportStatus(label, job.result);
    else if (label.textContent !== status(job)) label.textContent = status(job);
    move.hidden = !['submitted', 'import-retry'].includes(job.state);
    position(bar);
  }
  async function poll() {
    if (checking || !context.active() || !document.body) return;
    checking = true;
    try {
      armFirstTurn();
      if (!enabled) {
        document.getElementById(BAR_ID)?.remove();
        return;
      }
      const first = firstResearchMessage();
      const bar = document.getElementById(BAR_ID);
      if (!first && !bar && turns().length !== 1) return;
      let { job } = await request({ type: 'research-launch-job' });
      if (!job && first && Date.now() >= retryAt) {
        try {
          ({ job } = await request({ type: 'start-manual-research', title: first }));
          sessionStorage.removeItem(ARM_KEY);
          retryAt = 0;
        } catch (error) {
          retryAt = Date.now() + 10_000;
          render({ state: 'import-error', error: error.message });
        }
      }
      if (job?.manual) {
        sessionStorage.removeItem(ARM_KEY);
        render(job);
      } else if (!first) document.getElementById(BAR_ID)?.remove();
    } catch (error) {
      if (document.getElementById(BAR_ID) || firstResearchMessage())
        render({ state: 'import-error', error: error.message });
    } finally { checking = false; }
  }
  chrome.storage.local.get({ researchPublisherEnabled: false }).then(settings => {
    enabled = settings.researchPublisherEnabled === true;
    void context.run(poll);
  }).catch(() => {});
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === 'local' && changes.researchPublisherEnabled) {
      enabled = changes.researchPublisherEnabled.newValue === true;
      void context.run(poll);
    }
  });
  const observer = new MutationObserver(() => { if (context.active()) armFirstTurn(); });
  observer.observe(document, { childList: true, subtree: true });
  const timer = setInterval(() => { void context.run(poll); }, 1500);
  context.onStop(() => { observer.disconnect(); clearInterval(timer); });
  void context.run(poll);
})();
