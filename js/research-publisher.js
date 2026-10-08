(() => {
  const BUTTON = 'ghrc-add-research-report';
  const PAGE = '[class*="_reportPage_"]';
  const MAX_BYTES = 4 * 1024 * 1024;
  const documents = new WeakSet();
  let enabled = false;
  let scheduled = false;
  let frameTimer;
  let automaticBusy = false;
  const reportCandidates = new WeakMap();
  const RELOAD_MESSAGE = 'The extension was updated. Reload this ChatGPT page to reconnect and retry the import.';
  async function request(message) {
    if (!globalThis.chrome?.runtime?.sendMessage) {
      clearInterval(frameTimer);
      throw new Error(RELOAD_MESSAGE);
    }
    try { return await chrome.runtime.sendMessage(message); }
    catch (error) {
      if (/extension context invalidated/i.test(error?.message || '')) {
        clearInterval(frameTimer);
        throw new Error(RELOAD_MESSAGE);
      }
      throw error;
    }
  }

  async function autoImport(doc) {
    if (!enabled || automaticBusy) return;
    const download = doc.querySelector('button[aria-label="Export"], button[aria-label="Download"]');
    const scope = download && reportScope(download);
    if (!scope || scope.querySelector('[aria-busy="true"], [role="progressbar"]') || download.disabled) return;
    automaticBusy = true;
    try {
      const { job } = await request({ type: 'research-launch-job' }) || {};
      const status = scope.querySelector('.ghrc-report-status');
      if (job?.state === 'complete' && job.result) {
        if (status) globalThis.__ghrcResearchImportStatus(status, job.result);
        const button = scope.querySelector('.' + BUTTON);
        if (button) {
          button.setAttribute('aria-label', 'Report added to repo');
          button.title = `Added to ${job.result.repository} (${job.result.branch})`;
        }
        return;
      }
      if (!['submitted', 'import-retry'].includes(job?.state)) return;
      if (job.state === 'import-retry' && status && status.textContent !== 'Import interrupted. Retrying automatically…')
        status.textContent = 'Import interrupted. Retrying automatically…';
      if (job.retryAt && job.retryAt > Date.now()) return;
      const report = reportPayload(scope);
      const previous = reportCandidates.get(scope);
      if (!previous || previous.markdown !== report.markdown) {
        reportCandidates.set(scope, { markdown: report.markdown, since: Date.now() });
        return;
      }
      if (Date.now() - previous.since < 5000) return;
      const result = await request({ type: 'publish-research-report', ...report, automationJobId: job.id });
      if (!result?.ok) {
        const status = scope.querySelector('.ghrc-report-status');
        if (status) status.textContent = result?.error || 'Automatic import could not finish. Use Add to repo to retry.';
      } else {
        const status = scope.querySelector('.ghrc-report-status');
        if (status) globalThis.__ghrcResearchImportStatus(status, result);
      }
    } catch (error) {
      if (error.message === RELOAD_MESSAGE) {
        const status = scope.querySelector('.ghrc-report-status');
        if (status && status.textContent !== RELOAD_MESSAGE) status.textContent = RELOAD_MESSAGE;
      }
      // Partial reports and replaced sandbox documents are revisited by the next scan.
    } finally { automaticBusy = false; }
  }

  function publisherAvailable() {
    return enabled;
  }

  function reportScope(download) {
    // The export control and paginated report share a card ancestor.
    for (let node = download.parentElement; node && node !== download.ownerDocument.body; node = node.parentElement) {
      if (node.querySelector(PAGE)) return node;
    }
    return null;
  }

  function reportPayload(scope) {
    const pages = [...scope.querySelectorAll(PAGE)];
    const title = pages[0]?.querySelector('h1')?.textContent.trim();
    if (!title || !pages.length) throw new Error('The complete report is not ready yet. Try again after it finishes.');
    const root = scope.ownerDocument.createElement('div');
    pages.forEach((page) => root.append(page.cloneNode(true)));
    root.querySelectorAll('script, style, button, [aria-hidden="true"]').forEach((node) => node.remove());
    const converter = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
    converter.use(turndownPluginGfm.gfm);
    const links = new Set();
    converter.addRule('report-links', {
      filter: 'a',
      replacement(content, node) {
        const raw = node.getAttribute('href');
        if (!raw) return content;
        let url;
        try { url = new URL(raw, scope.ownerDocument.URL); } catch { return content; }
        if (!['https:', 'http:'].includes(url.protocol)) return content;
        if (links.has(url.href)) return content === url.href ? '' : content;
        links.add(url.href);
        if (url.hostname === 'github.com') return url.href;
        return `[${content || url.hostname}](${url.href.replace(/\(/g, '%28').replace(/\)/g, '%29')})`;
      },
    });
    const markdown = converter.turndown(root).trim() + '\n';
    if (new TextEncoder().encode(markdown).length > MAX_BYTES) throw new Error('This report is too large to publish through the extension.');
    return { title, markdown };
  }

  function mount(doc) {
    if (!doc.documentElement) return;
    if (!documents.has(doc.documentElement)) {
      documents.add(doc.documentElement);
      const style = doc.createElement('style');
      style.textContent = `.${BUTTON}{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;width:32px;height:32px;padding:6px;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer}.${BUTTON}:hover{background:color-mix(in srgb,currentColor 10%,transparent)}.${BUTTON}:focus-visible{outline:2px solid currentColor;outline-offset:2px}.${BUTTON}:disabled{opacity:.55;cursor:default}.ghrc-report-status{font-size:12px;line-height:1.4;padding:6px 12px;overflow-wrap:anywhere}.ghrc-report-status:empty{display:none}`;
      style.textContent += '.ghrc-report-import{color:inherit;background:light-dark(#fff,#202123);border:1px solid #888;border-radius:12px;padding:24px;max-width:420px;width:calc(100% - 64px);color-scheme:light dark}.ghrc-report-import::backdrop{background:#0008}.ghrc-report-import h2{margin-top:0;font-size:20px}.ghrc-report-import p{font-size:13px}.ghrc-report-import input{display:block;box-sizing:border-box;width:100%;padding:10px;margin-top:8px}.ghrc-report-import form>div{display:flex;justify-content:flex-end;gap:12px;margin-top:20px}.ghrc-report-import button{padding:8px 12px;cursor:pointer}';
      (doc.head || doc.documentElement).append(style);
      new MutationObserver(schedule).observe(doc, { childList: true, subtree: true });
      doc.addEventListener('load', schedule, true);
      doc.addEventListener('click', async event => {
        const link = event.target.closest?.('a[href]');
        if (!event.isTrusted || !link?.closest(PAGE) || event.button !== 0 || event.altKey) return;
        let url;
        try { url = new URL(link.getAttribute('href'), doc.URL); } catch { return; }
        if (!['https:', 'http:'].includes(url.protocol) || url.origin === new URL(doc.URL).origin) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        try {
          const result = await request({ type: 'open-research-link', url: url.href });
          if (!result?.ok) throw new Error(result?.error || 'Could not open report link.');
        } catch (error) {
          const status = link.closest(PAGE).parentElement.querySelector('.ghrc-report-status');
          if (status) status.textContent = error.message;
        }
      }, true);
    }
    window.top.postMessage({ type: 'ghrc-research-report-state', report: Boolean(doc.querySelector(PAGE)) }, 'https://chatgpt.com');
    if (!publisherAvailable()) {
      doc.querySelectorAll(`.${BUTTON}, .ghrc-report-status`).forEach((node) => node.remove());
    } else {
      for (const download of doc.querySelectorAll('button[aria-label="Export"], button[aria-label="Download"]')) {
        const scope = reportScope(download);
        if (!scope) continue;
        // Export is inside a popover wrapper; insert before that wrapper in its flex row.
        const anchor = !download.parentElement.querySelector('button[aria-label="Expand"], button[aria-label="Collapse"]') ? download.parentElement : download;
        const row = anchor.parentElement;
        if (row.querySelector(`.${BUTTON}`)) continue;
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = BUTTON;
        button.title = 'Import report into a repository category';
        button.setAttribute('aria-label', 'Add to repo');
        button.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9M7 3v18M10 7h3M18 9v10M13 14h10"/></svg>';
        const status = doc.createElement('div');
        status.className = 'ghrc-report-status';
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        scope.append(status);
        button.addEventListener('click', async (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!event.isTrusted || !enabled || button.disabled) return;
          button.disabled = true;
          button.setAttribute('aria-busy', 'true');
          status.textContent = 'Checking repository connection…';
          try {
            const connection = await request({ type: 'research-publisher-status' });
            if (!connection?.ok) throw new Error(connection?.error || 'Use Link repository in extension settings to connect a repository.');
            status.textContent = '';
            const category = await globalThis.__ghrcChooseResearchCategory(doc, connection);
            if (category === null) return;
            const report = reportPayload(scope);
            status.textContent = 'Adding report to repository…';
            const result = await request({ type: 'publish-research-report', ...report, category });
            if (!result?.ok) throw new Error(result?.error || 'Publishing failed. Try again.');
            button.title = `${result.unchanged ? 'Already in' : 'Added to'} ${result.repository} (${result.branch})`;
            button.setAttribute('aria-label', 'Report added to repo');
            globalThis.__ghrcResearchImportStatus(status, result);
          } catch (error) {
            status.textContent = error.message || 'Connection unavailable. Reload this page and try again.';
            button.disabled = false;
          } finally { button.disabled = false; button.removeAttribute('aria-busy'); }
        });
        row.insertBefore(button, anchor);
      }
    }
    for (const frame of doc.querySelectorAll('iframe')) {
      try { if (frame.contentDocument?.documentElement) mount(frame.contentDocument); } catch { /* Cross-origin frames have their own content script. */ }
    }
    void autoImport(doc);
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; mount(document); }, 0);
  }

  function updateEnabled(value) {
    enabled = Boolean(value);
    clearInterval(frameTimer);
    // The sandbox can document.open() an existing inner frame, replacing its observers.
    // Revisit it so document replacement and delayed report loads recover.
    frameTimer = setInterval(schedule, 1000);
    schedule();
  }

  chrome.storage.local.get({ researchPublisherEnabled: false }).then((settings) => {
    updateEnabled(settings.researchPublisherEnabled);
  }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.researchPublisherEnabled) {
      updateEnabled(changes.researchPublisherEnabled.newValue);
      return;
    }

  });
  // Report links and fullscreen state work independently of the publishing preference.
  if (!frameTimer) frameTimer = setInterval(schedule, 1000);
  schedule();
})();
