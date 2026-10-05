(() => {
  "use strict";

  const CHANNEL = "flawless-web-commit-guidance";
  const GUIDANCE_KEY = "webCommitGuidance";
  const LAST_SYNCED_KEY = "webCommitGuidanceLastSynced";
  const ACCOUNT_KEY = "webCommitGuidanceAccountId";
  const STATUS_KEY = "webCommitGuidanceSyncStatus";
  const POLL_MS = 5000;
  const REQUEST_TIMEOUT_MS = 8000;
  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;
  const pendingBridges = new Set();

  let requestCounter = 0;
  let syncRunning = false;
  let syncAgain = false;
  let suppressedLocalValue = null;
  let pollTimer = null;

  function bridge(action, value = "") {
    if (!context.active()) return Promise.resolve(null);
    const id = `web-commit-guidance-${Date.now()}-${++requestCounter}`;
    return new Promise((resolve, reject) => {
      function cleanup() {
        clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        pendingBridges.delete(cancel);
      }
      function cancel() {
        cleanup();
        // Shutdown is expected when the extension reloads, not a sync failure.
        resolve(null);
      }
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("ChatGPT personalization bridge timed out."));
      }, REQUEST_TIMEOUT_MS);

      function onMessage(event) {
        const message = event.data;
        if (event.source !== window || message?.channel !== CHANNEL
            || message?.direction !== "response" || message.id !== id) return;
        cleanup();
        if (!message.ok) {
          reject(new Error(message.error || "ChatGPT personalization sync failed."));
          return;
        }
        resolve({
          guidance: String(message.guidance || ""),
          accountId: message.accountId || null,
        });
      }

      pendingBridges.add(cancel);
      window.addEventListener("message", onMessage);
      window.postMessage({
        channel: CHANNEL,
        direction: "request",
        id,
        action,
        value,
      }, location.origin);
    });
  }

  async function setStatus(message, state = "") {
    if (!context.active()) return;
    await chrome.storage.local.set({
      [STATUS_KEY]: { message, state, updatedAt: Date.now() },
    });
  }

  async function adoptRemote(remote, accountId) {
    suppressedLocalValue = remote;
    await chrome.storage.local.set({
      [GUIDANCE_KEY]: remote,
      [LAST_SYNCED_KEY]: remote,
      [ACCOUNT_KEY]: accountId,
    });
    await setStatus("Synced from ChatGPT Personalization.", "success");
  }

  async function pushLocal(local, accountId) {
    const updated = await bridge("set", local);
    if (!updated || !context.active()) return;
    const canonical = updated.guidance;
    suppressedLocalValue = canonical;
    await chrome.storage.local.set({
      [GUIDANCE_KEY]: canonical,
      [LAST_SYNCED_KEY]: canonical,
      [ACCOUNT_KEY]: updated.accountId || accountId,
    });
    await setStatus("Synced to ChatGPT Personalization.", "success");
  }

  function synchronize() {
    return context.run(synchronizeActive);
  }

  async function synchronizeActive() {
    if (syncRunning) {
      syncAgain = true;
      return;
    }
    syncRunning = true;
    try {
      const remoteState = await bridge("get");
      if (!remoteState || !context.active()) return;
      const stored = await chrome.storage.local.get({
        [GUIDANCE_KEY]: null,
        [LAST_SYNCED_KEY]: null,
        [ACCOUNT_KEY]: null,
      });
      if (!context.active()) return;
      const local = typeof stored[GUIDANCE_KEY] === "string" ? stored[GUIDANCE_KEY] : null;
      const lastSynced = typeof stored[LAST_SYNCED_KEY] === "string"
        ? stored[LAST_SYNCED_KEY]
        : null;
      const previousAccount = stored[ACCOUNT_KEY] || null;
      const remote = remoteState.guidance;
      const accountChanged = Boolean(
        previousAccount && remoteState.accountId && previousAccount !== remoteState.accountId,
      );

      if (accountChanged || lastSynced === null) {
        if (remote || local === null || accountChanged) {
          await adoptRemote(remote, remoteState.accountId);
        } else {
          await pushLocal(local, remoteState.accountId);
        }
      } else if (local === remote) {
        if (lastSynced !== remote || previousAccount !== remoteState.accountId) {
          await chrome.storage.local.set({
            [LAST_SYNCED_KEY]: remote,
            [ACCOUNT_KEY]: remoteState.accountId,
          });
        }
        await setStatus("Web commit guidance is in sync.", "success");
      } else if (local === lastSynced) {
        await adoptRemote(remote, remoteState.accountId);
      } else if (remote === lastSynced) {
        await pushLocal(local, remoteState.accountId);
      } else {
        // Both sides moved since the last confirmed sync. Prefer the explicit
        // Flawless edit because this setting is intended to be editable there.
        await pushLocal(local, remoteState.accountId);
      }
    } catch (error) {
      if (/extension context invalidated/i.test(error?.message || "") || !context.active()) {
        context.handleError(error);
        return;
      }
      await setStatus(
        `${error?.message || "ChatGPT personalization sync failed."} Local guidance is still saved.`,
        "error",
      );
    } finally {
      syncRunning = false;
      if (syncAgain) {
        syncAgain = false;
        void synchronize();
      }
    }
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!context.active()) return;
    pollTimer = setTimeout(async () => {
      if (document.visibilityState === "visible") await synchronize();
      schedulePoll();
    }, POLL_MS);
  }

  function onStorageChanged(changes, areaName) {
    if (areaName !== "local" || !changes[GUIDANCE_KEY]) return;
    const value = changes[GUIDANCE_KEY].newValue;
    if (value === suppressedLocalValue) {
      suppressedLocalValue = null;
      return;
    }
    void synchronize();
  }

  function onVisibilityChanged() {
    if (document.visibilityState === "visible") void synchronize();
  }
  function onFocus() { void synchronize(); }

  const storageChanges = chrome.storage.onChanged;
  storageChanges.addListener(onStorageChanged);
  document.addEventListener("visibilitychange", onVisibilityChanged);
  window.addEventListener("focus", onFocus);
  context.onStop(() => {
    clearTimeout(pollTimer);
    syncAgain = false;
    document.removeEventListener("visibilitychange", onVisibilityChanged);
    window.removeEventListener("focus", onFocus);
    try { storageChanges.removeListener(onStorageChanged); } catch { /* Already invalidated. */ }
    for (const cancel of pendingBridges) cancel();
  });

  void synchronize();
  schedulePoll();
})();
