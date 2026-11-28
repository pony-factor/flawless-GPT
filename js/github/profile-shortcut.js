(() => {
  "use strict";

  const context = globalThis.__ghrcExtensionContext;
  const key = "showGithubProfileShortcut";
  const marker = "data-flawless-profile-shortcut";
  let enabled = false;
  let revision = 0;
  let frame = null;
  let shortcut = null;
  let observer = null;

  function removeShortcut() {
    shortcut?.remove();
    shortcut = null;
  }

  function refresh() {
    if (!enabled || !context.active()) {
      removeShortcut();
      return;
    }

    const login = document.querySelector('meta[name="user-login"]')?.content?.trim();
    const logo = document.querySelector('a.AppHeader-logo, .AppHeader-logo a, header a:is([href="/"], [href="https://github.com/"]):has(svg.octicon-mark-github)');
    if (!login || !/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(login) || !logo?.parentElement) {
      removeShortcut();
      return;
    }

    // Read the identity from the current GitHub page, never a dashboard token.
    const nativeAvatar = document.querySelector('button[aria-label="Open user account menu"] img, button[aria-label="Open user menu"] img, summary[aria-label="View profile and more"] img');
    const nativeSrc = nativeAvatar?.getAttribute("src");
    const avatarSrc = nativeSrc && /^https:\/\/avatars\.githubusercontent\.com\//i.test(nativeSrc)
      ? nativeSrc
      : `https://github.com/${encodeURIComponent(login)}.png?size=64`;
    const href = `https://github.com/${encodeURIComponent(login)}`;

    if (!shortcut) {
      shortcut = document.createElement("a");
      shortcut.setAttribute(marker, "");
      const image = document.createElement("img");
      image.alt = "";
      image.width = 28;
      image.height = 28;
      shortcut.append(image);
    }
    if (shortcut.getAttribute("href") !== href) {
      shortcut.setAttribute("href", href);
      shortcut.setAttribute("aria-label", `Open @${login}'s profile`);
      shortcut.title = `Open @${login}'s profile`;
    }
    const image = shortcut.firstElementChild;
    if (image.getAttribute("src") !== avatarSrc) image.setAttribute("src", avatarSrc);
    if (shortcut.nextElementSibling !== logo || shortcut.parentElement !== logo.parentElement) {
      logo.before(shortcut);
    }
  }

  function schedule() {
    if (!enabled || frame !== null || !context.active()) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      refresh();
    });
  }

  function setEnabled(value) {
    enabled = value === true;
    if (enabled) {
      if (!observer) {
        observer = new MutationObserver(schedule);
        observer.observe(document, {
          childList: true, subtree: true, attributes: true,
          attributeFilter: ["src", "content", "class", "href", "aria-label"],
        });
      }
      schedule();
    } else {
      observer?.disconnect();
      observer = null;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      removeShortcut();
    }
  }

  function onStorageChanged(changes, area) {
    if (area !== "local" || !Object.hasOwn(changes, key)) return;
    revision++;
    setEnabled(changes[key].newValue);
  }

  if (!context?.active()) return;
  chrome.storage.onChanged.addListener(onStorageChanged);
  document.addEventListener("turbo:render", schedule);
  context.onStop(() => {
    setEnabled(false);
    chrome.storage.onChanged.removeListener(onStorageChanged);
    document.removeEventListener("turbo:render", schedule);
  });

  void context.run(async () => {
    const initialRevision = revision;
    const settings = await chrome.storage.local.get({ [key]: false });
    if (context.active() && initialRevision === revision) setEnabled(settings[key]);
  });
})();
