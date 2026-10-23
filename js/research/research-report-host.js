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
  const finalizedFrames = new WeakMap();
  const ATTRIBUTE = 'data-ghrc-research-fullscreen';
  let observer = null;
  let disposed = false;
  function stopMonitoring() {
    observer?.disconnect();
    observer = null;
    window.removeEventListener('resize', update);
  }
  function update() {
    if (disposed) return;
    let expanded = false;
    for (const [frame, state] of reports) {
      if (!frame.isConnected) { reports.delete(frame); continue; }
      const bounds = frame.getBoundingClientRect();
      let fixed = false;
      for (let node = frame.parentElement; node && node !== document.body; node = node.parentElement) {
        if (getComputedStyle(node).position === 'fixed') { fixed = true; break; }
      }
      if (state && (fixed || (bounds.width >= innerWidth * .8 && bounds.height >= innerHeight * .8))) expanded = true;
    }
    document.documentElement.toggleAttribute(ATTRIBUTE, expanded);
    // No report iframe means no document-wide observer or resize handler.
    if (!reports.size) {
      stopMonitoring();
    } else if (!observer) {
      observer = new MutationObserver(update);
      observer.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'],
      });
      window.addEventListener('resize', update);
    }
  }
  function onReportState(event) {
    if (!/^https:\/\/(connector-openai-deep-research|mcp-app-[a-f0-9]+)\\.web-sandbox\\.oaiusercontent\\.com$/.test(event.origin)
      || event.data?.type !== 'ghrc-research-report-state') return;
    const frame = [...document.querySelectorAll('iframe')].find(node => node.contentWindow === event.source);
    if (!frame) return;
    if (event.data.finalized === true) {
      // Ignore stale sandbox messages after Git/native publishing has succeeded.
      // A navigated iframe can host a new report and start a fresh lifecycle.
      finalizedFrames.set(frame, frame.src);
      reports.delete(frame);
    } else if (finalizedFrames.get(frame) === frame.src) {
      return;
    } else if (event.data.report === true) {
      reports.set(frame, true);
    } else {
      reports.delete(frame);
    }
    update();
  }
  window.addEventListener('message', onReportState);
  const style = document.createElement('style');
  style.textContent = `html[${ATTRIBUTE}] :is(form:has(#prompt-textarea), form:has([data-composer-markdown]), [data-type="unified-composer"], [data-composer-surface-variant], #ghrc-deep-research-tracker-composer, #ghrc-message-queue, #ghrc-research-run-status, #ghrc-manual-research-import-status){visibility:hidden!important;pointer-events:none!important}`;
  (document.head || document.documentElement).append(style);
  function dispose() {
    if (disposed) return;
    disposed = true;
    stopMonitoring();
    reports.clear();
    window.removeEventListener('message', onReportState);
    window.removeEventListener('pagehide', onPageHide);
    document.documentElement.removeAttribute(ATTRIBUTE);
    style.remove();
  }
  function onPageHide(event) {
    if (!event.persisted) dispose();
  }
  window.addEventListener('pagehide', onPageHide);
  context?.onStop?.(dispose);
})();
