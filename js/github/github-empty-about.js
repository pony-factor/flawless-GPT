(() => {
  "use strict";

  const EMPTY_ABOUT_TEXT = "No description, website, or topics provided.";
  const HIDDEN_MARKER = "data-flawless-empty-about-hidden";

  const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim();

  const hideEmptyAboutMetadata = (root = document) => {
    if (!root || typeof root.querySelectorAll !== "function") return;

    for (const element of root.querySelectorAll("p, div, span")) {
      if (element.hasAttribute(HIDDEN_MARKER)) continue;
      if (normalizeText(element.textContent) !== EMPTY_ABOUT_TEXT) continue;

      const section = element.closest(".BorderGrid-row, section");
      if (!section) continue;

      const aboutHeading = Array.from(section.querySelectorAll("h2, h3")).find(
        (heading) => normalizeText(heading.textContent) === "About"
      );
      if (!aboutHeading) continue;

      element.style.setProperty("display", "none", "important");
      element.setAttribute(HIDDEN_MARKER, "true");
    }
  };

  const refresh = () => hideEmptyAboutMetadata(document);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", refresh, { once: true });
  } else {
    refresh();
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          hideEmptyAboutMetadata(node);
        }
      }
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("turbo:render", refresh);
})();
