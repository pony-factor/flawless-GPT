(() => {
  const SETTING_KEY = "hideRepositoryDashboard";
  const HIDDEN_ATTR = "data-ghrc-hide-repository-dashboard";
  const STYLE_ID = "ghrc-hide-repository-dashboard-style";
  let hidden = false;

  function ensureStyle() {
    if (!document.documentElement || document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `[${HIDDEN_ATTR}] #github-repositories-for-chatgpt { display: none !important; }`;
    document.documentElement.append(style);
  }

  function applyVisibility(nextHidden) {
    hidden = Boolean(nextHidden);
    ensureStyle();
    document.documentElement?.toggleAttribute(HIDDEN_ATTR, hidden);
  }

  document.addEventListener("keydown", (event) => {
    if (!hidden || !event.altKey || event.key.toLowerCase() !== "r") return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[SETTING_KEY]) return;
    applyVisibility(changes[SETTING_KEY].newValue);
  });

  void chrome.storage.local.get({ [SETTING_KEY]: false }).then((settings) => {
    applyVisibility(settings[SETTING_KEY]);
  });
})();
