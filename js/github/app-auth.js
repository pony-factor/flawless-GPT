(() => {
  const DATABASE_NAME = "ghrc-github-app-vault";
  const DATABASE_VERSION = 1;
  const KEY_STORE_NAME = "keys";
  const KEY_ID = "github-app-session-aes-gcm-v1";
  const SESSION_STORAGE_KEY = "encryptedGithubAppSessionV1";
  const CLIENT_ID_STORAGE_KEY = "githubAppClientId";
  const APP_SLUG_STORAGE_KEY = "githubAppSlug";
  const AUTH_SERVICE_URL = "http://127.0.0.1:8787";
  const REPOSITORY_CACHE_KEY = "repositoryPayloadCacheV1";
  const AUTH_MARKER_KEY = "githubTokens";
  const IV_LENGTH = 12;
  const REFRESH_SKEW_MS = 5 * 60 * 1000;
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
      request.onerror = () => reject(request.error || new Error("Could not open GitHub App vault."));
      request.onblocked = () => reject(new Error("GitHub App vault database is blocked."));
    });
  }

  async function getExistingKey() {
    const database = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(KEY_STORE_NAME, "readonly");
        const request = transaction.objectStore(KEY_STORE_NAME).get(KEY_ID);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error("Could not read GitHub App vault key."));
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
        if (request.result) selectedKey = request.result;
        else store.put(candidateKey, KEY_ID);
      };
      request.onerror = () => reject(request.error || new Error("Could not create GitHub App vault key."));
      transaction.oncomplete = () => {
        database.close();
        resolve(selectedKey);
      };
      transaction.onabort = () => {
        database.close();
        reject(transaction.error || new Error("Could not create GitHub App vault key."));
      };
      transaction.onerror = () => {};
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

  async function encryptSession(session) {
    const key = await getOrCreateKey();
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      encoder.encode(JSON.stringify(session)),
    );
    return {
      version: 1,
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    };
  }

  async function decryptSession(entry) {
    if (entry?.version !== 1 || typeof entry.iv !== "string" || typeof entry.ciphertext !== "string") {
      throw new Error("Saved GitHub App session is not in a supported format.");
    }
    const key = await getExistingKey();
    if (!key) throw new Error("Saved GitHub App session cannot be decrypted because its browser vault key is missing.");

    try {
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: base64ToBytes(entry.iv) },
        key,
        base64ToBytes(entry.ciphertext),
      );
      return JSON.parse(decoder.decode(decrypted));
    } catch {
      throw new Error("Saved GitHub App session could not be decrypted. Disconnect and reconnect GitHub.");
    }
  }

  async function loadConfig() {
    const settings = await chrome.storage.local.get({
      [CLIENT_ID_STORAGE_KEY]: "",
      [APP_SLUG_STORAGE_KEY]: "",
    });
    return {
      clientId: typeof settings[CLIENT_ID_STORAGE_KEY] === "string"
        ? settings[CLIENT_ID_STORAGE_KEY].trim()
        : "",
      appSlug: typeof settings[APP_SLUG_STORAGE_KEY] === "string"
        ? settings[APP_SLUG_STORAGE_KEY].trim().replace(/^https:\/\/github\.com\/apps\//, "").replace(/\/$/, "")
        : "",
    };
  }

  async function saveConfig({ clientId, appSlug }) {
    await chrome.storage.local.set({
      [CLIENT_ID_STORAGE_KEY]: String(clientId || "").trim(),
      [APP_SLUG_STORAGE_KEY]: String(appSlug || "").trim().replace(/^https:\/\/github\.com\/apps\//, "").replace(/\/$/, ""),
    });
  }

  async function saveSession(
    session,
    { invalidateRepositories = true, notifyAuthChange = true } = {},
  ) {
    const updates = {
      [SESSION_STORAGE_KEY]: await encryptSession(session),
    };
    if (notifyAuthChange) {
      updates[AUTH_MARKER_KEY] = [{ githubApp: true, revision: crypto.randomUUID() }];
    }
    await chrome.storage.local.set(updates);
    if (invalidateRepositories) {
      await chrome.storage.local.remove(REPOSITORY_CACHE_KEY);
    }
  }

  async function readStoredSession() {
    const stored = await chrome.storage.local.get({ [SESSION_STORAGE_KEY]: null });
    if (!stored[SESSION_STORAGE_KEY]) return null;
    return decryptSession(stored[SESSION_STORAGE_KEY]);
  }

  async function clearSession() {
    await chrome.storage.local.remove([SESSION_STORAGE_KEY, REPOSITORY_CACHE_KEY]);
    await chrome.storage.local.set({
      [AUTH_MARKER_KEY]: [{ githubApp: false, revision: crypto.randomUUID() }],
    });
  }

  async function postOAuth(url, params) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params).toString(),
    });

    if (!response.ok) {
      throw new Error(`GitHub authorization returned ${response.status}.`);
    }

    return response.json();
  }

  function sessionFromTokenPayload(payload, clientId, previous = {}) {
    if (!payload.access_token) {
      throw new Error(payload.error_description || payload.error || "GitHub did not return an access token.");
    }
    const now = Date.now();
    return {
      clientId,
      login: previous.login || "",
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token || previous.refreshToken || "",
      expiresAt: payload.expires_in ? now + (Number(payload.expires_in) * 1000) : 0,
      refreshExpiresAt: payload.refresh_token_expires_in
        ? now + (Number(payload.refresh_token_expires_in) * 1000)
        : previous.refreshExpiresAt || 0,
      tokenType: payload.token_type || "bearer",
      authMethod: "device_flow",
    };
  }

  async function refreshSession(session) {
    if (!session?.refreshToken) {
      if (!session?.expiresAt) return session;
      throw new Error("GitHub App authorization expired. Reconnect GitHub.");
    }
    if (session.refreshExpiresAt && Date.now() >= session.refreshExpiresAt) {
      throw new Error("GitHub App refresh authorization expired. Reconnect GitHub.");
    }

    const config = await loadConfig();
    const clientId = config.clientId || session.clientId;
    if (!clientId || (session.clientId && clientId !== session.clientId)) {
      throw new Error("GitHub App Client ID changed. Reconnect GitHub.");
    }

    const payload = session.authMethod === "web_flow"
      ? await backendRequest("/refresh", { refresh_token: session.refreshToken })
      : await postOAuth("https://github.com/login/oauth/access_token", {
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: session.refreshToken,
      });
    if (payload.error) throw new Error(payload.error_description || payload.error);

    const refreshed = sessionFromTokenPayload(payload, clientId, session);
    refreshed.authMethod = session.authMethod;
    await saveSession(refreshed, {
      invalidateRepositories: false,
      notifyAuthChange: false,
    });
    return refreshed;
  }

  async function loadSession({ refresh = true } = {}) {
    const session = await readStoredSession();
    if (!session) return null;
    if (!refresh || !session.expiresAt || Date.now() < session.expiresAt - REFRESH_SKEW_MS) {
      return session;
    }
    return refreshSession(session);
  }

  async function getAccessToken() {
    const session = await loadSession({ refresh: true });
    return session?.accessToken || "";
  }

  async function fetchCurrentLogin(accessToken) {
    const response = await fetch("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) return "";
    const profile = await response.json();
    return typeof profile.login === "string" ? profile.login : "";
  }

  async function backendRequest(path, body) {
    let response;
    try {
      response = await fetch(`${AUTH_SERVICE_URL}${path}`, body ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      } : {});
    } catch {
      throw new Error("GitHub login service is unavailable. Start the local login service, then try again.");
    }
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "GitHub login could not complete.");
    return payload;
  }

  function randomValue() {
    return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  async function connect() {
    const config = await loadConfig();
    const health = await backendRequest("/health");
    if (!health.configured) throw new Error("GitHub login needs setup. Configure the app's client secret in the local login service.");
    if (health.clientId !== config.clientId) throw new Error("The login service is configured for a different GitHub App.");

    const state = randomValue();
    const verifier = randomValue();
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
    const challenge = bytesToBase64(new Uint8Array(digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const redirectUri = chrome.identity.getRedirectURL("github");
    const login = new URL(`${AUTH_SERVICE_URL}/login`);
    login.search = new URLSearchParams({ extension_id: chrome.runtime.id, state, code_challenge: challenge });
    let redirected;
    try {
      redirected = await chrome.identity.launchWebAuthFlow({ url: login.href, interactive: true });
    } catch {
      throw new Error("GitHub login was closed or could not open. Please try again.");
    }
    const callback = new URL(redirected);
    const expected = new URL(redirectUri);
    if (callback.origin !== expected.origin || callback.pathname !== expected.pathname
      || callback.searchParams.get("state") !== state) throw new Error("GitHub login returned an invalid callback. Please try again.");
    if (callback.searchParams.has("error")) throw new Error("GitHub authorization was declined or could not complete. Please try again.");
    const loginCode = callback.searchParams.get("login_code");
    if (!loginCode) throw new Error("GitHub login did not complete. Please try again.");
    const payload = await backendRequest("/token", { login_code: loginCode, code_verifier: verifier });
    const session = sessionFromTokenPayload(payload, config.clientId);
    session.authMethod = "web_flow";
    session.login = await fetchCurrentLogin(session.accessToken);
    await saveSession(session);
    return session;
  }

  function installUrl(appSlug) {
    return appSlug ? `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new` : "";
  }

  function addStyles() {
    if (document.getElementById("github-app-linking-styles")) return;
    const style = document.createElement("style");
    style.id = "github-app-linking-styles";
    style.textContent = `
      .github-app-linking {
        border: 1px solid light-dark(#d0d7de, #3d444d);
        border-radius: 8px;
        margin-bottom: 16px;
        padding: 14px;
      }
      .github-app-linking h2 { font-size: 16px; margin: 0 0 4px; }
      .github-app-linking .github-app-summary { margin: 0 0 10px; }
      .github-app-linking .github-app-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
      .github-app-linking details { margin-top: 10px; }
      .github-app-linking details label { display: block; margin-top: 10px; }
      .github-app-linking details input { width: 100%; }
      .github-app-linking .github-app-local-status[data-state="error"] { color: #cf222e; }
      .github-app-linking .github-app-local-status[data-state="success"] { color: #1a7f37; }
    `;
    document.head.append(style);
  }

  function createButton(text, className = "secondary") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = text;
    return button;
  }

  async function mountSettingsUi({ popup = false } = {}) {
    if (typeof document === "undefined" || document.getElementById("github-app-linking")) return;
    const tokenSettings = document.getElementById("token-settings");
    if (!tokenSettings?.parentElement) return;

    addStyles();
    const card = document.createElement("section");
    card.id = "github-app-linking";
    card.className = "github-app-linking";

    const heading = document.createElement("h2");
    heading.textContent = "GitHub App";
    const summary = document.createElement("p");
    summary.className = "github-app-summary help";
    const help = document.createElement("p");
    help.className = "help";
    help.textContent = "Choose which repositories the GitHub App can access, then connect your GitHub account.";

    const appLink = document.createElement("a");
    appLink.target = "_blank";
    appLink.rel = "noopener noreferrer";

    const actions = document.createElement("div");
    actions.className = "github-app-actions";
    const installButton = createButton("Choose repositories");
    const connectButton = createButton("Connect GitHub", "");
    const disconnectButton = createButton("Disconnect");
    actions.append(installButton, connectButton, disconnectButton);

    const localStatus = document.createElement("p");
    localStatus.className = "help github-app-local-status";
    localStatus.setAttribute("role", "status");
    localStatus.setAttribute("aria-live", "polite");

    const developer = document.createElement("details");
    const developerSummary = document.createElement("summary");
    developerSummary.textContent = "Developer setup";
    const developerHelp = document.createElement("p");
    developerHelp.className = "help";
    developerHelp.textContent = "Enter only the public GitHub App Client ID and app slug. Never put a client secret or private key in the extension.";
    const clientIdLabel = document.createElement("label");
    clientIdLabel.textContent = "GitHub App Client ID";
    const clientIdInput = document.createElement("input");
    clientIdInput.type = "text";
    clientIdInput.autocomplete = "off";
    clientIdInput.spellcheck = false;
    clientIdInput.placeholder = "Iv1… or Ov23li…";
    const slugLabel = document.createElement("label");
    slugLabel.textContent = "GitHub App slug";
    const slugInput = document.createElement("input");
    slugInput.type = "text";
    slugInput.autocomplete = "off";
    slugInput.spellcheck = false;
    slugInput.placeholder = "your-app-slug";
    developer.append(developerSummary, developerHelp, clientIdLabel, clientIdInput, slugLabel, slugInput);

    card.append(heading, appLink, summary, help, actions, localStatus, developer);
    tokenSettings.parentElement.insertBefore(card, tokenSettings);

    const tokenTitle = tokenSettings.querySelector("summary span:first-child");
    if (tokenTitle) tokenTitle.textContent = "Legacy GitHub tokens";
    tokenSettings.open = false;

    const showLocalStatus = (message, state = "") => {
      localStatus.textContent = message;
      localStatus.dataset.state = state;
    };

    async function render() {
      const [config, session] = await Promise.all([
        loadConfig(),
        loadSession({ refresh: false }).catch(() => null),
      ]);
      clientIdInput.value = config.clientId;
      slugInput.value = config.appSlug;
      appLink.href = config.appSlug ? `https://github.com/apps/${encodeURIComponent(config.appSlug)}` : "";
      appLink.textContent = config.appSlug || "";
      appLink.hidden = !config.appSlug;
      developer.open = !config.clientId || !config.appSlug;
      installButton.disabled = !config.appSlug;
      disconnectButton.disabled = !session;
      connectButton.textContent = session ? "Reconnect GitHub" : "Connect GitHub";
      summary.textContent = session
        ? `Connected${session.login ? ` as @${session.login}` : ""}`
        : "Not connected";
    }

    async function persistConfig() {
      await saveConfig({ clientId: clientIdInput.value, appSlug: slugInput.value });
      await render();
      showLocalStatus("GitHub App developer settings saved.", "success");
    }

    clientIdInput.addEventListener("change", () => void persistConfig());
    slugInput.addEventListener("change", () => void persistConfig());

    installButton.addEventListener("click", async () => {
      await persistConfig();
      const config = await loadConfig();
      const url = installUrl(config.appSlug);
      if (!url) {
        developer.open = true;
        showLocalStatus("Add the GitHub App slug first.", "error");
        return;
      }
      void chrome.tabs.create({ url });
    });

    connectButton.addEventListener("click", async () => {
      await persistConfig();
      if (popup) {
        await chrome.runtime.sendMessage({ type: "open-options", connectGithub: true });
        window.close();
        return;
      }

      connectButton.disabled = true;
      showLocalStatus("Opening GitHub authorization…");
      try {
        const session = await connect();
        showLocalStatus(`Connected${session.login ? ` as @${session.login}` : ""}.`, "success");
        await render();
      } catch (error) {
        showLocalStatus(error.message, "error");
      } finally {
        connectButton.disabled = false;
      }
    });

    disconnectButton.addEventListener("click", async () => {
      try {
        await clearSession();
        showLocalStatus("GitHub disconnected locally. Manage or uninstall the GitHub App from GitHub if you also want to revoke its installation.", "success");
        await render();
      } catch (error) {
        showLocalStatus(error.message, "error");
      }
    });

    await render();

    if (!popup) {
      const pending = await chrome.storage.local.get({ githubAppConnectRequested: false });
      if (pending.githubAppConnectRequested) {
        await chrome.storage.local.remove("githubAppConnectRequested");
        connectButton.click();
      }
    }
  }

  function patchServiceWorkerTokenVault() {
    if (typeof document !== "undefined" || !globalThis.TokenVault || globalThis.TokenVault.__githubAppPatched) return;
    const legacyLoadTokens = globalThis.TokenVault.loadTokens.bind(globalThis.TokenVault);
    const patched = Object.freeze({
      ...globalThis.TokenVault,
      __githubAppPatched: true,
      async loadTokens({ refresh = true } = {}) {
        const stored = await chrome.storage.local.get({ [SESSION_STORAGE_KEY]: null });
        if (!stored[SESSION_STORAGE_KEY]) return legacyLoadTokens();
        const session = await loadSession({ refresh });
        const token = session?.accessToken || "";
        if (!token) throw new Error("GitHub App is connected but no usable access token is available.");
        return [{
          label: "GitHub App",
          token,
          cacheKey: JSON.stringify([
            "github-app",
            session.clientId || "",
            session.login || "",
            session.authMethod || "",
          ]),
          refreshable: true,
        }];
      },
    });
    globalThis.TokenVault = patched;
  }

  globalThis.GitHubAppAuth = Object.freeze({
    clearSession,
    connect,
    getAccessToken,
    installUrl,
    loadConfig,
    loadSession,
    mountSettingsUi,
    saveConfig,
  });

  patchServiceWorkerTokenVault();
})();
