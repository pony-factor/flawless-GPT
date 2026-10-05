(() => {
  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;
  const SETTING_KEY = "ownerGroupsPerRow";
  const SHOW_REPOSITORY_TOTAL_KEY = "showRepositoryTotal";
  const WIDGET_ID = "github-repositories-for-chatgpt";
  const DEFAULT_GROUPS_PER_ROW = 3;
  let showRepositoryTotal = true;
  let ownerHeaderSyncScheduled = false;

  function normalizedGroupsPerRow(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_GROUPS_PER_ROW;
    return Math.min(8, Math.max(1, parsed));
  }

  function applyGroupsPerRow(value) {
    document.documentElement.style.setProperty(
      "--ghrc-owner-groups-per-row",
      String(normalizedGroupsPerRow(value)),
    );
  }

  function createOwnerLink(className, href, ariaLabel = "") {
    const link = document.createElement("a");
    link.className = `ghrc-owner-profile-link ${className}`;
    link.href = href;
    if (ariaLabel) link.setAttribute("aria-label", ariaLabel);
    return link;
  }

  function linkOwnerHeader(header) {
    const name = header.querySelector("h3");
    const avatar = header.querySelector(".ghrc-owner-avatar");
    if (!name || !avatar) return;

    const login = (name.title || name.textContent).trim();
    if (!login) return;
    const profileUrl = header.dataset.ownerRepositoriesUrl
      || `https://github.com/${encodeURIComponent(login)}?tab=repositories`;

    const avatarLink = avatar.closest(".ghrc-owner-avatar-link");
    if (avatarLink) {
      avatarLink.href = profileUrl;
      avatarLink.setAttribute("aria-label", `Open ${login} repositories on GitHub`);
    } else {
      const link = createOwnerLink(
        "ghrc-owner-avatar-link",
        profileUrl,
        `Open ${login} repositories on GitHub`,
      );
      avatar.replaceWith(link);
      link.append(avatar);
    }

    const nameLink = name.closest(".ghrc-owner-name-link");
    if (nameLink) {
      nameLink.href = profileUrl;
    } else {
      const link = createOwnerLink("ghrc-owner-name-link", profileUrl);
      name.replaceWith(link);
      link.append(name);
    }

    const type = header.querySelector("div > span");
    if (type) type.hidden = !showRepositoryTotal;
  }

  function syncOwnerHeaders() {
    if (!context.active()) return;
    ownerHeaderSyncScheduled = false;
    document
      .querySelectorAll(`#${WIDGET_ID} .ghrc-owner-header`)
      .forEach(linkOwnerHeader);
  }

  function scheduleOwnerHeaderSync() {
    if (!context.active()) return;
    if (ownerHeaderSyncScheduled) return;
    ownerHeaderSyncScheduled = true;
    requestAnimationFrame(syncOwnerHeaders);
  }

  function mutationTouchesWidget(mutation) {
    const target = mutation.target;
    if (
      target instanceof Element
      && (target.id === WIDGET_ID || target.closest(`#${WIDGET_ID}`))
    ) return true;

    return [...mutation.addedNodes].some((node) => (
      node instanceof Element
      && (node.id === WIDGET_ID || node.querySelector(`#${WIDGET_ID}`))
    ));
  }

  async function loadSettings() {
    const settings = await chrome.storage.local.get({
      [SETTING_KEY]: DEFAULT_GROUPS_PER_ROW,
      [SHOW_REPOSITORY_TOTAL_KEY]: true,
    });
    if (!context.active()) return;
    applyGroupsPerRow(settings[SETTING_KEY]);
    showRepositoryTotal = Boolean(settings[SHOW_REPOSITORY_TOTAL_KEY]);
    scheduleOwnerHeaderSync();
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes[SETTING_KEY]) {
      applyGroupsPerRow(changes[SETTING_KEY].newValue);
    }
    if (changes[SHOW_REPOSITORY_TOTAL_KEY]) {
      showRepositoryTotal = Boolean(changes[SHOW_REPOSITORY_TOTAL_KEY].newValue);
      scheduleOwnerHeaderSync();
    }
  });

  const observer = new MutationObserver((mutations) => {
    if (mutations.some(mutationTouchesWidget)) scheduleOwnerHeaderSync();
  });
  context.onStop(() => observer.disconnect());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  scheduleOwnerHeaderSync();
  void context.run(loadSettings);
})();
