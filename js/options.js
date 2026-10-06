const DEFAULT_OWNER_ORDER = [];
const DEFAULT_HIDDEN_OWNERS = [];
const DEFAULT_OWNER_GROUPS_PER_PAGE = 6;
const form = document.getElementById("settings-form");
const tokenSettings = document.getElementById("token-settings");
const tokenSummary = document.getElementById("token-summary");
const tokenList = document.getElementById("github-tokens");
const tokenRowTemplate = document.getElementById("token-row-template");
const addTokenButton = document.getElementById("add-token");
const githubAccountList = document.getElementById("github-accounts");
const githubAccountTemplate = document.getElementById("github-account-template");
const ownerGroupsPerPageInput = document.getElementById("owner-groups-per-page");
const showRepositorySearchInput = document.getElementById("show-repository-search");
const showRepositoryTotalInput = document.getElementById("show-repository-total");
const showWootenLinkSearchInput = document.getElementById("show-wooten-link-search");
const showYoutubeSearchInput = document.getElementById("show-youtube-search");
const pinnedRepositoryList = document.getElementById("pinned-repositories");
const pinnedRepositoryTemplate = document.getElementById("pinned-repository-template");
const hideDictationButtonInput = document.getElementById("hide-dictation-button");
const preserveScrollPositionOnSendInput = document.getElementById("preserve-scroll-position-on-send");
const hideShareLabelInput = document.getElementById("hide-share-label");
const compactNewChatHeaderInput = document.getElementById("compact-new-chat-header");
const disableWorkModeInput = document.getElementById("disable-work-mode");
const showSpellcheckGptLauncherInput = document.getElementById("show-spellcheck-gpt-launcher");
const show2048LauncherInput = document.getElementById("show-2048-launcher");
const showDeepResearchTrackerInput = document.getElementById("show-deep-research-tracker");
const stripUtmTrackingInput = document.getElementById("strip-utm-tracking");
const stripCopiedBoldInput = document.getElementById("strip-copied-bold");
const normalizeCopiedQuotesInput = document.getElementById("normalize-copied-quotes");
const underscoreCopiedItalicsInput = document.getElementById("underscore-copied-italics");
const openExternalLinksInNewTabsInput = document.getElementById("open-external-links-in-new-tabs");
const nativeSplitViewDomainsInput = document.getElementById("native-split-view-domains");
const openExternalLinksInSplitViewInput = document.getElementById("open-external-links-in-split-view");
const skipExternalSiteWarningInput = document.getElementById("skip-external-site-warning");
const dismissHistoryRateLimitModalInput = document.getElementById("dismiss-history-rate-limit-modal");
const hideUsageCardInput = document.getElementById("hide-usage-card");
const hideHomeSuggestionsInput = document.getElementById("hide-home-suggestions");
const hideModelControlsInput = document.getElementById("hide-model-controls");
const hideConversationFeedbackPromptInput = document.getElementById("hide-conversation-feedback-prompt");
const hideChatTimestampsInput = document.getElementById("hide-chat-timestamps");
const composerPlaceholderInput = document.getElementById("composer-placeholder");
const hideChatgptDisclaimerInput = document.getElementById("hide-chatgpt-disclaimer");
const hideCookiePreferencesInput = document.getElementById("hide-cookie-preferences");
const clearTokensButton = document.getElementById("clear-tokens");
const status = document.getElementById("status");
let saveQueue = Promise.resolve();
let tokenStateLoaded = false;
let tokenInputsDirty = false;
let ownerListDirty = false;

