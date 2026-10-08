(() => {
  "use strict";
  const STORAGE_KEY = "composerColors";
  const SPECS = [["surface","Bar background","#303030"],["surface-border","Bar border","#666666"],["focus-ring","Focus border and ring","#a97dee"],["text","Typed text","#ffffff"],["caret","Typing cursor","#a97dee"],["placeholder","Placeholder text","#a1a1aa"],["selection-background","Selected text background","#8556c6"],["selection-text","Selected text","#ffffff"],["toolbar-background","Toolbar button backgrounds","#444444"],["toolbar-icon","Toolbar icons and labels","#ffffff"],["toolbar-hover","Toolbar hover","#555555"],["send-background","Send button background","#ffffff"],["send-icon","Send button icon","#202020"],["send-hover","Send button hover","#dadada"],["stop-background","Stop button background","#ffffff"],["stop-icon","Stop button icon","#202020"],["attachment-background","Attachment background","#404040"],["attachment-text","Attachment text","#ffffff"],["attachment-border","Attachment border","#747474"]];
  const HEX = /^#[0-9a-f]{6}$/i;
  const normalizeHex = input => {
    const text = typeof input === "string" ? input.trim() : "";
    const value = text.startsWith("#") ? text : `#${text}`;
    return HEX.test(value) ? value.toLowerCase() : null;
  };
  const valid = input => Object.fromEntries(SPECS.flatMap(([key]) => {
    const value = input && typeof input === "object" ? input[key] : undefined;
    return typeof value === "string" && HEX.test(value) ? [[key, value.toLowerCase()]] : [];
  }));
  const panel = document.getElementById("composer-color-settings");

  if (panel) {
    const grid = document.getElementById("composer-color-grid");
    const reset = document.getElementById("composer-color-reset");
    const fields = new Map();
    let colors = {};
    let loaded = false;
    let pending = Promise.resolve();

    function render(input) {
      colors = valid(input);
      for (const [key, { toggle, picker, hex, preview }] of fields) {
        toggle.checked = Boolean(colors[key]);
        picker.disabled = hex.disabled = !toggle.checked;
        picker.value = hex.value = colors[key] || preview;
        hex.removeAttribute("aria-invalid");
      }
      reset.disabled = Object.keys(colors).length === 0;
    }
    function persist() {
      if (!loaded) return;
      const snapshot = { ...colors };
      reset.disabled = Object.keys(snapshot).length === 0;
      pending = pending.catch(() => {}).then(() => chrome.storage.local.set({ [STORAGE_KEY]: snapshot }));
    }
    for (const [key, title, preview] of SPECS) {
      const row = document.createElement("div");
      row.className = "composer-color-row";
      const label = document.createElement("label");
      label.className = "composer-color-label";
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.setAttribute("aria-label", `Customize ${title}`);
      const caption = document.createElement("span");
      caption.textContent = title;
      label.append(toggle, caption);
      const picker = document.createElement("input");
      picker.type = "color";
      picker.value = preview;
      picker.disabled = true;
      picker.setAttribute("aria-label", `${title} color`);
      const controls = document.createElement("div");
      controls.className = "composer-color-controls";
      const hex = document.createElement("input");
      hex.type = "text";
      hex.className = "composer-color-hex";
      hex.value = preview;
      hex.maxLength = 7;
      hex.placeholder = "#RRGGBB";
      hex.spellcheck = false;
      hex.autocomplete = "off";
      hex.disabled = true;
      hex.setAttribute("aria-label", `${title} HEX color`);
      controls.append(picker, hex);
      row.append(label, controls);
      grid.append(row);
      fields.set(key, { toggle, picker, hex, preview });
      toggle.addEventListener("change", () => {
        picker.disabled = hex.disabled = !toggle.checked;
        if (toggle.checked) colors[key] = picker.value;
        else delete colors[key];
        hex.value = picker.value;
        hex.removeAttribute("aria-invalid");
        persist();
      });
      picker.addEventListener("input", () => {
        if (!toggle.checked) return;
        colors[key] = picker.value;
        hex.value = picker.value;
        hex.removeAttribute("aria-invalid");
        persist();
      });
      hex.addEventListener("input", () => {
        if (!toggle.checked) return;
        const value = normalizeHex(hex.value);
        if (!value) {
          hex.setAttribute("aria-invalid", "true");
          return;
        }
        hex.removeAttribute("aria-invalid");
        picker.value = colors[key] = value;
        persist();
      });
      hex.addEventListener("change", () => {
        const value = normalizeHex(hex.value);
        if (toggle.checked && value && colors[key] !== value) {
          picker.value = colors[key] = value;
          persist();
        }
        // An incomplete or invalid edit never replaces the last saved color.
        hex.value = colors[key] || picker.value;
        hex.removeAttribute("aria-invalid");
      });
    }
    // Keep changes out of the larger form's unrelated settings writer.
    panel.addEventListener("change", event => event.stopPropagation());
    reset.addEventListener("click", () => { render({}); persist(); });
    void chrome.storage.local.get({ [STORAGE_KEY]: {} }).then(stored => {
      if (!loaded) render(stored[STORAGE_KEY]);
      loaded = true;
    });
    return;
  }

  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;
  const root = document.documentElement;
  function apply(input) {
    const colors = valid(input);
    for (const [key] of SPECS) {
      const attr = `data-ghrc-color-${key}`;
      const property = `--ghrc-composer-${key}`;
      if (colors[key]) {
        root.setAttribute(attr, "");
        root.style.setProperty(property, colors[key]);
      } else {
        root.removeAttribute(attr);
        root.style.removeProperty(property);
      }
    }
  }
  function onStorageChange(changes, area) {
    if (area === "local" && changes[STORAGE_KEY] && context.active()) apply(changes[STORAGE_KEY].newValue);
  }
  chrome.storage.onChanged.addListener(onStorageChange);
  context.onStop(() => {
    chrome.storage.onChanged.removeListener?.(onStorageChange);
    apply({});
  });
  void context.run(async () => {
    const saved = await chrome.storage.local.get({ [STORAGE_KEY]: {} });
    if (context.active()) apply(saved[STORAGE_KEY]);
  });
})();
