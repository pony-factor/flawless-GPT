(() => {
  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;
  const BUTTON = 'ghrc-research-writing-block';
  const runs = new Map();
  let mounting = false;
  let polling = false;
  let handoffChecked = false;
  let handoffStarted = false;
  let activeRun = null;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const composer = () => document.querySelector('[data-composer-markdown][contenteditable="true"], #prompt-textarea');
  function composerText(input) {
    if (!input) return '';
    if (input instanceof HTMLTextAreaElement) return input.value;
    const read = node => {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
      if (node.nodeName === 'BR') return node.classList.contains('ProseMirror-trailingBreak') ? '' : '\n';
      return [...node.childNodes].map(read).join('');
    };
    const paragraphs = [...input.children];
    if (paragraphs.length && paragraphs.every(node => node.tagName === 'P'))
      return paragraphs.map(node => node.childNodes.length === 1 && node.firstChild.nodeName === 'BR' ? '' : read(node)).join('\n');
    return input.innerText || input.textContent || '';
  }
  const userTurns = () => document.querySelectorAll('[data-message-author-role="user"], [data-content-search-unit-key$=":user"]').length;
  const visible = node => Boolean(node?.getClientRects().length);
  const stopped = () => [...document.querySelectorAll('button[data-testid="stop-button"], button[aria-label="Stop" i], button[aria-label*="Stop generating" i]')].some(visible);
  async function request(message) {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || 'Research launcher unavailable.');
    return result;
  }
  function setStatus(node, text) { if (node.textContent !== text) node.textContent = text; }
  function statusFor(job) {
    if (!job) return 'Research window closed before import finished.';
    if (job.state === 'complete') return `Imported: ${job.result.repository} / ${job.result.path} (${job.result.branch}).`;
    if (job.error) return job.error;
    return ({ pending: 'Opening research…', preparing: 'Preparing Deep Research…', sending: 'Submitting research…',
      submitted: 'Research running. Answer any follow-up questions in the research window.', importing: 'Importing completed report…' })[job.state] || 'Research needs attention in its window.';
  }
  function windowStatus(job) {
    let banner = document.getElementById('ghrc-research-run-status');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'ghrc-research-run-status';
      banner.setAttribute('role', 'status');
      document.body.append(banner);
    }
    if (job?.state === 'complete') globalThis.__ghrcResearchImportStatus(banner, job.result);
    else setStatus(banner, statusFor(job));
  }
  function mount() {
    if (!context.active() || !document.body) return;
    if (!document.getElementById('ghrc-research-launch-style')) {
      const style = document.createElement('style');
      style.id = 'ghrc-research-launch-style';
      style.textContent = `.${BUTTON}{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;padding:8px;border:0;border-radius:50%;background:transparent;color:inherit;cursor:pointer}.${BUTTON}:hover{background:color-mix(in srgb,currentColor 10%,transparent)}.${BUTTON}:disabled{opacity:.5;cursor:default}.${BUTTON}:focus-visible{outline:2px solid currentColor;outline-offset:2px}.ghrc-research-launch-status{font:12px/1.4 system-ui;margin:0 12px 8px;overflow-wrap:anywhere}.ghrc-research-launch-status:empty{display:none}#ghrc-research-run-status{position:fixed;z-index:9999;top:0;left:0;right:0;padding:8px 12px;background:light-dark(#fff,#202123);color:light-dark(#111,#fff);border-bottom:1px solid #888;font:12px/1.4 system-ui;pointer-events:none}.ghrc-report-import{color:inherit;background:light-dark(#fff,#202123);border:1px solid #888;border-radius:12px;padding:24px;max-width:420px;width:calc(100% - 64px);color-scheme:light dark}.ghrc-report-import::backdrop{background:#0008}.ghrc-report-import h2{margin-top:0;font-size:20px}.ghrc-report-import p{font-size:13px}.ghrc-report-import input{display:block;box-sizing:border-box;width:100%;padding:10px;margin-top:8px}.ghrc-report-import form>div{display:flex;justify-content:flex-end;gap:12px;margin-top:20px}.ghrc-report-import button{padding:8px 12px;cursor:pointer}`;
      document.head.append(style);
    }
    for (const block of document.querySelectorAll('[data-oai-writing-block-surface][data-markdown-copy-text]')) {
      const header = block.querySelector('header');
      const copy = header?.querySelector('button[aria-label="Copy"]');
      if (!copy || !header.querySelector('button[aria-label="Open editor"]') || block.querySelector(`.${BUTTON}`)) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = BUTTON;
      button.title = 'Run Deep Research and import the finished report';
      button.setAttribute('aria-label', 'Research and import');
      const icon = document.createElement('img');
      icon.src = chrome.runtime.getURL('artwork/research-telescope.png');
      icon.alt = '';
      icon.width = icon.height = 20;
      button.append(icon);
      const status = document.createElement('div');
      status.className = 'ghrc-research-launch-status';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      header.after(status);
      const anchor = copy.parentElement.matches('span.contents') ? copy.parentElement : copy;
      anchor.before(button);
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        if (!event.isTrusted || button.disabled) return;
        void context.run(async () => {
          button.disabled = true;
          try {
            const prompt = block.getAttribute('data-markdown-copy-text');
            if (!prompt?.trim()) throw new Error('This writing block has no research prompt yet.');
            setStatus(status, 'Checking repository connection…');
            const connection = await request({ type: 'research-publisher-status' });
            setStatus(status, '');
            const category = await globalThis.__ghrcChooseResearchCategory(document, connection, true);
            if (category === null) return;
            const title = header.querySelector('button[aria-label="Add to Library"]')?.textContent.trim()
              || header.textContent.trim() || 'Deep Research';
            const { job } = await request({ type: 'start-research-launch', prompt, title: title.slice(0, 500), category,
              repository: connection.repository, branch: connection.branch });
            runs.set(job.id, { job, button, status });
            setStatus(status, statusFor(job));
          } catch (error) { setStatus(status, error.message); }
          finally { if (![...runs.values()].some(run => run.button === button)) button.disabled = false; }
        });
      });
    }
  }
  function schedule() {
    if (mounting || !context.active()) return;
    mounting = true;
    setTimeout(() => { mounting = false; mount(); }, 0);
  }
  async function waitUntil(test, timeout = 20_000) {
    const deadline = Date.now() + timeout;
    while (context.active() && Date.now() < deadline) {
      const value = test();
      if (value) return value;
      await pause(100);
    }
    throw new Error('ChatGPT was not ready. Continue in the research window.');
  }
  async function launchPrompt(job) {
    const input = await waitUntil(() => visible(composer()) && composer());
    if (location.pathname !== '/' || userTurns() || composerText(input).trim())
      throw new Error('The research window already has a draft or conversation; it was preserved.');
    input.focus();
    const transfer = new DataTransfer();
    transfer.setData('text/plain', 'Deep research');
    transfer.setData('text/html', '<p><span app-mention-name="deep-research" app-mention-display-name="Deep research" app-mention-path="app://connector_openai_deep_research" app-mention-icon="/images/ecosystem/apps/deep_research_app/icon.png" app-mention-brand-color="" data-prompt-link-href="app://connector_openai_deep_research" data-prompt-link-label="$deep-research" contenteditable="false">Deep research</span> </p>');
    input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    await waitUntil(() => input.querySelector('[app-mention-path="app://connector_openai_deep_research"]'));
    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('insertText', false, '\n' + job.prompt);
    await pause(100);
    if (input !== composer() || !composerText(input).replace(/\r\n/g, '\n').trimEnd().endsWith(job.prompt.trimEnd())
      || !input.querySelector('[app-mention-path="app://connector_openai_deep_research"]'))
      throw new Error('The full research prompt could not be restored. It was not sent.');
    const send = await waitUntil(() => {
      const form = input.closest('form') || input.closest('[data-type="unified-composer"]');
      return [...(form?.querySelectorAll('button[data-testid="send-button"],button[aria-label="Send" i],button[aria-label="Send prompt" i]') || [])]
        .find(button => visible(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true');
    });
    await request({ type: 'research-launch-sending', id: job.id });
    if (input !== composer() || !composerText(input).trimEnd().endsWith(job.prompt.trimEnd())
      || !input.querySelector('[app-mention-path="app://connector_openai_deep_research"]'))
      throw new Error('The research draft changed before sending. Your changes were preserved.');
    send.click();
    await waitUntil(() => userTurns() > 0, 10_000);
    await request({ type: 'research-launch-submitted', id: job.id });
  }
  async function poll() {
    if (polling || !context.active()) return;
    polling = true;
    try {
      for (const [id, run] of runs) {
        const { job } = await request({ type: 'research-launch-status', id, tabId: run.job.tabId });
        if (job?.state === 'complete') globalThis.__ghrcResearchImportStatus(run.status, job.result);
        else setStatus(run.status, statusFor(job));
        if (!job || ['complete', 'error', 'import-error'].includes(job.state)) {
          run.button.disabled = false;
          runs.delete(id);
        }
      }
      if (!handoffChecked || activeRun) {
        const { job } = await request({ type: 'research-launch-job' });
        handoffChecked = true;
        activeRun = job;
        if (job) {
          windowStatus(job);
          if (job.state === 'pending' && !handoffStarted) {
            handoffStarted = true;
            const claimed = (await request({ type: 'claim-research-launch', id: job.id })).job;
            if (claimed?.prompt) {
              try { await launchPrompt(claimed); }
              catch (error) { await request({ type: 'research-launch-error', id: job.id, error: error.message }); }
            }
          } else if (job.state === 'sending' && userTurns() > 0) {
            // Navigation after Send can replace the original content script before acknowledgement.
            await request({ type: 'research-launch-submitted', id: job.id });
          } else if (job.state === 'preparing' && !handoffStarted) {
            windowStatus({ error: 'Preparation was interrupted. Your draft is preserved; continue in this window.' });
          }
        }
      }
    } finally { polling = false; }
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== 'research-launch-readiness') return false;
    respond({ ready: Boolean(activeRun && activeRun.id === message.id && userTurns() > 0 && !stopped()) });
    return false;
  });
  const observer = new MutationObserver(schedule);
  observer.observe(document, { childList: true, subtree: true });
  const timer = setInterval(() => { void context.run(poll); }, 1000);
  context.onStop(() => { observer.disconnect(); clearInterval(timer); });
  schedule();
  void context.run(poll);
})();
