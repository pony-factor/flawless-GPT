(() => {
  const GITHUB_APP_CONFIG = Object.freeze({
    clientId: "Iv23liukJaqMAIiIIfOz",
    appSlug: "flawless-chatgpt",
  });

  const settingsTabs = [...document.querySelectorAll(".standalone-settings-tab")];
  const settingsPanels = [...document.querySelectorAll(".standalone-settings-panel")];

  function activateSettingsTab(tab, focus = false) {
    if (!tab) return;

    for (const candidate of settingsTabs) {
      const selected = candidate === tab;
      candidate.setAttribute("aria-selected", String(selected));
      candidate.tabIndex = selected ? 0 : -1;
    }

    for (const panel of settingsPanels) {
      panel.hidden = panel.id !== tab.getAttribute("aria-controls");
    }

    sessionStorage.setItem("flawless-options-tab", tab.id);
    if (focus) tab.focus();
  }

  settingsTabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activateSettingsTab(tab));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();

      let nextIndex = index;
      if (event.key === "ArrowLeft") nextIndex = (index - 1 + settingsTabs.length) % settingsTabs.length;
      if (event.key === "ArrowRight") nextIndex = (index + 1) % settingsTabs.length;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = settingsTabs.length - 1;
      activateSettingsTab(settingsTabs[nextIndex], true);
    });
  });

  const savedSettingsTab = sessionStorage.getItem("flawless-options-tab");
  activateSettingsTab(
    settingsTabs.find((tab) => tab.id === savedSettingsTab) || settingsTabs[0],
  );

  const artwork = document.getElementById("standalone-artwork");
  const animatedPath = artwork?.dataset.animatedSrc;

  if (artwork && animatedPath) {
    artwork.title = "Artwork by Squeaky_Belle";

    const animatedUrl = chrome.runtime.getURL(animatedPath);
    fetch(animatedUrl)
      .then((response) => {
        if (response.ok) artwork.src = animatedUrl;
      })
      .catch(() => {
        // Keep the bundled WebP fallback until the optional GIF is added.
      });
  }

  const authScript = document.createElement("script");
  authScript.src = chrome.runtime.getURL("js/github-app-auth.js");
  authScript.addEventListener("load", async () => {
    await globalThis.GitHubAppAuth?.saveConfig(GITHUB_APP_CONFIG);
    await globalThis.GitHubAppAuth?.mountSettingsUi({ popup: false });
  });
  document.head.append(authScript);
})();
