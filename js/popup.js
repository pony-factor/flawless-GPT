(() => {
  const GITHUB_APP_CONFIG = Object.freeze({
    clientId: "Iv23liukJaqMAIiIIfOz",
    appSlug: "flawless-chatgpt",
  });
  const PINS_PER_PAGE = 6;
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const panels = [...document.querySelectorAll('[role="tabpanel"]')];
  const openFullSettingsButton = document.getElementById("open-full-settings");
  const artwork = document.querySelector(".brand img");
  const pinList = document.getElementById("pinned-repositories");
  const pinPagination = document.getElementById("pin-pagination");
  const previousPinPageButton = document.getElementById("pin-page-previous");
  const nextPinPageButton = document.getElementById("pin-page-next");
  const pinPageStatus = document.getElementById("pin-page-status");
  let pinPage = 0;

  if (artwork) artwork.title = "Artwork by Squeaky_Belle";

  function activateTab(tab, focus = false) {
    for (const candidate of tabs) {
      const selected = candidate === tab;
      candidate.setAttribute("aria-selected", String(selected));
      candidate.tabIndex = selected ? 0 : -1;
    }

    for (const panel of panels) {
      panel.hidden = panel.id !== tab.getAttribute("aria-controls");
    }

    if (focus) tab.focus();
  }

  function pinRows() {
    return [...pinList.querySelectorAll(".pinned-repository")];
  }

  function renderPinPage() {
    const rows = pinRows();
    const totalPages = Math.max(1, Math.ceil(rows.length / PINS_PER_PAGE));
    pinPage = Math.min(pinPage, totalPages - 1);

    const start = pinPage * PINS_PER_PAGE;
    const end = start + PINS_PER_PAGE;
    rows.forEach((row, index) => {
      row.hidden = index < start || index >= end;
    });

    const isPaginated = rows.length > PINS_PER_PAGE;
    pinPagination.hidden = !isPaginated;
    pinPageStatus.textContent = `Page ${pinPage + 1} of ${totalPages}`;
    previousPinPageButton.disabled = pinPage === 0;
    nextPinPageButton.disabled = pinPage >= totalPages - 1;
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activateTab(tab));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();

      let nextIndex = index;
      if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
      if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = tabs.length - 1;
      activateTab(tabs[nextIndex], true);
    });
  });

  previousPinPageButton.addEventListener("click", () => {
    if (pinPage === 0) return;
    pinPage -= 1;
    renderPinPage();
  });

  nextPinPageButton.addEventListener("click", () => {
    const totalPages = Math.max(1, Math.ceil(pinRows().length / PINS_PER_PAGE));
    if (pinPage >= totalPages - 1) return;
    pinPage += 1;
    renderPinPage();
  });

  pinList.addEventListener("click", (event) => {
    const button = event.target.closest(".move-pin-up, .move-pin-down");
    const row = button?.closest(".pinned-repository");
    if (!row) return;

    queueMicrotask(() => {
      const index = pinRows().indexOf(row);
      if (index >= 0) pinPage = Math.floor(index / PINS_PER_PAGE);
      renderPinPage();
    });
  });

  new MutationObserver(renderPinPage).observe(pinList, { childList: true });

  openFullSettingsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());
  renderPinPage();

  const authScript = document.createElement("script");
  authScript.src = chrome.runtime.getURL("js/github-app-auth.js");
  authScript.addEventListener("load", async () => {
    await globalThis.GitHubAppAuth?.saveConfig(GITHUB_APP_CONFIG);
    await globalThis.GitHubAppAuth?.mountSettingsUi({ popup: true });
  });
  document.head.append(authScript);
})();
