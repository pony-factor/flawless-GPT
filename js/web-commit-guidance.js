(() => {
  "use strict";

  const GUIDANCE_KEY = "webCommitGuidance";
  const STATUS_KEY = "webCommitGuidanceSyncStatus";
  const LEGACY_INSTRUCTION_KEYS = ["chatgptCustomInstructions", "codexCustomInstructions"];
  const LEGACY_COAUTHOR_KEYS = ["chatgptWebCoauthor", "codexWebCoauthor"];
  const COAUTHOR_TRAILER = "Co-authored-by: Codex Web <noreply@openai.com>";
  const COAUTHOR_GUIDANCE =
    "When creating Git commits through web or GitHub tools, append this trailer after a blank line:\n"
    + COAUTHOR_TRAILER;

  const textarea = document.getElementById("web-commit-guidance");
  const status = document.getElementById("web-commit-guidance-status");
  let saveTimer = null;

  function showStatus(message, state = "") {
    status.textContent = message;
    status.dataset.state = state;
  }

  function withCoauthorGuidance(guidance, enabled) {
    const text = String(guidance || "").trim();
    if (!enabled || text.includes(COAUTHOR_TRAILER)) return text;
    return [text, COAUTHOR_GUIDANCE].filter(Boolean).join("\n\n");
  }

  async function save() {
    const value = textarea.value.trim();
    await chrome.storage.local.set({ [GUIDANCE_KEY]: value });
    showStatus("Saved locally; syncing with ChatGPT…");
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void save(), 250);
  }

  async function load() {
    const keys = [
      GUIDANCE_KEY,
      STATUS_KEY,
      ...LEGACY_INSTRUCTION_KEYS,
      ...LEGACY_COAUTHOR_KEYS,
    ];
    const stored = await chrome.storage.local.get(keys);

    if (typeof stored[GUIDANCE_KEY] === "string") {
      textarea.value = stored[GUIDANCE_KEY];
    } else {
      const legacyGuidance = LEGACY_INSTRUCTION_KEYS
        .map((key) => stored[key])
        .find((value) => typeof value === "string");
      const legacyCoauthor = LEGACY_COAUTHOR_KEYS
        .map((key) => stored[key])
        .find((value) => typeof value === "boolean");
      const migrated = withCoauthorGuidance(legacyGuidance, legacyCoauthor === true);
      textarea.value = migrated;
      await chrome.storage.local.set({ [GUIDANCE_KEY]: migrated });

      const legacyKeys = [...LEGACY_INSTRUCTION_KEYS, ...LEGACY_COAUTHOR_KEYS]
        .filter((key) => Object.prototype.hasOwnProperty.call(stored, key));
      if (legacyKeys.length) {
        await chrome.storage.local.remove(legacyKeys);
        showStatus("Moved the older personalization settings into web commit guidance.", "success");
      }
    }

    const syncStatus = stored[STATUS_KEY];
    if (syncStatus?.message) showStatus(syncStatus.message, syncStatus.state || "");
  }

  textarea.addEventListener("input", scheduleSave);
  textarea.addEventListener("change", () => {
    clearTimeout(saveTimer);
    void save();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes[GUIDANCE_KEY] && typeof changes[GUIDANCE_KEY].newValue === "string"
        && changes[GUIDANCE_KEY].newValue !== textarea.value) {
      textarea.value = changes[GUIDANCE_KEY].newValue;
    }
    if (changes[STATUS_KEY]?.newValue?.message) {
      const next = changes[STATUS_KEY].newValue;
      showStatus(next.message, next.state || "");
    }
  });

  void load();
})();
