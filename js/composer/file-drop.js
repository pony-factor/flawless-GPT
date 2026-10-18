(() => {
  "use strict";

  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;

  const OVERLAY_ID = "ghrc-file-drop-overlay";
  const ROUTE_EVENT = "ghrc:route-change";
  const CONFIRM_TIMEOUT_MS = 12_000;
  let depth = 0;
  let feedbackTimer = null;
  let overlay = null;
  let confirmationTimer = null;
  let confirmationToken = 0;

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

  function attachmentCount(composer) {
    const scope = composer.closest("form")
      || composer.closest('[data-type="unified-composer"]')
      || composer.closest(".composer-parent");
    if (!scope) return 0;
    const surface = scope.querySelector(
      '[data-composer-attachments], [data-testid="composer-attachments"]'
    );
    const removeButtons = [...scope.querySelectorAll('button[aria-label*="Remove" i]')]
      .filter(button => surface?.contains(button)
        || /file|attachment|image|upload/i.test(button.getAttribute("aria-label") || ""));
    if (removeButtons.length) return removeButtons.length;
    const cards = scope.querySelectorAll('[data-filename], [data-file-name], .group\\/composer-attachment');
    return cards.length || surface?.children.length || 0;
  }

  function cancelConfirmation() {
    ++confirmationToken;
    if (confirmationTimer !== null) clearTimeout(confirmationTimer);
    confirmationTimer = null;
  }

  function confirmAttachment(composer, fileCount, previousCount) {
    const token = ++confirmationToken;
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    function check() {
      if (token !== confirmationToken || !context.active() || !composer.isConnected) return;
      if (attachmentCount(composer) >= previousCount + fileCount) {
        confirmationTimer = null;
        return;
      }
      if (Date.now() >= deadline) {
        confirmationTimer = null;
        showError(
          "No new attachment chip was confirmed. Check before sending, or use the + button.",
          "Attachment not confirmed"
        );
        return;
      }
      confirmationTimer = setTimeout(check, 250);
    }
    confirmationTimer = setTimeout(check, 250);
  }

  function isFileDrag(event) {
    const transfer = event.dataTransfer;
    return !!transfer && (Array.from(transfer.types || []).includes("Files")
      || transfer.files?.length > 0);
  }

  function finishNativeFileDrop(event) {
    // Flawless consumes the real file drop after handing the files to ChatGPT's
    // input. ChatGPT saw the initial drag, but its own drop listeners never see
    // that terminal event, leaving its click-through "Add anything" veil stuck.
    // Give the page a file-free terminal drop to release its drag UI without
    // asking it to upload the same files a second time.
    // Attaching can synchronously replace the drop target. Dispatch from the
    // nearest surviving ancestor so cleanup still reaches React's root.
    const target = event.composedPath().find(node => node instanceof Element && node.isConnected)
      || document.body;
    if (!target?.dispatchEvent) return;
    try {
      // Native drag-leave handlers can require the original Files metadata and
      // an exit outside the viewport. An empty drop/dragend alone is ignored by
      // those handlers. A leave carries no upload request, so keep the real
      // transfer here without risking a duplicate attachment.
      target.dispatchEvent(new DragEvent("dragleave", {
        bubbles: true, cancelable: true, dataTransfer: event.dataTransfer,
        clientX: 0, clientY: 0, relatedTarget: null,
      }));
      const transfer = new DataTransfer();
      target.dispatchEvent(new DragEvent("drop", {
        bubbles: true, cancelable: true, dataTransfer: transfer,
      }));
      // Also cover native drag UIs that listen for the end of a drag instead.
      target.dispatchEvent(new DragEvent("dragend", {
        bubbles: true, dataTransfer: transfer,
      }));
    } catch (error) {
      context.handleError(error);
    }
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
      '<span class="ghrc-file-drop-detail" hidden></span>' +
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
    node.querySelector(".ghrc-file-drop-detail").hidden = true;
    node.hidden = false;
  }

  function showError(message, title = "File not attached") {
    const node = ensureOverlay();
    if (!node) return;
    clearTimer();
    node.setAttribute("data-ghrc-drop-error", "");
    node.querySelector(".ghrc-file-drop-title").textContent = title;
    node.querySelector(".ghrc-file-drop-detail").textContent = message;
    node.querySelector(".ghrc-file-drop-detail").hidden = false;
    node.hidden = false;
    feedbackTimer = setTimeout(reset, 3500);
  }

  function onDragEnter(event) {
    if (!context.active() || !isFileDrag(event) || !composerInput()) return;
    // Keep the native drag lifecycle intact in case the upload input vanishes
    // before drop. The overlay is visual only until we can commit the handoff.
    depth++;
    showDragCard();
  }

  function onDragOver(event) {
    if (!context.active() || !isFileDrag(event)) return;
    const composer = composerInput();
    if (!composer) return;
    // Allow the page's native drag handlers to prepare their own fallback.
    if (uploadInput(composer)) event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    if (!depth) depth = 1; // A drag can enter before the content script mounts.
    if (!overlay || overlay.hidden) showDragCard();
  }

  function onDragLeave(event) {
    if (!depth || !isFileDrag(event)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) reset();
  }

  function onDrop(event) {
    if (!context.active() || !isFileDrag(event)) return;
    const composer = composerInput();
    if (!composer) { reset(); return; }

    const files = [...(event.dataTransfer?.files || [])];
    const previousCount = attachmentCount(composer);
    const input = uploadInput(composer);
    reset();
    cancelConfirmation();
    if (!files.length) {
      event.preventDefault();
      event.stopImmediatePropagation();
      showError("Could not read the dropped files. Use the + button instead.");
      return;
    }

    if (!input || input.disabled || (files.length > 1 && !input.multiple)) {
      // No safe input handoff. Do not swallow the event: ChatGPT's native
      // drop target may be able to attach these files even without an input.
      // The bubble listener blocks only the browser's default navigation.
      confirmAttachment(composer, files.length, previousCount);
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      const transfer = new DataTransfer();
      for (const file of files) transfer.items.add(file);
      // Let ChatGPT validate/upload and render attachment chips; the change
      // event itself is not evidence that an attachment was accepted.
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      confirmAttachment(composer, files.length, previousCount);
    } catch (error) {
      context.handleError(error);
      showError("Could not attach files. Use the + button instead.");
    } finally {
      finishNativeFileDrop(event);
    }
  }

  function preventUnhandledFileDrop(event) {
    // Runs after ChatGPT's target handlers, preserving native attachment
    // processing while preventing browser file:// navigation/text insertion.
    if (context.active() && isFileDrag(event) && composerInput()) event.preventDefault();
  }

  function onEscape(event) {
    if (event.key === "Escape" && depth) reset();
  }

  const listeners = [
    [document, "dragenter", onDragEnter],
    [document, "dragover", onDragOver],
    [document, "dragleave", onDragLeave],
    [document, "drop", onDrop],
    [document, "drop", preventUnhandledFileDrop, false],
    [document, "dragend", reset],
    [document, "keydown", onEscape],
    [window, "blur", reset],
    [window, ROUTE_EVENT, () => { reset(); cancelConfirmation(); }],
  ];
  for (const [target, type, handler, capture = true] of listeners) {
    target.addEventListener(type, handler, capture);
  }
  context.onStop(() => {
    for (const [target, type, handler, capture = true] of listeners) {
      target.removeEventListener(type, handler, capture);
    }
    cancelConfirmation();
    reset();
    overlay?.remove();
    overlay = null;
  });
})();
