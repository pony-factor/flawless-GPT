(() => {
  const context = globalThis.__ghrcExtensionContext;
  if (context?.active() === false) return;
  const WIDGET_ID = "github-repositories-for-chatgpt";
  const SEARCH_GROUP_CLASS = "ghrc-footer-searches";
  const YOUTUBE_SEARCH_CLASS = "ghrc-youtube-search";
  const SETTING_KEY = "showYoutubeSearch";
  let mountScheduled = false;
  let settingLoaded = false;
  let showYoutubeSearch = true;

  function youtubeLogo() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "ghrc-youtube-logo");
    svg.setAttribute("viewBox", "0 0 28 20");
    svg.setAttribute("aria-hidden", "true");

    const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    background.setAttribute("width", "28");
    background.setAttribute("height", "20");
    background.setAttribute("rx", "5.5");
    background.setAttribute("fill", "#ff0000");

    const play = document.createElementNS("http://www.w3.org/2000/svg", "path");
    play.setAttribute("d", "M11 5.5 19 10l-8 4.5Z");
    play.setAttribute("fill", "#fff");

    svg.append(background, play);
    return svg;
  }

  async function openYouTubeSearch(query) {
    const url = new URL("https://www.youtube.com/results");
    url.searchParams.set("search_query", query);
    const response = await chrome.runtime.sendMessage({
      type: "open-youtube-search",
      url: url.toString(),
    });
    if (!response?.ok) {
      throw new Error(response?.error || "YouTube search could not be opened");
    }
  }

  function createYouTubeSearch() {
    const form = document.createElement("form");
    form.className = YOUTUBE_SEARCH_CLASS;

    const label = document.createElement("label");
    label.append(youtubeLogo());

    const input = document.createElement("input");
    input.type = "search";
    input.name = "search_query";
    input.placeholder = "vids";
    input.setAttribute("aria-label", "Search YouTube");
    input.autocomplete = "off";
    label.append(input);

    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "ghrc-youtube-submit";
    submit.textContent = "Search";

    form.append(label, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const query = input.value.trim();
      if (!query) {
        input.focus();
        return;
      }

      if (context?.active() === false) return;
      void openYouTubeSearch(query).catch((error) => {
        if (context) context.handleError(error);
        else console.error("YouTube search failed", error);
      });
    });
    return form;
  }

  function mountFooterSearches() {
    if (!settingLoaded || context?.active() === false) return;

    document.querySelectorAll(`#${WIDGET_ID} .ghrc-dashboard-footer`).forEach((footer) => {
      let group = footer.querySelector(`:scope > .${SEARCH_GROUP_CLASS}`);
      const wootenSearch = footer.querySelector(":scope > .ghrc-wooten-link-search")
        || group?.querySelector(":scope > .ghrc-wooten-link-search");
      let youtubeSearch = group?.querySelector(`:scope > .${YOUTUBE_SEARCH_CLASS}`);

      if (!showYoutubeSearch) {
        youtubeSearch?.remove();
        if (group && !group.children.length) group.remove();
        return;
      }

      if (!group) {
        group = document.createElement("div");
        group.className = SEARCH_GROUP_CLASS;
        const firstTrailingControl = footer.querySelector(
          ":scope > .ghrc-pagination",
        );
        footer.insertBefore(group, firstTrailingControl);
      }

      youtubeSearch = group.querySelector(`:scope > .${YOUTUBE_SEARCH_CLASS}`);
      if (!youtubeSearch) {
        youtubeSearch = createYouTubeSearch();
        group.append(youtubeSearch);
      }

      if (wootenSearch && (
        wootenSearch.parentElement !== group
        || wootenSearch.nextElementSibling !== youtubeSearch
      )) {
        group.insertBefore(wootenSearch, youtubeSearch);
      }
    });
  }

  function scheduleMount() {
    if (mountScheduled || context?.active() === false) return;
    mountScheduled = true;
    queueMicrotask(() => {
      mountScheduled = false;
      mountFooterSearches();
    });
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[SETTING_KEY]) return;
    showYoutubeSearch = changes[SETTING_KEY].newValue !== false;
    settingLoaded = true;
    scheduleMount();
  });

  const observer = new MutationObserver(scheduleMount);
  context?.onStop(() => observer.disconnect());
  observer.observe(document, {
    childList: true,
    subtree: true,
  });

  void chrome.storage.local.get({ [SETTING_KEY]: true }).then((settings) => {
    if (context?.active() === false) return;
    showYoutubeSearch = settings[SETTING_KEY] !== false;
    settingLoaded = true;
    scheduleMount();
  }).catch(error => context?.handleError(error));
})();
