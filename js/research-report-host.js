(() => {
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== 'research-report-context') return false;
    const title = document.title.replace(/\s*[-–|]\s*ChatGPT\s*$/i, '').trim();
    const prompt = document.querySelector('[data-message-author-role="user"]')?.textContent.trim() || '';
    respond({ title: title && !/^(ChatGPT|New chat)$/i.test(title) ? title : prompt.slice(0, 2000) });
    return false;
  });
  const reports = new Map();
  const ATTRIBUTE = 'data-ghrc-research-fullscreen';
  function update() {
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
  }
  window.addEventListener('message', event => {
    if (!/^https:\/\/(connector-openai-deep-research|mcp-app-[a-f0-9]+)\.web-sandbox\.oaiusercontent\.com$/.test(event.origin)
      || event.data?.type !== 'ghrc-research-report-state') return;
    const frame = [...document.querySelectorAll('iframe')].find(node => node.contentWindow === event.source);
    if (!frame) return;
    reports.set(frame, event.data.report === true);
    update();
  });
  const style = document.createElement('style');
  style.textContent = `html[${ATTRIBUTE}] :is(form:has(#prompt-textarea), form:has([data-composer-markdown]), [data-type="unified-composer"], [data-composer-surface-variant], #ghrc-deep-research-tracker-composer, #ghrc-message-queue){visibility:hidden!important;pointer-events:none!important}`;
  (document.head || document.documentElement).append(style);
  new MutationObserver(update).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
  window.addEventListener('resize', update);
})();
