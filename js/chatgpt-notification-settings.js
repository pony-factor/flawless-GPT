(() => {
  'use strict';

  // Native/browser notifications are outside the document and cannot be
  // filtered by the content-script toast observer. Chrome only permits a
  // per-origin allow/block setting, not per-message filtering.
  const SETTING_KEY = 'blockChatgptDesktopNotifications';
  const CHATGPT_ORIGIN_PATTERN = 'https://chatgpt.com/*';
  let pending = Promise.resolve();

  async function applySetting(block) {
    const notifications = chrome.contentSettings?.notifications;
    if (!notifications) return;

    if (block) {
      await notifications.set({
        primaryPattern: CHATGPT_ORIGIN_PATTERN,
        setting: 'block',
        scope: 'regular',
      });
    } else {
      // Remove only this extension's content-setting overrides, restoring the
      // browser's existing site preference without setting 'allow' globally.
      await notifications.clear({ scope: 'regular' });
    }
  }

  function enqueue(block) {
    pending = pending.catch(() => {}).then(() => applySetting(block));
    void pending.catch((error) => console.warn('ChatGPT notification setting failed:', error));
    return pending;
  }

  async function refresh() {
    try {
      const stored = await chrome.storage.local.get({ [SETTING_KEY]: true });
      await enqueue(stored[SETTING_KEY] !== false);
    } catch (error) {
      console.warn('Could not apply ChatGPT desktop notification setting:', error);
    }
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !Object.prototype.hasOwnProperty.call(changes, SETTING_KEY)) return;
    void enqueue(changes[SETTING_KEY].newValue !== false);
  });

  chrome.runtime.onInstalled.addListener(() => void refresh());
  chrome.runtime.onStartup.addListener(() => void refresh());
  void refresh();
})();
