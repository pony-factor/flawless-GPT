(() => {
  const PREFIX = 'researchLaunch:';
  let mutations = Promise.resolve();
  const serial = action => {
    const result = mutations.then(action);
    mutations = result.catch(() => {});
    return result;
  };
  const key = tabId => `${PREFIX}${tabId}`;
  const RECOVERY_KEY = 'researchLaunchRecovery';
  const activeImports = new Set();
  let recoveryWrites = Promise.resolve();
  const conversation = url => {
    try { const value = new URL(url); return value.origin === 'https://chatgpt.com' && value.pathname.startsWith('/c/') ? value.origin + value.pathname : null; }
    catch { return null; }
  };
  async function updateRecovery(tabId, job) {
    const result = recoveryWrites.then(async () => {
      const saved = (await chrome.storage.local.get(RECOVERY_KEY))[RECOVERY_KEY] || {};
      if (job?.conversationUrl) saved[tabId] = { ...job, prompt: undefined };
      else delete saved[tabId];
      await chrome.storage.local.set({ [RECOVERY_KEY]: saved });
    });
    recoveryWrites = result.catch(() => {});
    return result;
  }
  async function recover(tabId) {
    const saved = (await chrome.storage.local.get(RECOVERY_KEY))[RECOVERY_KEY]?.[tabId];
    if (!saved) return null;
    try {
      const tab = await chrome.tabs.get(tabId);
      // tabs.get omits ChatGPT URLs without a separate host grant; webNavigation
      // already has the permission needed to verify the top-level conversation.
      const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
      if (tab.windowId === saved.windowId && conversation(frame?.url) === saved.conversationUrl) return saved;
    } catch { /* Closed tabs cannot resume an old run. */ }
    await updateRecovery(tabId, null);
    return null;
  }
  async function get(tabId) {
    const existing = (await chrome.storage.session.get(key(tabId)))[key(tabId)];
    let job = existing || await recover(tabId);
    // A worker interrupted during publishing must retry the idempotent native import.
    if (job?.state === 'importing' && !activeImports.has(job.id)) job = { ...job, state: 'submitted' };
    if (job && job !== existing) await chrome.storage.session.set({ [key(tabId)]: job });
    return job || null;
  }
  async function put(job) {
    // Save the destination before exposing a submitted job to report frames.
    await updateRecovery(job.tabId, job);
    await chrome.storage.session.set({ [key(job.tabId)]: job });
    return job;
  }
  async function remove(tabId) {
    await updateRecovery(tabId, null);
    await chrome.storage.session.remove(key(tabId));
  }
  function chatSender(sender) {
    try { return sender.id === chrome.runtime.id && sender.frameId === 0
      && new URL(sender.url).origin === 'https://chatgpt.com' && Number.isInteger(sender.tab?.id); }
    catch { return false; }
  }
  function reportSender(sender) {
    try { return sender.id === chrome.runtime.id && Number.isInteger(sender.tab?.id)
      && /^(connector-openai-deep-research|mcp-app-[a-f0-9]+)\.web-sandbox\.oaiusercontent\.com$/.test(new URL(sender.origin || sender.url).hostname)
      && new URL(sender.tab.url).origin === 'https://chatgpt.com'; }
    catch { return false; }
  }
  function publicJob(job) {
    if (!job) return null;
    const { id, state, title, category, error, result, windowId, tabId, retryAt } = job;
    return { id, state, title, category, error, result, windowId, tabId, retryAt };
  }
  function categoryValid(category) {
    return typeof category === 'string' && category.length <= 240
      && (!category || category.split('/').every(part => part && !part.startsWith('.') && /^[\p{L}\p{N} _-]+$/u.test(part)));
  }

  // The report publisher calls these methods inside the same service worker.
  globalThis.__ghrcResearchLaunch = {
    get,
    async beginImport(sender, id) {
      return serial(async () => {
        const job = await get(sender.tab.id);
        if (!reportSender(sender) || !job || job.id !== id || !['submitted', 'import-retry'].includes(job.state)
          || (job.retryAt && job.retryAt > Date.now())
          || (job.conversationUrl && job.conversationUrl !== conversation(sender.tab.url)))
          throw new Error('This research run is not ready for automatic import.');
        activeImports.add(job.id);
        try { await put({ ...job, state: 'importing', retryAt: undefined, attempts: (job.attempts || 0) + 1 }); }
        catch (error) { activeImports.delete(job.id); throw error; }
        return job;
      });
    },
    async finishImport(tabId, id, result, error, retryable = false) {
      return serial(async () => {
        const job = await get(tabId);
        if (!job || job.id !== id) return;
        const retry = error && retryable && job.attempts < 3;
        await put({ ...job, state: error ? (retry ? 'import-retry' : 'import-error') : 'complete',
          retryAt: retry ? Date.now() + (job.attempts === 1 ? 5000 : 30000) : undefined, result, error });
        activeImports.delete(id);
      });
    },
  };

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!['start-research-launch', 'research-launch-job', 'claim-research-launch',
      'research-launch-sending', 'research-launch-submitted', 'research-launch-error',
      'research-launch-status'].includes(message?.type)) return false;
    (async () => {
      if (message.type === 'research-launch-job') {
        if (!chatSender(sender) && !reportSender(sender)) throw new Error('Open research in ChatGPT.');
        return serial(async () => {
          let job = await get(sender.tab.id);
          const url = conversation(sender.tab.url);
          if (job?.conversationUrl && job.conversationUrl !== url) return { ok: true, job: null };
          if (job && !job.conversationUrl && url && ['submitted', 'importing', 'import-retry'].includes(job.state))
            job = await put({ ...job, conversationUrl: url });
          return { ok: true, job: publicJob(job) };
        });
      }
      if (!chatSender(sender)) throw new Error('Launch research from a ChatGPT writing block.');
      if (message.type === 'research-launch-status') {
        return serial(async () => {
          const job = await get(message.tabId);
          if (!job || job.id !== message.id || job.sourceTabId !== sender.tab.id) return { ok: true, job: null };
          return { ok: true, job: publicJob(job) };
        });
      }
      if (message.type === 'start-research-launch') {
        if (typeof message.prompt !== 'string' || !message.prompt.trim()
          || new TextEncoder().encode(message.prompt).length > 512 * 1024
          || typeof message.title !== 'string' || message.title.length > 500
          || !categoryValid(message.category)) throw new Error('Invalid research prompt or category.');
        const settings = await chrome.storage.local.get({ researchPublisherEnabled: false });
        if (!settings.researchPublisherEnabled) throw new Error('Enable Deep research publisher and link a repository in settings first.');
        const connection = await globalThis.__ghrcResearchPublisher.checkConnection();
        if (message.repository !== connection.repository || message.branch !== connection.branch)
          throw new Error('The linked repository changed. Choose the import destination again.');
        const popup = await chrome.windows.create({ url: 'about:blank', type: 'popup', width: 560, height: 760, focused: true });
        const tabId = popup.tabs?.[0]?.id;
        if (!Number.isInteger(tabId)) throw new Error('Could not create the research window.');
        const job = { id: crypto.randomUUID(), tabId, windowId: popup.id, sourceTabId: sender.tab.id,
          prompt: message.prompt, title: message.title, category: message.category,
          repository: connection.repository, branch: connection.branch, state: 'pending', createdAt: Date.now() };
        try {
          await put(job);
          await chrome.tabs.update(tabId, { url: 'https://chatgpt.com/' });
        } catch (error) {
          await remove(tabId);
          await chrome.windows.remove(popup.id);
          throw error;
        }
        return { ok: true, job: publicJob(job) };
      }
      return serial(async () => {
        const job = await get(sender.tab.id);
        if (!job || (message.id && job.id !== message.id)) throw new Error('Research run not found.');
        if (message.type === 'claim-research-launch') {
          if (job.state !== 'pending') return { ok: true, job: publicJob(job) };
          await put({ ...job, state: 'preparing' });
          return { ok: true, job: { ...publicJob(job), state: 'preparing', prompt: job.prompt } };
        }
        if (message.type === 'research-launch-sending') {
          if (job.state !== 'preparing') throw new Error('This prompt was already submitted or interrupted.');
          await put({ ...job, state: 'sending' });
        } else if (message.type === 'research-launch-submitted') {
          if (job.state !== 'sending') throw new Error('No research submission is pending.');
          await put({ ...job, state: 'submitted', prompt: undefined, conversationUrl: conversation(sender.tab.url) });
        } else if (message.type === 'research-launch-error') {
          if (!['pending', 'preparing', 'sending'].includes(job.state)) return { ok: true };
          await put({ ...job, state: 'error', error: String(message.error || 'Research could not start.').slice(0, 500) });
        }
        return { ok: true };
      });
    })().then(respond, error => respond({ ok: false, error: error.message }));
    return true;
  });
  chrome.tabs.onRemoved.addListener(tabId => { void serial(() => remove(tabId)); });
  // Extension updates invalidate old report scripts. Refresh only known research runs.
  chrome.runtime.onInstalled?.addListener(() => {
    void (async () => {
      const saved = (await chrome.storage.local.get(RECOVERY_KEY))[RECOVERY_KEY] || {};
      for (const tabId of Object.keys(saved)) {
        const job = await serial(() => get(Number(tabId)));
        if (job && ['submitted', 'import-retry', 'complete'].includes(job.state)) await chrome.tabs.reload(job.tabId);
      }
    })().catch(error => console.warn('Could not resume research windows:', error.message));
  });
})();
