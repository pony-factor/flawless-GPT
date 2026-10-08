(() => {
  const AUTO_FOCUS_SETTING_KEY = "autoFocusComposer";
  const FORCE_HIGH_SETTING_KEY = "forceHighThinking";
  const CLIPBOARD_SEND_SETTING_KEY = "showClipboardSendButton";
  const MESSAGE_QUEUE_BUTTON_SETTING_KEY = "showMessageQueueButton";
  const HOVER_REVEAL_SIDEBAR_SETTING_KEY = "hoverRevealSidebar";

  function bindCheckbox(input, settingKey, defaultValue) {
    if (!input) return;

    void chrome.storage.local.get({ [settingKey]: defaultValue }).then((settings) => {
      input.checked = Boolean(settings[settingKey]);
    });

    input.addEventListener("change", () => {
      void chrome.storage.local.set({ [settingKey]: input.checked });
    });
  }

  function bindInvertedCheckbox(input, settingKey, defaultValue) {
    if (!input) return;

    void chrome.storage.local.get({ [settingKey]: defaultValue }).then((settings) => {
      input.checked = !Boolean(settings[settingKey]);
    });

    input.addEventListener("change", () => {
      void chrome.storage.local.set({ [settingKey]: !input.checked });
    });
  }

  const autoFocusInput = document.getElementById("auto-focus-composer");
  bindCheckbox(autoFocusInput, AUTO_FOCUS_SETTING_KEY, true);
  bindCheckbox(document.getElementById("block-voice-prompts"), "blockVoicePrompts", false);
  bindInvertedCheckbox(document.getElementById("hide-message-queue-button"), MESSAGE_QUEUE_BUTTON_SETTING_KEY, false);

  const chatInteractionFieldset = document.getElementById("chatgpt-interaction-settings")
    || autoFocusInput?.closest("fieldset");
  const chatDisplayFieldset = document.getElementById("chatgpt-display-settings")
    || chatInteractionFieldset;
  const disableWorkPreference = document.getElementById("disable-work-mode")?.closest("label.preference");

  let sidebarHoverInput = document.getElementById("hover-reveal-sidebar");
  if (!sidebarHoverInput && chatDisplayFieldset) {
    const preference = document.createElement("label");
    preference.className = "preference";
    preference.innerHTML = `
      <input id="hover-reveal-sidebar" type="checkbox" />
      <span>
        <strong>Reveal sidebar on hover</strong>
        <small>Hover over the left rail directly below Library to reveal the sidebar. It stays open while you use the sidebar or its menus, then collapses when you move away.</small>
      </span>
    `;
    const dictationPreference = document.getElementById("hide-dictation-button")?.closest("label.preference");
    if (dictationPreference) dictationPreference.insertAdjacentElement("afterend", preference);
    else chatDisplayFieldset.append(preference);
    sidebarHoverInput = preference.querySelector("input");
  }
  bindCheckbox(sidebarHoverInput, HOVER_REVEAL_SIDEBAR_SETTING_KEY, false);

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