function normalizedOwnerOrder(owners) {
  const seen = new Set();
  return (Array.isArray(owners) ? owners : [])
    .map((owner) => typeof owner === "string" ? owner.trim() : "")
    .filter((owner) => {
      const key = owner.toLowerCase();
      if (!owner || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function normalizedHiddenOwners(owners) {
  return normalizedOwnerOrder(owners);
}

function githubAccountOrderFromList() {
  return [...githubAccountList.querySelectorAll(".github-account")]
    .map((row) => row.dataset.owner)
    .filter(Boolean);
}

function hiddenOwnersFromList() {
  return [...githubAccountList.querySelectorAll(".github-account")]
    .filter((row) => !row.querySelector(".github-account-visible")?.checked)
    .map((row) => row.dataset.owner)
    .filter(Boolean);
}

function updateGithubAccountControls() {
  const rows = [...githubAccountList.querySelectorAll(".github-account")];
  rows.forEach((row, index) => {
    row.querySelector(".move-account-up").disabled = index === 0;
    row.querySelector(".move-account-down").disabled = index === rows.length - 1;
  });
}

function moveGithubAccount(row, direction) {
  const sibling = direction < 0 ? row.previousElementSibling : row.nextElementSibling;
  if (!sibling?.classList.contains("github-account")) return;
  if (direction < 0) githubAccountList.insertBefore(row, sibling);
  else githubAccountList.insertBefore(sibling, row);
  ownerListDirty = true;
  updateGithubAccountControls();
  row.querySelector(direction < 0 ? ".move-account-up" : ".move-account-down").focus();
  void queueSettingsSave();
}

function createGithubAccountRow(owner, hiddenOwnerKeys) {
  const row = githubAccountTemplate.content.firstElementChild.cloneNode(true);
  row.dataset.owner = owner;
  row.querySelector("code").textContent = owner;
  row.querySelector(".github-account-visible").checked = !hiddenOwnerKeys.has(owner.toLowerCase());
  row.querySelector(".move-account-up").addEventListener("click", () => moveGithubAccount(row, -1));
  row.querySelector(".move-account-down").addEventListener("click", () => moveGithubAccount(row, 1));
  return row;
}

function renderGithubAccounts(ownerOrder, hiddenOwners = []) {
  const owners = normalizedOwnerOrder(ownerOrder);
  if (!owners.length) {
    const empty = document.createElement("p");
    empty.className = "github-accounts-empty";
    empty.textContent = "No GitHub accounts discovered yet.";
    githubAccountList.replaceChildren(empty);
    return;
  }

  const hiddenOwnerKeys = new Set(
    normalizedHiddenOwners(hiddenOwners).map((owner) => owner.toLowerCase()),
  );
  githubAccountList.replaceChildren(
    ...owners.map((owner) => createGithubAccountRow(owner, hiddenOwnerKeys)),
  );
  updateGithubAccountControls();
}

let draggedGithubAccount = null;
githubAccountList.addEventListener("dragstart", (event) => {
  const row = event.target.closest(".github-account");
  if (!row) return;
  draggedGithubAccount = row;
  row.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", row.dataset.owner);
});
githubAccountList.addEventListener("dragover", (event) => {
  const target = event.target.closest(".github-account");
  if (!draggedGithubAccount || !target || target === draggedGithubAccount) return;
  event.preventDefault();
  const bounds = target.getBoundingClientRect();
  const insertAfter = event.clientY > bounds.top + (bounds.height / 2);
  githubAccountList.insertBefore(
    draggedGithubAccount,
    insertAfter ? target.nextSibling : target,
  );
});
githubAccountList.addEventListener("drop", (event) => {
  if (!draggedGithubAccount) return;
  event.preventDefault();
  ownerListDirty = true;
  updateGithubAccountControls();
});
githubAccountList.addEventListener("dragend", () => {
  draggedGithubAccount?.classList.remove("dragging");
  draggedGithubAccount = null;
  ownerListDirty = true;
  updateGithubAccountControls();
  void queueSettingsSave();
});

function normalizedOwnerGroupsPerPage(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_OWNER_GROUPS_PER_PAGE;
  return Math.min(24, Math.max(1, parsed));
}

function showStatus(message, state = "") {
  status.textContent = message;
  status.dataset.state = state;
}

function updateTokenSummary() {
  const count = [...tokenList.querySelectorAll(".token-value")]
    .filter((input) => input.value.trim()).length;
  tokenSummary.textContent = count === 0
    ? "Not configured"
    : count === 1 ? "1 configured" : `${count} configured`;
}

function createTokenRow({ label = "", owner = "", token = "" } = {}) {
  const row = tokenRowTemplate.content.firstElementChild.cloneNode(true);
  row.querySelector(".token-label").value = label || owner;
  row.querySelector(".token-value").value = token;
  row.querySelector(".remove-token").addEventListener("click", () => {
    row.remove();
    if (!tokenList.querySelector(".token-row")) {
      tokenList.append(createTokenRow());
    }
    tokenInputsDirty = true;
    updateTokenSummary();
    void queueSettingsSave();
  });
  return row;
}

function renderTokenRows(configuredTokens) {
  const tokenRows = configuredTokens.length ? configuredTokens : [{}];
  tokenList.replaceChildren(...tokenRows.map((token) => createTokenRow(token)));
  updateTokenSummary();
}

function tokensFromInput() {
  const tokens = [];
  const seenTokens = new Set();
  for (const row of tokenList.querySelectorAll(".token-row")) {
    const label = row.querySelector(".token-label").value.trim();
    const token = row.querySelector(".token-value").value.trim();
    if (!token) continue;
    if (seenTokens.has(token)) return null;
    seenTokens.add(token);
    tokens.push({ label: label || `Token ${tokens.length + 1}`, token });
  }
  return tokens;
}

function normalizedPins(pinnedRepositories) {
  const seen = new Set();
  return (Array.isArray(pinnedRepositories) ? pinnedRepositories : [])
    .filter((fullName) => typeof fullName === "string" && fullName.includes("/"))
    .map((fullName) => fullName.trim())
    .filter((fullName) => {
      const key = fullName.toLowerCase();
      if (!fullName || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function pinnedRepositoriesFromList() {
  return [...pinnedRepositoryList.querySelectorAll(".pinned-repository")]
    .map((row) => row.dataset.repository);
}

function updatePinControls() {
  const rows = [...pinnedRepositoryList.querySelectorAll(".pinned-repository")];
  rows.forEach((row, index) => {
    row.querySelector(".move-pin-up").disabled = index === 0;
    row.querySelector(".move-pin-down").disabled = index === rows.length - 1;
  });
}

function movePin(row, direction) {
  const sibling = direction < 0 ? row.previousElementSibling : row.nextElementSibling;
  if (!sibling?.classList.contains("pinned-repository")) return;
  if (direction < 0) pinnedRepositoryList.insertBefore(row, sibling);
  else pinnedRepositoryList.insertBefore(sibling, row);
  updatePinControls();
  row.querySelector(direction < 0 ? ".move-pin-up" : ".move-pin-down").focus();
  void queueSettingsSave();
}

function createPinnedRepositoryRow(fullName) {
  const row = pinnedRepositoryTemplate.content.firstElementChild.cloneNode(true);
  row.dataset.repository = fullName;
  row.querySelector("code").textContent = fullName;
  row.querySelector(".move-pin-up").addEventListener("click", () => movePin(row, -1));
  row.querySelector(".move-pin-down").addEventListener("click", () => movePin(row, 1));
  row.querySelector(".remove-pin").addEventListener("click", () => {
    row.remove();
    if (!pinnedRepositoriesFromList().length) renderPinnedRepositories([]);
    updatePinControls();
    void queueSettingsSave();
  });
  return row;
}

function renderPinnedRepositories(pinnedRepositories) {
  const pins = normalizedPins(pinnedRepositories);
  if (!pins.length) {
    const empty = document.createElement("p");
    empty.className = "pinned-repositories-empty";
    empty.textContent = "No repositories pinned yet.";
    pinnedRepositoryList.replaceChildren(empty);
    return;
  }
  pinnedRepositoryList.replaceChildren(...pins.map(createPinnedRepositoryRow));
  updatePinControls();
}

let draggedPin = null;
pinnedRepositoryList.addEventListener("dragstart", (event) => {
  const row = event.target.closest(".pinned-repository");
  if (!row) return;
  draggedPin = row;
  row.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", row.dataset.repository);
});
pinnedRepositoryList.addEventListener("dragover", (event) => {
  const target = event.target.closest(".pinned-repository");
  if (!draggedPin || !target || target === draggedPin) return;
  event.preventDefault();
  const bounds = target.getBoundingClientRect();
  const insertAfter = event.clientY > bounds.top + (bounds.height / 2);
  pinnedRepositoryList.insertBefore(draggedPin, insertAfter ? target.nextSibling : target);
});
pinnedRepositoryList.addEventListener("drop", (event) => {
  event.preventDefault();
  updatePinControls();
});
pinnedRepositoryList.addEventListener("dragend", () => {
  draggedPin?.classList.remove("dragging");
  draggedPin = null;
  updatePinControls();
  void queueSettingsSave();
});

async function loadSettings() {
  const settings = await chrome.storage.local.get({
    ownerOrder: DEFAULT_OWNER_ORDER,
    hiddenOwners: DEFAULT_HIDDEN_OWNERS,
    ownerGroupsPerPage: DEFAULT_OWNER_GROUPS_PER_PAGE,
    showRepositorySearch: true,
    showRepositoryTotal: true,
    showWootenLinkSearch: false,
    showYoutubeSearch: true,
    pinnedRepositories: [],
    hideDictationButton: false,
    preserveScrollPositionOnSend: false,
    hideShareLabel: false,
    compactNewChatHeader: false,
    disableWorkMode: false,
    showSpellcheckGptLauncher: false,
    show2048Launcher: false,
    showDeepResearchTracker: true,
    stripUtmTracking: true,
    stripCopiedBold: true,
    normalizeCopiedQuotes: true,
    underscoreCopiedItalics: true,
    skipExternalSiteWarning: true,
    openExternalLinksInNewTabs: true,
    openExternalLinksInSplitView: false,
    nativeSplitViewDomains: ["github.com"],
    dismissHistoryRateLimitModal: true,
    hideUsageCard: true,
    hideCookiePreferences: false,
    showChatgptDisclaimer: false,
    hideHomeSuggestions: true,
    hideModelControls: true,
    hideConversationFeedbackPrompt: true,
    hideChatTimestamps: false,
    composerPlaceholder: "",
  });
  const storedOwnerOrder = normalizedOwnerOrder(settings.ownerOrder);
  let configuredTokens = [];

  try {
    configuredTokens = await TokenVault.loadTokens();
    tokenStateLoaded = true;
  } catch (error) {
    showStatus(error.message, "error");
  }

  renderTokenRows(configuredTokens);
  tokenInputsDirty = false;
  tokenSettings.open = configuredTokens.length === 0;
  renderPinnedRepositories(settings.pinnedRepositories);
  renderGithubAccounts(storedOwnerOrder, settings.hiddenOwners);
  ownerGroupsPerPageInput.value = normalizedOwnerGroupsPerPage(settings.ownerGroupsPerPage);
  showRepositorySearchInput.checked = Boolean(settings.showRepositorySearch);
  showRepositoryTotalInput.checked = Boolean(settings.showRepositoryTotal);
  showWootenLinkSearchInput.checked = Boolean(settings.showWootenLinkSearch);
  showYoutubeSearchInput.checked = settings.showYoutubeSearch !== false;
  hideDictationButtonInput.checked = Boolean(settings.hideDictationButton);
  preserveScrollPositionOnSendInput.checked = Boolean(settings.preserveScrollPositionOnSend);
  hideShareLabelInput.checked = Boolean(settings.hideShareLabel);
  compactNewChatHeaderInput.checked = Boolean(settings.compactNewChatHeader);
  disableWorkModeInput.checked = Boolean(settings.disableWorkMode);
  showSpellcheckGptLauncherInput.checked = Boolean(settings.showSpellcheckGptLauncher);
  show2048LauncherInput.checked = Boolean(settings.show2048Launcher);
  showDeepResearchTrackerInput.checked = settings.showDeepResearchTracker !== false;
  stripUtmTrackingInput.checked = settings.stripUtmTracking !== false;
  stripCopiedBoldInput.checked = settings.stripCopiedBold !== false;
  normalizeCopiedQuotesInput.checked = settings.normalizeCopiedQuotes !== false;
  underscoreCopiedItalicsInput.checked = settings.underscoreCopiedItalics !== false;
  openExternalLinksInNewTabsInput.checked = settings.openExternalLinksInNewTabs !== false;
  openExternalLinksInSplitViewInput.checked = Boolean(settings.openExternalLinksInSplitView);
  nativeSplitViewDomainsInput.value = (settings.nativeSplitViewDomains || ["github.com"]).join("\n");
  skipExternalSiteWarningInput.checked = Boolean(settings.skipExternalSiteWarning);
  dismissHistoryRateLimitModalInput.checked = Boolean(settings.dismissHistoryRateLimitModal);
  hideUsageCardInput.checked = settings.hideUsageCard !== false;
  hideHomeSuggestionsInput.checked = settings.hideHomeSuggestions !== false;
  hideModelControlsInput.checked = settings.hideModelControls !== false;
  hideConversationFeedbackPromptInput.checked = settings.hideConversationFeedbackPrompt !== false;
  hideChatTimestampsInput.checked = Boolean(settings.hideChatTimestamps);
  composerPlaceholderInput.value = typeof settings.composerPlaceholder === "string" ? settings.composerPlaceholder : "";
  hideChatgptDisclaimerInput.checked = !Boolean(settings.showChatgptDisclaimer);
  hideCookiePreferencesInput.checked = Boolean(settings.hideCookiePreferences);

  try {
    const payload = await chrome.runtime.sendMessage({ type: "load-repositories" });
    if (payload?.ok && !ownerListDirty) {
      const discoveredOwners = Array.isArray(payload.repositories)
        ? payload.repositories.map((repository) => repository?.owner?.login)
        : [];
      const mergedOwnerOrder = normalizedOwnerOrder([
        ...githubAccountOrderFromList(),
        ...(Array.isArray(payload.ownerOrder) ? payload.ownerOrder : []),
        ...discoveredOwners,
      ]);
      renderGithubAccounts(mergedOwnerOrder, hiddenOwnersFromList());
    }
  } catch {
    // Keep the already-rendered settings if repository discovery is unavailable.
  }
}

addTokenButton.addEventListener("click", () => {
  tokenSettings.open = true;
  const row = createTokenRow();
  tokenList.append(row);
  updateTokenSummary();
  row.querySelector(".token-label").focus();
});

tokenList.addEventListener("input", () => {
  tokenInputsDirty = true;
  updateTokenSummary();
});

async function saveSettings() {
  const enteredOwnerOrder = githubAccountOrderFromList();
  const hiddenOwners = hiddenOwnersFromList();
  const ownerGroupsPerPage = normalizedOwnerGroupsPerPage(ownerGroupsPerPageInput.value);
  let githubTokens = null;
  let shouldSaveTokens = false;

  if (tokenInputsDirty) {
    githubTokens = tokensFromInput();
    if (!githubTokens) {
      tokenSettings.open = true;
      showStatus("Remove the duplicate token before saving.", "error");
      return;
    }

    // A failed vault load renders an empty token row. Do not let an unrelated
    // settings change write that empty state over token data that may still be
    // recoverable. A non-empty token entry or Clear tokens remains explicit.
    shouldSaveTokens = tokenStateLoaded || githubTokens.length > 0;
  }

  try {
    if (shouldSaveTokens) {
      await TokenVault.saveTokens(githubTokens);
      tokenStateLoaded = true;
      tokenInputsDirty = false;
    }
    await chrome.storage.local.set({
      ownerOrder: enteredOwnerOrder,
      hiddenOwners,
      ownerGroupsPerPage,
      showRepositorySearch: showRepositorySearchInput.checked,
      showRepositoryTotal: showRepositoryTotalInput.checked,
      showWootenLinkSearch: showWootenLinkSearchInput.checked,
      showYoutubeSearch: showYoutubeSearchInput.checked,
      pinnedRepositories: pinnedRepositoriesFromList(),
      hideDictationButton: hideDictationButtonInput.checked,
      preserveScrollPositionOnSend: preserveScrollPositionOnSendInput.checked,
      hideShareLabel: hideShareLabelInput.checked,
      compactNewChatHeader: compactNewChatHeaderInput.checked,
      disableWorkMode: disableWorkModeInput.checked,
      showSpellcheckGptLauncher: showSpellcheckGptLauncherInput.checked,
      show2048Launcher: show2048LauncherInput.checked,
      showDeepResearchTracker: showDeepResearchTrackerInput.checked,
      stripUtmTracking: stripUtmTrackingInput.checked,
      stripCopiedBold: stripCopiedBoldInput.checked,
      normalizeCopiedQuotes: normalizeCopiedQuotesInput.checked,
      underscoreCopiedItalics: underscoreCopiedItalicsInput.checked,
      skipExternalSiteWarning: skipExternalSiteWarningInput.checked,
      openExternalLinksInNewTabs: openExternalLinksInNewTabsInput.checked,
      openExternalLinksInSplitView: openExternalLinksInSplitViewInput.checked,
      nativeSplitViewDomains: [...new Set(nativeSplitViewDomainsInput.value.split(/[\s,]+/)
        .map(value => value.trim().toLowerCase()).filter(value => /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/.test(value)))],
      dismissHistoryRateLimitModal: dismissHistoryRateLimitModalInput.checked,
      hideUsageCard: hideUsageCardInput.checked,
      hideCookiePreferences: hideCookiePreferencesInput.checked,
      showChatgptDisclaimer: !hideChatgptDisclaimerInput.checked,
      hideHomeSuggestions: hideHomeSuggestionsInput.checked,
      hideModelControls: hideModelControlsInput.checked,
      hideConversationFeedbackPrompt: hideConversationFeedbackPromptInput.checked,
      hideChatTimestamps: hideChatTimestampsInput.checked,
      composerPlaceholder: composerPlaceholderInput.value.trim(),
    });
    ownerListDirty = false;
    ownerGroupsPerPageInput.value = ownerGroupsPerPage;
    updateTokenSummary();
    showStatus(
      tokenStateLoaded
        ? "Settings saved automatically."
        : "Settings saved. Existing tokens were left untouched because the token vault could not be loaded.",
      tokenStateLoaded ? "success" : "error",
    );
  } catch (error) {
    showStatus(`Settings could not be saved: ${error.message}`, "error");
  }
}

function queueSettingsSave() {
  saveQueue = saveQueue.catch(() => {}).then(saveSettings);
  return saveQueue;
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void queueSettingsSave();
});

nativeSplitViewDomainsInput.addEventListener("input", () => { void queueSettingsSave(); });

form.addEventListener("change", (event) => {
  if (event.target.closest(".token-row")) tokenInputsDirty = true;
  if (event.target.closest(".github-account")) ownerListDirty = true;
  void queueSettingsSave();
});

clearTokensButton.addEventListener("click", async () => {
  try {
    renderTokenRows([]);
    tokenSettings.open = true;
    await TokenVault.clearTokens();
    tokenStateLoaded = true;
    tokenInputsDirty = false;
    showStatus("Tokens cleared. Only public repositories will be loaded.", "success");
  } catch (error) {
    showStatus(`Tokens could not be cleared: ${error.message}`, "error");
  }
});

void loadSettings();
