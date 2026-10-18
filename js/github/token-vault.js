(() => {
  const DATABASE_NAME = "ghrc-token-vault";
  const DATABASE_VERSION = 1;
  const KEY_STORE_NAME = "keys";
  const KEY_ID = "github-token-aes-gcm-v1";
  const ENCRYPTED_STORAGE_KEY = "encryptedGithubTokens";
  const CIPHER_VERSION = 1;
  const IV_LENGTH = 12;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(KEY_STORE_NAME)) {
          request.result.createObjectStore(KEY_STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open token vault."));
      request.onblocked = () => reject(new Error("Token vault database is blocked."));
    });
  }

  async function getExistingKey() {
    const database = await openDatabase();

    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(KEY_STORE_NAME, "readonly");
        const request = transaction.objectStore(KEY_STORE_NAME).get(KEY_ID);

        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error("Could not read token vault key."));
      });
    } finally {
      database.close();
    }
  }

  async function getOrCreateKey() {
    const existingKey = await getExistingKey();
    if (existingKey) return existingKey;

    const candidateKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const database = await openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(KEY_STORE_NAME, "readwrite");
      const store = transaction.objectStore(KEY_STORE_NAME);
      const request = store.get(KEY_ID);
      let selectedKey = candidateKey;

      request.onsuccess = () => {
        if (request.result) {
          selectedKey = request.result;
        } else {
          store.put(candidateKey, KEY_ID);
        }
      };
      request.onerror = () => {
        reject(request.error || new Error("Could not create token vault key."));
      };
      transaction.oncomplete = () => {
        database.close();
        resolve(selectedKey);
      };
      transaction.onabort = () => {
        database.close();
        reject(transaction.error || new Error("Could not create token vault key."));
      };
      transaction.onerror = () => {
        // onabort reports the final transaction failure.
      };
    });
  }

  function bytesToBase64(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  function base64ToBytes(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  async function encryptToken(token, key) {
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      encoder.encode(token),
    );

    return {
      version: CIPHER_VERSION,
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    };
  }

  async function decryptToken(entry, key) {
    if (
      entry?.version !== CIPHER_VERSION
      || typeof entry.iv !== "string"
      || typeof entry.ciphertext !== "string"
    ) {
      throw new Error("Encrypted GitHub token data is not in a supported format.");
    }

    try {
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: base64ToBytes(entry.iv) },
        key,
        base64ToBytes(entry.ciphertext),
      );
      return decoder.decode(decrypted);
    } catch {
      throw new Error(
        "Saved GitHub tokens could not be decrypted. The browser vault key may have been cleared; clear the saved tokens and add them again.",
      );
    }
  }

  function normalizedTokens(tokens) {
    const seenTokens = new Set();
    const normalized = [];

    for (const entry of Array.isArray(tokens) ? tokens : []) {
      if (!entry || typeof entry.token !== "string") continue;
      const token = entry.token.trim();
      if (!token || seenTokens.has(token)) continue;

      seenTokens.add(token);
      normalized.push({
        label: typeof entry.label === "string"
          ? entry.label.trim()
          : typeof entry.owner === "string" ? entry.owner.trim() : "",
        token,
      });
    }

    return normalized.map((entry, index) => ({
      label: entry.label || `Token ${index + 1}`,
      token: entry.token,
    }));
  }

  function legacyTokensFromSettings(settings) {
    const tokens = normalizedTokens(settings.githubTokens);
    const legacyToken = typeof settings.githubToken === "string"
      ? settings.githubToken.trim()
      : "";

    if (!tokens.length && legacyToken) {
      tokens.push({ label: "GitHub account", token: legacyToken });
    }

    return tokens;
  }

  async function saveTokens(tokens) {
    const normalized = normalizedTokens(tokens);
    const encryptedEntries = [];

    if (normalized.length) {
      const key = await getOrCreateKey();
      for (const entry of normalized) {
        encryptedEntries.push({
          label: entry.label,
          ...(await encryptToken(entry.token, key)),
        });
      }
    }

    await chrome.storage.local.set({
      [ENCRYPTED_STORAGE_KEY]: encryptedEntries,
      // Keep a non-secret revision marker under the legacy key so existing
      // content scripts refresh immediately when token configuration changes.
      githubTokens: [{ encrypted: true, revision: crypto.randomUUID() }],
    });
    await chrome.storage.local.remove("githubToken");
  }

  async function loadTokens() {
    const settings = await chrome.storage.local.get({
      [ENCRYPTED_STORAGE_KEY]: [],
      githubToken: "",
      githubTokens: [],
    });
    const encryptedEntries = Array.isArray(settings[ENCRYPTED_STORAGE_KEY])
      ? settings[ENCRYPTED_STORAGE_KEY]
      : [];

    if (encryptedEntries.length) {
      const key = await getExistingKey();
      if (!key) {
        throw new Error(
          "Saved GitHub tokens are encrypted, but their browser vault key is missing. Clear the saved tokens and add them again.",
        );
      }

      const tokens = [];
      for (const entry of encryptedEntries) {
        const token = await decryptToken(entry, key);
        tokens.push({
          label: typeof entry.label === "string" ? entry.label : "",
          token,
        });
      }
      return normalizedTokens(tokens);
    }

    const legacyTokens = legacyTokensFromSettings(settings);
    if (legacyTokens.length) {
      await saveTokens(legacyTokens);
      return legacyTokens;
    }

    return [];
  }

  async function clearTokens() {
    await chrome.storage.local.remove([
      ENCRYPTED_STORAGE_KEY,
      "githubToken",
      "githubTokens",
    ]);
  }

  globalThis.TokenVault = Object.freeze({
    clearTokens,
    loadTokens,
    saveTokens,
  });
})();
