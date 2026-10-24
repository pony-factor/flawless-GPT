(() => {
  "use strict";
  const STORAGE_KEY = "dashboardColors";
  const SPECS = [
    ["accentLight", "Dashboard accent (light mode)", "#0969da", "--ghrc-dashboard-accent-light"],
    ["accentDark", "Dashboard accent (dark mode)", "#4493f8", "--ghrc-dashboard-accent-dark"],
    ["repositoryLight", "Repository links (light mode)", "#0969da", "--ghrc-dashboard-link-light"],
    ["repositoryDark", "Repository links (dark mode)", "#4493f8", "--ghrc-dashboard-link-dark"],
  ];
  const HEX = /^#[0-9a-f]{6}$/i;
  const normalizeHex = input => {
    const raw = typeof input === "string" ? input.trim() : "";
    const value = raw.startsWith("#") ? raw : "#" + raw;
    return HEX.test(value) ? value.toLowerCase() : null;
  };
  const valid = input => Object.fromEntries(SPECS.flatMap(([key]) => {
    const value = input && typeof input === "object" ? input[key] : null;
    return typeof value === "string" && HEX.test(value)
      ? [[key, value.toLowerCase()]] : [];
  }));

  const panel = document.getElementById("dashboard-color-settings");
  if (panel) {
    const grid = document.getElementById("dashboard-color-grid");
    const reset = document.getElementById("dashboard-color-reset");
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
      picker.setAttribute("aria-label", title + " color picker");
      const hex = document.createElement("input");
      hex.type = "text";
      hex.className = "composer-color-hex";
      hex.value = preview;
      hex.placeholder = "#RRGGBB";
      hex.maxLength = 7;
      hex.spellcheck = false;
      hex.autocomplete = "off";
      hex.setAttribute("aria-label", title + " HEX color");
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "composer-color-clear";
      clear.textContent = "Default";
      clear.title = "Restore the default dashboard color";
      clear.setAttribute("aria-label", "Restore default for " + title);
      clear.hidden = true;
      controls.append(picker, hex, clear);
      row.append(label, controls);
      grid.append(row);
      fields.set(key, { picker, hex, clear, preview });
      const setColor = value => {
        colors[key] = value;
        render(colors);
        persist();
      };
      picker.addEventListener("input", () => setColor(picker.value));
      hex.addEventListener("input", () => {
        const value = normalizeHex(hex.value);
        if (value) setColor(value);
        else hex.setAttribute("aria-invalid", "true");
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
        render(colors);
        persist();
      });
      picker.disabled = hex.disabled = clear.disabled = true;
    }

    // Prevent the shared settings form from saving unrelated controls.
    panel.addEventListener("change", event => event.stopPropagation());
    reset.addEventListener("click", () => { render({}); persist(); });
    reset.disabled = true;
    void chrome.storage.local.get({ [STORAGE_KEY]: {} }).then(stored => {
      render(stored[STORAGE_KEY]);
      loaded = true;
      for (const { picker, hex, clear } of fields.values()) {
        picker.disabled = hex.disabled = clear.disabled = false;
      }
    });
    chrome.storage.onChanged?.addListener?.((changes, area) => {
      if (loaded && area === "local" && changes[STORAGE_KEY]) {
        render(changes[STORAGE_KEY].newValue);
      }
    });
    return;
  }

  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;
  const root = document.documentElement;
  function apply(input) {
    const colors = valid(input);
    for (const [key, , , property] of SPECS) {
      if (colors[key]) root.style.setProperty(property, colors[key]);
      else root.style.removeProperty(property);
    }
  }
  function onStorageChange(changes, area) {
    if (area === "local" && changes[STORAGE_KEY] && context.active()) {
      apply(changes[STORAGE_KEY].newValue);
    }
  }
  chrome.storage.onChanged.addListener(onStorageChange);
  context.onStop(() => {
    chrome.storage.onChanged.removeListener?.(onStorageChange);
    apply({});
  });
  void context.run(async () => {
    const stored = await chrome.storage.local.get({ [STORAGE_KEY]: {} });
    if (context.active()) apply(stored[STORAGE_KEY]);
  });
})();
