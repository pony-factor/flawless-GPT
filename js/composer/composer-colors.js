(() => {
  "use strict";
  const STORAGE_KEY = "composerColors";
  const SOURCE_KEY = "composerColorSource";
  const SPECS = [["surface","Bar background","#303030"],["surface-border","Bar border","#666666"],["focus-ring","Focus border and ring","#a97dee"],["text","Typed text","#ffffff"],["caret","Typing cursor","#a97dee"],["placeholder","Placeholder text","#a1a1aa"],["selection-background","Selected text background","#8556c6"],["selection-text","Selected text","#ffffff"],["toolbar-background","Toolbar button backgrounds","#444444"],["toolbar-icon","Toolbar icons and labels","#ffffff"],["toolbar-hover","Toolbar hover","#555555"],["send-background","Send button background","#ffffff"],["send-icon","Send button icon","#202020"],["send-hover","Send button hover","#dadada"],["stop-background","Stop button background","#ffffff"],["stop-icon","Stop button icon","#202020"],["plus-background","+ button background","#444444"],["plus-icon","+ button icon","#ffffff"],["plus-hover","+ button hover","#555555"],["clipboard-background","Clipboard paste background","#444444"],["clipboard-icon","Clipboard paste icon","#ffffff"],["clipboard-hover","Clipboard paste hover","#555555"],["attachment-background","Attachment background","#404040"],["attachment-text","Attachment text","#ffffff"],["attachment-border","Attachment border","#747474"]];
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
    let sourceColors = {};
    let loaded = false;
    let pending = Promise.resolve();

    function inheritedColor(key) {
      // This extension-owned paste button follows the custom toolbar palette
      // until its own individual color is explicitly edited.
      const toolbarKey = key.startsWith("clipboard-")
        ? `toolbar-${key.slice("clipboard-".length)}`
        : null;
      return (toolbarKey && colors[toolbarKey]) || sourceColors[key] || null;
    }
    function render(input) {
      colors = valid(input);
      for (const [key, { picker, hex, clear, preview, sourceMarker }] of fields) {
        const inherited = inheritedColor(key);
        picker.value = hex.value = colors[key] || inherited || preview;
        clear.hidden = !colors[key];
        if (sourceMarker) sourceMarker.hidden = !!colors[key] || !inherited;
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
      const sourceMarker = (key.startsWith("stop-") || key === "plus-background" || key === "plus-icon" || key.startsWith("selection-") || key.startsWith("clipboard-")) ? document.createElement("span") : null;
      if (sourceMarker) {
        sourceMarker.className = "composer-color-source";
        sourceMarker.textContent = "*";
        sourceMarker.title = key.startsWith("clipboard-")
          ? "Inherited from your toolbar button colors"
          : "Inherited from ChatGPT's active theme";
        sourceMarker.setAttribute("aria-label", key.startsWith("clipboard-")
          ? "Inherited from toolbar colors"
          : "Inherited from ChatGPT settings");
        sourceMarker.hidden = true;
        label.append(sourceMarker);
      }

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
      fields.set(key, { picker, hex, clear, preview, sourceMarker });

      const setColor = (value) => {
        colors[key] = value;
        render(colors);
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
          hex.value = colors[key] || inheritedColor(key) || preview;
          hex.removeAttribute("aria-invalid");
        }
      });
      clear.addEventListener("click", () => {
        delete colors[key];
        render(colors);
        persist();
      });
    }
    // Keep changes out of the larger form's unrelated settings writer.
    panel.addEventListener("change", event => event.stopPropagation());
    reset.addEventListener("click", () => { render({}); persist(); });
    void chrome.storage.local.get({ [STORAGE_KEY]: {}, [SOURCE_KEY]: {} }).then(stored => {
      if (!loaded) {
        sourceColors = valid(stored[SOURCE_KEY]);
        render(stored[STORAGE_KEY]);
      }
      loaded = true;
    });
    chrome.storage.onChanged?.addListener?.((changes, area) => {
      if (area !== "local" || !changes[SOURCE_KEY]) return;
      sourceColors = valid(changes[SOURCE_KEY].newValue);
      if (loaded) render(colors);
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

  // Sample actual ChatGPT composer-button colors for the options-page preview.
  // Never copy these inherited values into the user's composerColors overrides.
  const cssHex = value => {
    if (typeof value !== "string") return null;
    const valueText = value.trim();
    if (/^#[0-9a-f]{3}$/i.test(valueText)) return "#" + [...valueText.slice(1)].map(x => x + x).join("").toLowerCase();
    if (HEX.test(valueText)) return valueText.toLowerCase();
    const match = /^rgba?\(\s*(\d{1,3})[,\s]+(\d{1,3})[,\s]+(\d{1,3})(?:\s*[,/]\s*([\d.]+))?\s*\)$/i.exec(valueText);
    if (!match || (match[4] && Number(match[4]) !== 1)) return null;
    const rgb = match.slice(1, 4).map(Number);
    return rgb.some(x => x > 255) ? null : "#" + rgb.map(x => x.toString(16).padStart(2, "0")).join("");
  };
  let lastSource = "";
  function sampleSource() {
    if (!context.active() || typeof getComputedStyle !== "function") return;
    const theme = getComputedStyle(root);
    const background = cssHex(theme.getPropertyValue("--theme-submit-btn-bg"));
    const foreground = cssHex(theme.getPropertyValue("--theme-submit-btn-text"));
    const source = {};
    if (background) source["stop-background"] = background;
    if (foreground) source["stop-icon"] = foreground;
    const button = document.querySelector?.('button[data-testid="stop-button"], button#composer-submit-button[aria-label^="Stop" i], button[aria-label^="Stop" i]');
    if (button) {
      // Never label Flawless's own overrides as inherited ChatGPT colors.
      if (!root.hasAttribute?.("data-ghrc-color-stop-background")) {
        const value = cssHex(getComputedStyle(button).backgroundColor);
        if (value) source["stop-background"] = value;
      }
      if (!root.hasAttribute?.("data-ghrc-color-stop-icon")) {
        const value = cssHex(getComputedStyle(button.querySelector?.("svg") || button).color);
        if (value) source["stop-icon"] = value;
      }
    }
    // The + button opens the attachment/tools menu, not an attachment chip.
    // Its unmodified background and icon should be discoverable independently
    // of the toolbar defaults and never be mistaken for a saved override.
    const plus = document.querySelector?.('button[data-testid="composer-plus-btn"], button#composer-plus-btn, button[aria-label^="Add files and more" i]');
    if (plus) {
      if (!root.hasAttribute?.("data-ghrc-color-plus-background")) {
        const background = cssHex(getComputedStyle(plus).backgroundColor);
        if (background) source["plus-background"] = background;
      }
      if (!root.hasAttribute?.("data-ghrc-color-plus-icon")) {
        const icon = cssHex(getComputedStyle(plus.querySelector?.("svg") || plus).color);
        if (icon) source["plus-icon"] = icon;
      }
    }
    // Text selection in ChatGPT's rich editor occurs on nested paragraphs
    // and spans, not necessarily on the contenteditable container itself.
    // CSSOM lets the preview report the actual theme highlight while our
    // ::selection override remains disabled.
    const editor = document.querySelector?.('#prompt-textarea, [data-composer-markdown][contenteditable="true"]');
    if (editor && (!root.hasAttribute?.("data-ghrc-color-selection-background")
        || !root.hasAttribute?.("data-ghrc-color-selection-text"))) {
      const sample = editor.querySelector?.("p, span") || editor;
      let nativeSelection;
      try {
        nativeSelection = getComputedStyle(sample, "::selection");
      } catch {
        // Not every browser/version exposes computed highlight pseudo styles.
      }
      if (nativeSelection) {
        if (!root.hasAttribute?.("data-ghrc-color-selection-background")) {
          const selectedBackground = cssHex(nativeSelection.backgroundColor);
          if (selectedBackground) source["selection-background"] = selectedBackground;
        }
        if (!root.hasAttribute?.("data-ghrc-color-selection-text")) {
          const selectedText = cssHex(nativeSelection.color);
          if (selectedText) source["selection-text"] = selectedText;
        }
      }
    }
    if (!Object.keys(source).length) return;
    const snapshot = JSON.stringify(source);
    if (snapshot === lastSource) return;
    lastSource = snapshot;
    void chrome.storage.local.set({ [SOURCE_KEY]: source });
  }
  if (typeof setInterval === "function") {
    const interval = setInterval(sampleSource, 2500);
    context.onStop(() => clearInterval(interval));
  }
  sampleSource();
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
