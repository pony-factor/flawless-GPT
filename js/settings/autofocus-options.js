(() => {
  if (globalThis.__ghrcSettingsContext?.active() === false) return;
  const AUTO_FOCUS_SETTING_KEY = "autoFocusComposer";
  const FORCE_HIGH_SETTING_KEY = "forceHighThinking";
  const CLIPBOARD_SEND_SETTING_KEY = "showClipboardSendButton";
  const MESSAGE_QUEUE_BUTTON_SETTING_KEY = "showMessageQueueButton";

  function bindCheckbox(input, settingKey, defaultValue) {
    if (!input) return;

    void chrome.storage.local.get({ [settingKey]: defaultValue }).then((settings) => {
      input.checked = Boolean(settings[settingKey]);
    }).catch((globalThis.__ghrcSettingsContext?.report || console.error));

    input.addEventListener("change", () => {
      void chrome.storage.local.set({ [settingKey]: input.checked }).catch((globalThis.__ghrcSettingsContext?.report || console.error));
    });
  }

  function bindInvertedCheckbox(input, settingKey, defaultValue) {
    if (!input) return;

    void chrome.storage.local.get({ [settingKey]: defaultValue }).then((settings) => {
      input.checked = !Boolean(settings[settingKey]);
    }).catch((globalThis.__ghrcSettingsContext?.report || console.error));

    input.addEventListener("change", () => {
      void chrome.storage.local.set({ [settingKey]: !input.checked }).catch((globalThis.__ghrcSettingsContext?.report || console.error));
    });
  }

  const autoFocusInput = document.getElementById("auto-focus-composer");
  bindCheckbox(autoFocusInput, AUTO_FOCUS_SETTING_KEY, true);
  bindCheckbox(document.getElementById("block-voice-prompts"), "blockVoicePrompts", false);
  bindInvertedCheckbox(document.getElementById("hide-message-queue-button"), MESSAGE_QUEUE_BUTTON_SETTING_KEY, false);

  const chatInteractionFieldset = document.getElementById("chatgpt-interaction-settings")
    || autoFocusInput?.closest("fieldset");
  const disableWorkPreference = document.getElementById("disable-work-mode")?.closest("label.preference");

  let highInput = document.getElementById("force-high-thinking");
  if (!highInput && chatInteractionFieldset) {
    const preference = document.createElement("label");
    preference.className = "preference";
    preference.innerHTML = `
      <input id="force-high-thinking" type="checkbox" />
      <span>
        <strong>Maximize thinking</strong>
        <small>Sets thinking effort and thinking time to their highest available levels, then hides their selectors.</small>
      </span>
    `;
    if (disableWorkPreference) disableWorkPreference.insertAdjacentElement("afterend", preference);
    else chatInteractionFieldset.append(preference);
    highInput = preference.querySelector("input");
  }
  bindCheckbox(highInput, FORCE_HIGH_SETTING_KEY, false);

  let clipboardSendInput = document.getElementById("show-clipboard-send-button");
  if (!clipboardSendInput && chatInteractionFieldset) {
    const preference = document.createElement("label");
    preference.className = "preference";
    preference.innerHTML = `
      <input id="show-clipboard-send-button" type="checkbox" />
      <span>
        <strong>Show clipboard queue button</strong>
        <small>Adds a button that queues clipboard text without interrupting the response or replacing your draft.</small>
      </span>
    `;
    const queuePreference = document.getElementById("hide-message-queue-button")?.closest("label.preference");
    const highPreference = highInput?.closest("label.preference");
    const anchor = queuePreference || highPreference || disableWorkPreference;
    if (anchor) anchor.insertAdjacentElement("afterend", preference);
    else chatInteractionFieldset.append(preference);
    clipboardSendInput = preference.querySelector("input");
  }
  bindCheckbox(clipboardSendInput, CLIPBOARD_SEND_SETTING_KEY, false);
})();
