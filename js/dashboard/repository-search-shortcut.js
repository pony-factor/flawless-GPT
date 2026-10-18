(() => {
  const DEFAULT = Object.freeze({
    key: "r", alt: true, ctrl: false, meta: false, shift: false,
  });
  const MODIFIERS = new Set(["Alt", "AltGraph", "Control", "Meta", "OS", "Shift", "Fn", "FnLock"]);
  const ALIASES = { " ": "Space", Esc: "Escape", Del: "Delete", Left: "ArrowLeft",
    Right: "ArrowRight", Up: "ArrowUp", Down: "ArrowDown" };
  const DISALLOWED = new Set(["Dead", "Process", "Unidentified", "Compose"]);

  function normalizeKey(value) {
    if (typeof value !== "string" || !value || value.length > 40) return null;
    const key = ALIASES[value] || value;
    if (MODIFIERS.has(key) || DISALLOWED.has(key)) return null;
    return key.length === 1 ? key.toLowerCase() : key;
  }

  function normalize(value) {
    const key = normalizeKey(value?.key);
    if (!key || !value || typeof value !== "object") return { ...DEFAULT };
    return {
      key, alt: value.alt === true, ctrl: value.ctrl === true,
      meta: value.meta === true, shift: value.shift === true,
    };
  }

  function fromEvent(event) {
    if (!event || event.isComposing || event.key === "AltGraph") return null;
    let key = event.key;
    // Option/Alt changes printable characters on macOS. Prefer the physical
    // letter or digit in modified shortcuts so Alt+R is still recognized.
    if (event.altKey || event.ctrlKey || event.metaKey) {
      if (/^Key[A-Z]$/.test(event.code || "")) key = event.code.slice(3).toLowerCase();
      else if (/^Digit[0-9]$/.test(event.code || "")) key = event.code.slice(5);
    }
    const normalizedKey = normalizeKey(key);
    return normalizedKey ? normalize({
      key: normalizedKey,
      alt: event.altKey, ctrl: event.ctrlKey,
      meta: event.metaKey, shift: event.shiftKey,
    }) : null;
  }

  function matches(event, setting) {
    if (event.defaultPrevented || event.repeat || event.isComposing) return false;
    const desired = normalize(setting);
    const pressed = fromEvent(event);
    return Boolean(pressed
      && pressed.key === desired.key
      && pressed.alt === desired.alt
      && pressed.ctrl === desired.ctrl
      && pressed.meta === desired.meta
      && pressed.shift === desired.shift);
  }

  function format(setting) {
    const shortcut = normalize(setting);
    const label = shortcut.key === "Delete" ? "Del"
      : shortcut.key === "Space" ? "Space"
      : shortcut.key.length === 1 ? shortcut.key.toUpperCase()
      : shortcut.key;
    return [
      shortcut.ctrl && "Ctrl", shortcut.alt && "Alt",
      shortcut.shift && "Shift", shortcut.meta && "Meta", label,
    ].filter(Boolean).join("+");
  }

  function hasModifiers(setting) {
    const shortcut = normalize(setting);
    return shortcut.alt || shortcut.ctrl || shortcut.meta || shortcut.shift;
  }

  function isEditable(event, documentNode) {
    const path = typeof event.composedPath === "function"
      ? event.composedPath()
      : [event.target];
    const nodes = [...path, documentNode?.activeElement];
    return nodes.some((node) => (
      node?.isContentEditable === true
      || (typeof node?.closest === "function"
        && Boolean(node.closest(
          'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"]',
        )))
    ));
  }

  // A plain Delete/Backspace binding is useful on new chats where ChatGPT
  // has automatically focused an otherwise empty composer. Never redirect
  // when there is text, a selection, or embedded content to edit.
  function isEmptyComposer(event, setting) {
    const key = normalize(setting).key;
    if (key !== "Delete" && key !== "Backspace") return false;
    const composer = typeof event.target?.closest === "function"
      ? event.target.closest('#prompt-textarea, [data-composer-markdown]')
      : null;
    if (!composer) return false;
    const value = typeof composer.value === "string"
      ? composer.value : composer.textContent;
    if (String(value || "").trim()) return false;
    if (composer.querySelector?.('img, video, audio, [contenteditable="false"], [data-testid*="attachment"]')) return false;
    return true;
  }

  globalThis.__ghrcRepositorySearchShortcut = Object.freeze({
    DEFAULT, normalize, fromEvent, matches, format, hasModifiers,
    isEditable, isEmptyComposer,
  });
})();
