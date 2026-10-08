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
      for (const [key, { picker, hex, clear, preview }] of fields) {
        picker.value = hex.value = colors[key] || preview;
        clear.hidden = !colors[key];
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
      const label = document.createElement("span");
      label.className = "composer-color-label";
      label.textContent = title;

      const controls = document.createElement("div");
      controls.className = "composer-color-controls";
      const picker = document.createElement("input");
      picker.type = "color";
      picker.value = preview;
      picker.setAttribute("aria-label", `${title} color picker`);

      const hex = document.createElement("input");
      hex.type = "text";
      hex.className = "composer-color-hex";
      hex.value = preview;
      hex.maxLength = 7;
      hex.placeholder = "#RRGGBB";
      hex.spellcheck = false;
      hex.autocomplete = "off";
      hex.setAttribute("aria-label", `${title} HEX color`);

      // Unedited controls inherit ChatGPT's palette. The displayed swatch is
      // only a preview until the user edits either field.
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "composer-color-clear";
      clear.textContent = "Default";
      clear.title = "Use ChatGPT's default color";
      clear.setAttribute("aria-label", `Restore ChatGPT default for ${title}`);
      clear.hidden = true;

      controls.append(picker, hex, clear);
      row.append(label, controls);
      grid.append(row);
      fields.set(key, { picker, hex, clear, preview });

      const setColor = (value) => {
        colors[key] = value;
        picker.value = hex.value = value;
        hex.removeAttribute("aria-invalid");
        clear.hidden = false;
        persist();
      };
      picker.addEventListener("input", () => setColor(picker.value));
      hex.addEventListener("input", () => {
        const value = normalizeHex(hex.value);
        if (!value) {
          hex.setAttribute("aria-invalid", "true");
          return;
        }
        setColor(value);
      });
      hex.addEventListener("change", () => {
        const value = normalizeHex(hex.value);
        if (value && colors[key] !== value) setColor(value);
        else {
          hex.value = colors[key] || preview;
          hex.removeAttribute("aria-invalid");
        }
      });
      clear.addEventListener("click", () => {
        delete colors[key];
        picker.value = hex.value = preview;
        hex.removeAttribute("aria-invalid");
        clear.hidden = true;
        persist();
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
