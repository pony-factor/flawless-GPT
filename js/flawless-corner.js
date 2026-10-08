(() => {
  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;

  const CARD_ID = "ghrc-flawless-corner";
  let card = null;

  function mountCard() {
    if (!context.active() || !document.body || card?.isConnected) return;

    const existing = document.getElementById(CARD_ID);
    if (existing) {
      card = existing;
      return;
    }

    const nextCard = document.createElement("a");
    nextCard.id = CARD_ID;
    nextCard.href = "/";
    nextCard.setAttribute("aria-label", "New chat");
    nextCard.title = "New chat";

    const image = document.createElement("img");
    image.alt = "";
    image.decoding = "async";
    image.draggable = false;
    try {
      image.src = chrome.runtime.getURL("artwork/squeaky-belle-full.webp");
    } catch (error) {
      context.handleError(error);
      return;
    }

    nextCard.append(image);
    document.body.append(nextCard);
    card = nextCard;
  }

  // Remain visible when ChatGPT replaces its sidebar during navigation.
  const observer = new MutationObserver(() => {
    if (!card?.isConnected) mountCard();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", mountCard, { once: true });
  mountCard();

  context.onStop(() => {
    observer.disconnect();
    document.removeEventListener("DOMContentLoaded", mountCard);
    card?.remove();
  });
})();
