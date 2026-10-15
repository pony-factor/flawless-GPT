(() => {
  "use strict";

  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;

  const OVERLAY_ID = "ghrc-file-drop-overlay";
  const ROUTE_EVENT = "ghrc:route-change";
  let depth = 0;
  let feedbackTimer = null;
  let overlay = null;

  function composerInput() {
    const fromQueue = globalThis.__ghrcMessageQueue?.findComposerInput?.();
    if (fromQueue?.isConnected) return fromQueue;
    const editors = [...document.querySelectorAll(
      '#prompt-textarea, [data-composer-markdown][contenteditable="true"]'
    )];
    return editors.findLast(editor => editor.getClientRects().length > 0) || null;
  }

  function uploadInput(composer) {
    const scope = composer.closest("form")
      || composer.closest('[data-type="unified-composer"]')
      || composer.closest(".composer-parent");
    const matching = 'input[type="file"][aria-label="Attach files"], input[type="file"]';
    const scoped = scope?.querySelector(matching);
    if (scoped) return scoped;
    // A portal can place the attachment input outside the composer. Only
    // use a document-wide fallback when it is clearly the upload control.
    const named = [...document.querySelectorAll('input[type="file"][aria-label="Attach files"]')];
    if (named.length === 1) return named[0];
    const all = [...document.querySelectorAll('input[type="file"]')];
    return all.length === 1 ? all[0] : null;
  }

  function isFileDrag(event) {
    const transfer = event.dataTransfer;
    return !!transfer && (Array.from(transfer.types || []).includes("Files")
      || transfer.files?.length > 0);
  }

  function ensureOverlay() {
    if (overlay?.isConnected) return overlay;
    if (!document.body) return null;
    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.hidden = true;
    overlay.setAttribute("role", "status");
    overlay.setAttribute("aria-live", "polite");
    overlay.innerHTML =
      '<div class="ghrc-file-drop-card">' +
      '<span class="ghrc-file-drop-icon" aria-hidden="true">＋</span>' +
      '<strong class="ghrc-file-drop-title">Drop files to attach</strong>' +
      '<span class="ghrc-file-drop-detail">Add files to your message using the + attachment flow</span>' +
      '</div>';
    document.body.append(overlay);
    return overlay;
  }

  function clearTimer() {
    if (feedbackTimer !== null) {
      clearTimeout(feedbackTimer);
      feedbackTimer = null;
    }
  }

  function reset() {
    depth = 0;
    clearTimer();
    if (overlay) {
      overlay.hidden = true;
      overlay.removeAttribute("data-ghrc-drop-error");
    }
  }

  function showDragCard() {
    const node = ensureOverlay();
    if (!node) return;
    clearTimer();
    node.removeAttribute("data-ghrc-drop-error");
    node.querySelector(".ghrc-file-drop-title").textContent = "Drop files to attach";
    node.querySelector(".ghrc-file-drop-detail").textContent =
      "Add files to your message using the + attachment flow";
    node.hidden = false;
  }

  function showError(message) {
    const node = ensureOverlay();
    if (!node) return;
    clearTimer();
    node.setAttribute("data-ghrc-drop-error", "");
    node.querySelector(".ghrc-file-drop-title").textContent = "File not attached";
    node.querySelector(".ghrc-file-drop-detail").textContent = message;
    node.hidden = false;
    feedbackTimer = setTimeout(reset, 3500);
  }

  function onDragEnter(event) {
    if (!context.active() || !isFileDrag(event) || !composerInput()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    depth++;
    showDragCard();
  }

  function onDragOver(event) {
    if (!context.active() || !isFileDrag(event) || !composerInput()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    if (!depth) depth = 1; // A drag can enter before the content script mounts.
    if (!overlay || overlay.hidden) showDragCard();
  }

  function onDragLeave(event) {
    if (!depth || !isFileDrag(event)) return;
    event.stopImmediatePropagation();
    depth = Math.max(0, depth - 1);
    if (!depth) reset();
  }

  function onDrop(event) {
    if (!context.active() || !isFileDrag(event)) return;
    const composer = composerInput();
    if (!composer) { reset(); return; }

    // Block the browser's default file:// link/navigation and the page's
    // separate drop handlers, even if the upload input has disappeared.
    event.preventDefault();
    event.stopImmediatePropagation();
    const files = [...(event.dataTransfer?.files || [])];
    reset();
    if (!files.length) {
      showError("Could not read the dropped files. Use the + button instead.");
      return;
    }
    const input = uploadInput(composer);
    if (!input) {
      showError("Attachment control unavailable. Use the + button instead.");
      return;
    }
    if (files.length > 1 && !input.multiple) {
      showError("This composer only accepts one file at a time. Use the + button.");
      return;
    }

    try {
      const transfer = new DataTransfer();
      for (const file of files) transfer.items.add(file);
      // Keep React/ChatGPT in charge of validating, uploading, showing
      // attachment chips and any errors; don't mutate draft editor text.
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (error) {
      context.handleError(error);
      showError("Could not attach files. Use the + button instead.");
    }
  }

  function onEscape(event) {
    if (event.key === "Escape" && depth) reset();
  }

  const listeners = [
    [document, "dragenter", onDragEnter],
    [document, "dragover", onDragOver],
    [document, "dragleave", onDragLeave],
    [document, "drop", onDrop],
    [document, "dragend", reset],
    [document, "keydown", onEscape],
    [window, "blur", reset],
    [window, ROUTE_EVENT, reset],
  ];
  for (const [target, type, handler] of listeners) {
    target.addEventListener(type, handler, true);
  }
  context.onStop(() => {
    for (const [target, type, handler] of listeners) {
      target.removeEventListener(type, handler, true);
    }
    reset();
    overlay?.remove();
    overlay = null;
  });
})();