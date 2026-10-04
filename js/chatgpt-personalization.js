(() => {
  const INSTRUCTIONS_KEY = "chatgptCustomInstructions";
  const COAUTHOR_KEY = "chatgptWebCoauthor";
  const LEGACY_INSTRUCTIONS_KEY = "codexCustomInstructions";
  const LEGACY_COAUTHOR_KEY = "codexWebCoauthor";
  const instructions = document.getElementById("chatgpt-custom-instructions");
  const coauthor = document.getElementById("chatgpt-web-coauthor");
  const importFromClipboard = document.getElementById("import-chatgpt-personalization");
  const status = document.getElementById("chatgpt-personalization-status");

  function showStatus(message, state = "") {
    status.textContent = message;
    status.dataset.state = state;
  }

  async function save(message = "Personalization saved locally.") {
    await chrome.storage.local.set({
      [INSTRUCTIONS_KEY]: instructions.value.trim(),
      [COAUTHOR_KEY]: coauthor.checked,
    });
    showStatus(message, "success");
  }

  async function load() {
    const stored = await chrome.storage.local.get([
      INSTRUCTIONS_KEY,
      COAUTHOR_KEY,
      LEGACY_INSTRUCTIONS_KEY,
      LEGACY_COAUTHOR_KEY,
    ]);
    const has = (key) => Object.prototype.hasOwnProperty.call(stored, key);
    const migrated = {};

    if (typeof stored[INSTRUCTIONS_KEY] === "string") {
      instructions.value = stored[INSTRUCTIONS_KEY];
    } else if (typeof stored[LEGACY_INSTRUCTIONS_KEY] === "string") {
      instructions.value = stored[LEGACY_INSTRUCTIONS_KEY];
      migrated[INSTRUCTIONS_KEY] = stored[LEGACY_INSTRUCTIONS_KEY];
    }

    if (typeof stored[COAUTHOR_KEY] === "boolean") {
      coauthor.checked = stored[COAUTHOR_KEY];
    } else if (typeof stored[LEGACY_COAUTHOR_KEY] === "boolean") {
      coauthor.checked = stored[LEGACY_COAUTHOR_KEY];
      migrated[COAUTHOR_KEY] = stored[LEGACY_COAUTHOR_KEY];
    } else {
      coauthor.checked = true;
    }

    if (Object.keys(migrated).length) {
      await chrome.storage.local.set(migrated);
    }
    const legacyKeys = [LEGACY_INSTRUCTIONS_KEY, LEGACY_COAUTHOR_KEY].filter(has);
    if (legacyKeys.length) {
      await chrome.storage.local.remove(legacyKeys);
      showStatus("Moved personalization settings to browser-only storage.", "success");
    }
  }

  importFromClipboard.addEventListener("click", async () => {
    try {
      const value = (await navigator.clipboard.readText()).trim();
      if (!value) throw new Error("Clipboard is empty.");
      instructions.value = value;
      await save("Imported custom instructions from the clipboard.");
    } catch (error) {
      showStatus(`Could not read custom instructions from the clipboard: ${error.message}`, "error");
    }
  });

  coauthor.addEventListener("change", () => void save("Co-author preference saved locally."));
  instructions.addEventListener("change", () => void save());

  void load();
})();
