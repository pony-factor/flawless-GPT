(() => {
  "use strict";

  const prefix = "ghrcResearchSpellcheck:";
  const sourceKey = id => prefix + "source:" + id;
  const childKey = id => prefix + "child:" + id;
  const get = async key => (await chrome.storage.session.get(key))[key];

  function chatSender(sender) {
    try {
      return sender.id === chrome.runtime.id && sender.frameId === 0
        && Number.isInteger(sender.tab?.id)
        && new URL(sender.url).origin === "https://chatgpt.com";
    } catch { return false; }
  }

  async function clear(job) {
    await chrome.storage.session.remove([childKey(job.childId), sourceKey(job.sourceId)]);
  }

  // Accepted routes are limited to the new-chat page and real conversation pages.
  const supportedPath = path => path === "/"
    || /^\/(?:g\/[^/]+\/)?c\/[a-z0-9-]+\/?$/i.test(path);

  async function begin(sender, message) {
    if (typeof message.sourcePath !== "string" || !supportedPath(message.sourcePath))
      throw new Error("Open a new or existing ChatGPT conversation to spellcheck Deep Research.");
    if (typeof message.prompt !== "string" || !message.prompt.trim()
      || new TextEncoder().encode(message.prompt).length > 200000)
      throw new Error("The research prompt is empty or too large to spellcheck.");
    if (await get(sourceKey(sender.tab.id)))
      throw new Error("A spellcheck is already running for this chat.");
    if (typeof chrome.tabs.createSplit !== "function")
      throw new Error("This browser cannot open a native split view.");
    const source = await chrome.tabs.get(sender.tab.id);
    const url = new URL(source.url);
    if (url.origin !== "https://chatgpt.com" || url.pathname !== message.sourcePath)
      throw new Error("The active conversation changed. Nothing was sent.");
    if (Number.isInteger(source.splitViewId) && source.splitViewId >= 0)
      throw new Error("Close the existing split view before spellchecking this prompt.");
    const child = await chrome.tabs.create({
      url: "about:blank", windowId: source.windowId, index: source.index + 1,
      active: false, pinned: source.pinned,
    });
    const job = {
      id: crypto.randomUUID(), sourceId: source.id, childId: child.id,
      prompt: message.prompt, sourcePath: message.sourcePath, state: "pending",
    };
    try {
      await chrome.tabs.createSplit([source.id, child.id]);
      await chrome.storage.session.set({
        [sourceKey(source.id)]: child.id,
        [childKey(child.id)]: job,
      });
      await chrome.tabs.update(child.id, { url: "https://chatgpt.com/", active: true });
      return { ok: true, id: job.id };
    } catch (error) {
      await clear(job);
      await chrome.tabs.remove(child.id).catch(() => {});
      throw error;
    }
  }

  async function claim(sender) {
    const job = await get(childKey(sender.tab.id));
    if (!job || job.state !== "pending" || new URL(sender.url).pathname !== "/")
      return { ok: true, job: null };
    await chrome.storage.session.set({ [childKey(job.childId)]: { ...job, state: "running" } });
    return { ok: true, job: { id: job.id, prompt: job.prompt } };
  }

  async function finish(sender, message) {
    const job = await get(childKey(sender.tab.id));
    if (!job || job.id !== message.id || job.state !== "running")
      throw new Error("This spellcheck is no longer active.");
    if (typeof message.corrected !== "string" || !message.corrected.trim()
      || new TextEncoder().encode(message.corrected).length > 200000)
      throw new Error("Spellcheck did not return a usable correction.");
    const source = await chrome.tabs.get(job.sourceId);
    if (new URL(source.url).origin !== "https://chatgpt.com"
      || new URL(source.url).pathname !== job.sourcePath)
      throw new Error("The original conversation changed; its draft was preserved.");
    const reply = await chrome.tabs.sendMessage(job.sourceId, {
      type: "ghrc-research-spellcheck-apply",
      id: job.id, original: job.prompt, corrected: message.corrected,
    });
    if (!reply?.ok) throw new Error(reply?.error || "The original draft changed; it was preserved.");
    await clear(job);
    await chrome.tabs.remove(job.childId);
    return { ok: true };
  }

  async function fail(sender, message) {
    const job = await get(childKey(sender.tab.id));
    if (!job || job.id !== message.id) return { ok: true };
    await clear(job);
    await chrome.tabs.sendMessage(job.sourceId, {
      type: "ghrc-research-spellcheck-failed",
      id: job.id, error: String(message.error || "Spellcheck could not finish.").slice(0, 300),
    }).catch(() => {});
    // Keep the spellcheck pane open for recovery or manual copying.
    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!["ghrc-research-spellcheck-begin", "ghrc-research-spellcheck-claim",
      "ghrc-research-spellcheck-finish", "ghrc-research-spellcheck-fail"].includes(message?.type))
      return false;
    if (!chatSender(sender)) {
      respond({ ok: false, error: "Available only in ChatGPT." });
      return false;
    }
    const action = ({
      "ghrc-research-spellcheck-begin": () => begin(sender, message),
      "ghrc-research-spellcheck-claim": () => claim(sender),
      "ghrc-research-spellcheck-finish": () => finish(sender, message),
      "ghrc-research-spellcheck-fail": () => fail(sender, message),
    })[message.type];
    Promise.resolve().then(action).then(respond, error => respond({ ok: false, error: error.message }));
    return true;
  });

  chrome.tabs.onRemoved.addListener(tabId => {
    void (async () => {
      const job = await get(childKey(tabId));
      if (job) {
        await clear(job);
        await chrome.tabs.sendMessage(job.sourceId, {
          type: "ghrc-research-spellcheck-failed", id: job.id,
          error: "Spellcheck was closed. Your original research draft is still available.",
        }).catch(() => {});
      } else {
        // A source tab can close while a child is still running. Do not affect other panes.
        await chrome.storage.session.remove(sourceKey(tabId));
      }
    })().catch(() => {});
  });
})();