(() => {
  function reportSender(sender) {
    const host = new URL(sender.origin || sender.url).hostname;
    return /^(connector-openai-deep-research|mcp-app-[a-f0-9]+)\.web-sandbox\.oaiusercontent\.com$/.test(host)
      && new URL(sender.tab?.url).origin === 'https://chatgpt.com';
  }
  const HOST = 'org.research.publisher';
  const CONNECTION_KEY = 'researchPublisherConnection';
  const inFlight = new Set();

  function connectionState(result) {
    if (!result?.ok) return { ok: false, checkedAt: Date.now() };
    return {
      ok: true,
      repository: typeof result.repository === 'string' ? result.repository : '',
      branch: typeof result.branch === 'string' ? result.branch : '',
      categories: Array.isArray(result.categories) ? result.categories : [],
      checkedAt: Date.now(),
    };
  }

  async function recordConnection(result) {
    try {
      await chrome.storage.local.set({ [CONNECTION_KEY]: connectionState(result) });
    } catch {
      // Connection state is only UI synchronization; the native response remains authoritative.
    }
  }

  function connectionError(error) {
    const detail = typeof error?.message === 'string' ? error.message.trim() : '';
    return new Error(
      `${detail ? `Connection unavailable: ${detail}.` : 'Connection unavailable.'} `
      + 'Use Link repository in extension settings to install or update the bridge.',
    );
  }

  async function sendToNative(payload, publishing) {
    let result;
    try {
      result = await chrome.runtime.sendNativeMessage(HOST, payload);
    } catch (error) {
      await recordConnection({ ok: false });
      throw connectionError(error);
    }

    if (!result?.ok) {
      if (!publishing) await recordConnection({ ok: false });
      throw new Error(result?.error || (publishing
        ? 'Publishing failed. Check the repository connection and try again.'
        : 'The native publisher did not confirm the linked repository.'));
    }

    await recordConnection(result);
    return result;
  }

  globalThis.__ghrcResearchPublisher = {
    checkConnection: () => sendToNative({ action: 'status' }, false),
  };

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!['publish-research-report', 'research-publisher-status', 'open-research-link'].includes(message?.type)) return false;
    (async () => {
      if (sender.id !== chrome.runtime.id) throw new Error('Unknown extension.');
      if (message.type === 'open-research-link') {
        if (!reportSender(sender)) throw new Error('Open links from a ChatGPT research report.');
        const url = new URL(message.url);
        if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Unsupported report link.');
        await chrome.tabs.create({ url: url.href });
        return { ok: true };
      }
      const settings = await chrome.storage.local.get({ researchPublisherEnabled: false });
      if (!settings.researchPublisherEnabled) throw new Error('Enable Deep research publisher in settings first.');
      const publishing = message.type === 'publish-research-report';
      let payload = { action: 'status' };
      let key;
      let automaticJob;
      if (publishing) {
        if (!reportSender(sender)) {
          throw new Error('Publish from a completed ChatGPT research report.');
        }
        if (typeof message.title !== 'string' || !message.title.trim() || message.title.length > 500
          || typeof message.markdown !== 'string' || !message.markdown.trim()
          || new TextEncoder().encode(message.markdown).length > 4 * 1024 * 1024) throw new Error('Invalid or oversized report.');
        const source = new URL(sender.tab.url);
        payload = { action: 'publish', title: message.title, markdown: message.markdown, source: source.origin + source.pathname };
        if (message.category !== undefined) {
          if (typeof message.category !== 'string' || message.category.length > 240
            || (message.category && message.category.split('/').some(part => !part || part.startsWith('.') || !/^[\p{L}\p{N} _-]+$/u.test(part)))) {
            throw new Error('Choose a valid repository category.');
          }
          payload.category = message.category;
        }
        key = `${sender.tab.id}:${message.title}`;
        if (inFlight.has(key)) throw new Error('This report is already being added.');
        inFlight.add(key);
      }
      try {
        if (publishing && message.automationJobId !== undefined) {
          const readiness = await chrome.tabs.sendMessage(sender.tab.id,
            { type: 'research-launch-readiness', id: message.automationJobId }, { frameId: 0 });
          if (!readiness?.ready) throw new Error('Research is still running.');
          automaticJob = await globalThis.__ghrcResearchLaunch.beginImport(sender, message.automationJobId);
          payload.category = automaticJob.category;
        }
        if (automaticJob) {
          const connection = await sendToNative({ action: 'status' }, false);
          if (connection.repository !== automaticJob.repository || connection.branch !== automaticJob.branch)
            throw new Error('The linked repository changed during research. Use Add to repo to choose the destination again.');
        }
        const result = await sendToNative(payload, publishing);
        if (automaticJob) await globalThis.__ghrcResearchLaunch.finishImport(sender.tab.id, automaticJob.id, result);
        return result;
      } catch (error) {
        if (automaticJob) await globalThis.__ghrcResearchLaunch.finishImport(sender.tab.id, automaticJob.id, undefined, error.message);
        throw error;
      } finally { if (key) inFlight.delete(key); }
    })().then(respond, (error) => respond({ ok: false, error: error.message }));
    return true;
  });
})();
