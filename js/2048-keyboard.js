(() => {
  "use strict";
  const GAME_EVENT = "ghrc:2048-key";
  const GAME_ID = "ghrc-2048-modal";
  const GAME_KEYS = new Set([
    "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
    ".", ">", "u", "U", "o", "O", "e", "E",
  ]);

  // Install at document_start, before the host's global shortcut handlers.
  window.addEventListener("keydown", (event) => {
    if (!document.getElementById(GAME_ID) || !GAME_KEYS.has(event.key)
      || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    document.dispatchEvent(new CustomEvent(GAME_EVENT, { detail: { key: event.key } }));
  }, true);
})();
