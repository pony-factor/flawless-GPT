(() => {
  "use strict";

  const CHANNEL = "flawless-web-commit-guidance";
  const WRITABLE_FIELDS = [
    "enabled",
    "about_user_message",
    "about_model_message",
    "name_user_message",
    "role_user_message",
    "traits_model_message",
    "other_user_message",
    "disabled_tools",
  ];
  let sessionCache = null;
  let sessionCachedAt = 0;

  async function session() {
    if (sessionCache && Date.now() - sessionCachedAt < 60_000) return sessionCache;
    const response = await fetch("/api/auth/session", {
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) throw new Error("ChatGPT session could not be read.");
    sessionCache = await response.json();
    sessionCachedAt = Date.now();
    return sessionCache;
  }

  async function headers() {
    const current = await session();
    const result = { accept: "application/json" };
    if (current?.accessToken) result.authorization = `Bearer ${current.accessToken}`;
    return { headers: result, accountId: current?.user?.id || current?.account?.id || null };
  }

  async function readInstructions() {
    const auth = await headers();
    const response = await fetch("/backend-api/user_system_messages", {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: auth.headers,
    });
    if (!response.ok) throw new Error(`ChatGPT personalization read failed (${response.status}).`);
    const payload = await response.json();
    return {
      accountId: auth.accountId,
      guidance: typeof payload?.about_model_message === "string"
        ? payload.about_model_message
        : "",
      payload,
    };
  }

  async function writeInstructions(value) {
    const current = await readInstructions();
    const body = {};
    for (const key of WRITABLE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(current.payload, key)) {
        body[key] = current.payload[key];
      }
    }
    body.about_model_message = String(value ?? "");

    const auth = await headers();
    const response = await fetch("/backend-api/user_system_messages", {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: {
        ...auth.headers,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`ChatGPT personalization update failed (${response.status}).`);
    const payload = await response.json();
    return {
      accountId: auth.accountId || current.accountId,
      guidance: typeof payload?.about_model_message === "string"
        ? payload.about_model_message
        : body.about_model_message,
    };
  }

  window.addEventListener("message", async (event) => {
    const request = event.data;
    if (event.source !== window || request?.channel !== CHANNEL || request?.direction !== "request") return;
    if (!request.id || !["get", "set"].includes(request.action)) return;

    try {
      const result = request.action === "get"
        ? await readInstructions()
        : await writeInstructions(request.value);
      window.postMessage({
        channel: CHANNEL,
        direction: "response",
        id: request.id,
        ok: true,
        ...result,
      }, location.origin);
    } catch (error) {
      window.postMessage({
        channel: CHANNEL,
        direction: "response",
        id: request.id,
        ok: false,
        error: error?.message || "ChatGPT personalization sync failed.",
      }, location.origin);
    }
  });
})();
