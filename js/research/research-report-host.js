(() => {
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== 'research-report-context') return false;
    const title = document.title.replace(/\s*[-–|]\s*ChatGPT\s*$/i, '').trim();
    const frames = [...document.querySelectorAll('iframe')].filter(node =>
      /^https:\/\/(connector-openai-deep-research|mcp-app-[a-f0-9]+)\.web-sandbox\.oaiusercontent\.com(?:\/|$)/.test(node.src)
      && node.getBoundingClientRect().width > 0);
    const frame = frames.find(node => typeof message.reportUrl === 'string'
      && node.src.split('#')[0] === message.reportUrl.split('#')[0]) || frames.at(-1);
    const prompts = [...document.querySelectorAll('[data-message-author-role="user"]')];
    const preceding = frame ? prompts.filter(node => node.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING) : prompts;
    const prompt = preceding.at(-1)?.textContent.trim() || '';
    respond({ title: title && !/^(ChatGPT|New chat)$/i.test(title) ? title : prompt.slice(0, 2000), prompt: prompt.slice(0, 2000) });
    return false;
  });
  const context = globalThis.__ghrcExtensionContext;
  if (context && !context.active()) return;
  const reports = new Map();
  const finalized = new WeakMap();
  const ATTRIBUTE = 'data-ghrc-research-fullscreen';
  const REPORT_ORIGIN = /^https:\/\/(connector-openai-deep-research|mcp-app-[a-f0-9]+)\.web-sandbox\.oaiusercontent\.com$/;
  let observer = null;
  let scheduled = false;

  // No full-document observer runs on ChatGPT tabs without active report frames.
  function stopObserving() {
    observer?.disconnect();
    observer = null;
    window.removeEventListener('resize', schedule);
  }
  function update() {
    scheduled = false;
    if (context && !context.active()) return;
    let expanded = false;
    for (const frame of reports.keys()) {
      if (!frame.isConnected) { reports.delete(frame); continue; }
      const bounds = frame.getBoundingClientRect();
      let fixed = false;
      for (let node = frame.parentElement; node && node !== document.body; node = node.parentElement) {
        if (getComputedStyle(node).position === 'fixed') { fixed = true; break; }
      }
      if (fixed || (bounds.width >= innerWidth * .8 && bounds.height >= innerHeight * .8)) expanded = true;
    }
    document.documentElement.toggleAttribute(ATTRIBUTE, expanded);
    if (!reports.size) stopObserving();
  }
  function schedule() {
    if (scheduled || (context && !context.active())) return;
    scheduled = true;
    requestAnimationFrame(update);
  }
  function relevantMutation(mutation) {
    for (const frame of reports.keys()) {
      if (!frame.isConnected) return true;
      if (mutation.target === frame || mutation.target.contains?.(frame)) return true;
      if (mutation.type === 'childList' && [...mutation.addedNodes, ...mutation.removedNodes]
        .some(node => node === frame || node.contains?.(frame))) return true;
    }
    return false;
  }
  function startObserving() {
    if (observer || !reports.size) return;
    observer = new MutationObserver(mutations => {
      if (mutations.some(relevantMutation)) schedule();
    });
    observer.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'],
    });
    window.addEventListener('resize', schedule);
  }
  function handleReportMessage(event) {
    if (context && !context.active()) return;
    if (!REPORT_ORIGIN.test(event.origin) || ![
      'ghrc-research-report-state', 'ghrc-research-report-finalized',
    ].includes(event.data?.type)) return;
    const frame = [...document.querySelectorAll('iframe')].find(node => node.contentWindow === event.source);
    if (!frame) return;
    if (event.data.type === 'ghrc-research-report-finalized') {
      // A successful native publish confirms the report is saved to the repo.
      // Repeated report-state pings must not recreate this observer.
      finalized.set(frame, frame.src);
      reports.delete(frame);
    } else if (event.data.report !== true) {
      reports.delete(frame);
    } else if (finalized.get(frame) !== frame.src) {
      reports.set(frame, true);
      startObserving();
    }
    update();
  }
  const style = document.createElement('style');
  style.textContent = `html[${ATTRIBUTE}] :is(form:has(#prompt-textarea), form:has([data-composer-markdown]), [data-type="unified-composer"], [data-composer-surface-variant], #ghrc-deep-research-tracker-composer, #ghrc-message-queue, #ghrc-research-run-status, #ghrc-manual-research-import-status){visibility:hidden!important;pointer-events:none!important}`;
  (document.head || document.documentElement).append(style);
  window.addEventListener('message', handleReportMessage);
  function cleanup() {
    reports.clear();
    stopObserving();
    document.documentElement.removeAttribute(ATTRIBUTE);
  }
  window.addEventListener('pagehide', cleanup);
  context?.onStop(() => {
    cleanup();
    window.removeEventListener('message', handleReportMessage);
    window.removeEventListener('pagehide', cleanup);
    style.remove();
  });
})();
