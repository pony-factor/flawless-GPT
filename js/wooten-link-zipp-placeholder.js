(() => {
  const ZIPP_SEARCH_IMAGE = "https://cdn.twibooru.org/img/2022/12/28/2860403/full.png";
  const ICON_CLASS = "ghrc-wooten-link-zipp-placeholder";

  function installPlaceholder() {
    document.querySelectorAll(".ghrc-wooten-link-submit").forEach((button) => {
      if (button.querySelector(`.${ICON_CLASS}`)) return;

      const image = document.createElement("img");
      image.className = ICON_CLASS;
      image.src = ZIPP_SEARCH_IMAGE;
      image.alt = "";
      image.setAttribute("aria-hidden", "true");
      image.referrerPolicy = "no-referrer";

      button.textContent = "";
      button.append(image);
      button.setAttribute("aria-label", "Search WootenLink");
      button.title = "Search WootenLink";
    });
  }

  installPlaceholder();
  new MutationObserver(installPlaceholder).observe(document, {
    childList: true,
    subtree: true,
  });
})();
