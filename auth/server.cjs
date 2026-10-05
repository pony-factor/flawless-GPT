const http = require("node:http");
const { randomBytes, createHash, timingSafeEqual } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { localExtensionId } = require("./extension-identity.cjs");

const CLIENT_ID = "Iv23liukJaqMAIiIIfOz";
const APP_SLUG = "flawless-chatgpt";
const random = () => randomBytes(32).toString("base64url");
const hash = (value) => createHash("sha256").update(value).digest("base64url");
const validValue = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{43,128}$/.test(value);
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function createAuthServer({
  clientSecret = "",
  clientId = CLIENT_ID,
  baseUrl = "http://127.0.0.1:8787",
  extensionIds = [localExtensionId()],
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const base = new URL(baseUrl);
  const allowed = new Set(extensionIds.filter((id) => /^[a-p]{32}$/.test(id)));
  const flows = new Map();
  const tickets = new Map();

  function purge() {
    for (const map of [flows, tickets]) {
      for (const [key, entry] of map) if (entry.expiresAt <= now()) map.delete(key);
    }
  }

  async function oauth(params) {
    const response = await fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
      signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json();
    if (!response.ok || payload.error || !payload.access_token) throw new Error("GitHub authorization failed. Please reconnect.");
    return payload;
  }

  async function readBody(req) {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 8192) throw new Error("Request is too large.");
    }
    return JSON.parse(body);
  }

  return http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const json = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const redirect = (url) => {
      res.writeHead(302, { Location: url });
      res.end();
    };
    const origin = req.headers.origin || "";
    const originId = origin.startsWith("chrome-extension://") ? origin.slice(19) : "";
    if (req.headers.host !== base.host) return json(403, { error: "Invalid host." });
    if (origin && !allowed.has(originId)) return json(403, { error: "Extension is not allowed." });
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      if (!allowed.has(originId)) return json(403, { error: "Extension is not allowed." });
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.writeHead(204);
      return res.end();
    }

    purge();
    const url = new URL(req.url, base);
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        return json(200, { configured: Boolean(clientSecret), clientId, appSlug: APP_SLUG });
      }
      if (!clientSecret) return json(503, { error: "GitHub login service needs its client secret configured." });

      if (req.method === "GET" && url.pathname === "/login") {
        const extensionId = url.searchParams.get("extension_id");
        const state = url.searchParams.get("state");
        const challenge = url.searchParams.get("code_challenge");
        if (!allowed.has(extensionId) || !validValue(state) || !validValue(challenge)) {
          return json(400, { error: "Invalid login request." });
        }
        if (flows.size + tickets.size >= 128) return json(429, { error: "Too many login attempts. Please try again later." });
        const githubState = random();
        const verifier = random();
        flows.set(githubState, { extensionId, state, challenge, verifier, expiresAt: now() + 600000 });
        const authorize = new URL("https://github.com/login/oauth/authorize");
        authorize.search = new URLSearchParams({
          client_id: clientId,
          redirect_uri: `${base.origin}/github/callback`,
          state: githubState,
          code_challenge: hash(verifier),
          code_challenge_method: "S256",
        });
        return redirect(authorize.href);
      }

      if (req.method === "GET" && url.pathname === "/github/callback") {
        const state = url.searchParams.get("state");
        const flow = flows.get(state);
        if (!flow) return json(400, { error: "This login expired or was already used. Please reconnect." });
        flows.delete(state);
        const callback = new URL(`https://${flow.extensionId}.chromiumapp.org/github`);
        callback.searchParams.set("state", flow.state);
        if (url.searchParams.has("error")) {
          callback.searchParams.set("error", "access_denied");
          return redirect(callback.href);
        }
        const code = url.searchParams.get("code");
        if (!code || code.length > 512) return json(400, { error: "GitHub did not provide a login code." });
        let payload;
        try {
          payload = await oauth({ code, code_verifier: flow.verifier, redirect_uri: `${base.origin}/github/callback` });
        } catch {
          callback.searchParams.set("error", "exchange_failed");
          return redirect(callback.href);
        }
        const ticket = random();
        tickets.set(ticket, { extensionId: flow.extensionId, challenge: flow.challenge, payload, expiresAt: now() + 60000 });
        callback.searchParams.set("login_code", ticket);
        return redirect(callback.href);
      }

      if (req.method === "POST" && ["/token", "/refresh"].includes(url.pathname)) {
        if (!allowed.has(originId)) return json(403, { error: "Extension is not allowed." });
        const body = await readBody(req);
        if (url.pathname === "/refresh") {
          if (typeof body.refresh_token !== "string" || body.refresh_token.length > 1024 || !body.refresh_token) {
            return json(400, { error: "Invalid refresh request." });
          }
          return json(200, await oauth({ grant_type: "refresh_token", refresh_token: body.refresh_token }));
        }
        const ticket = tickets.get(body.login_code);
        if (!ticket || ticket.extensionId !== originId || !validValue(body.code_verifier)
          || !same(hash(body.code_verifier), ticket.challenge)) {
          return json(400, { error: "Invalid or expired login. Please reconnect." });
        }
        tickets.delete(body.login_code);
        return json(200, ticket.payload);
      }
      return json(404, { error: "Not found." });
    } catch {
      return json(502, { error: "GitHub login could not complete. Please try again." });
    }
  });
}

if (require.main === module) {
  let clientSecret = process.env.GITHUB_APP_CLIENT_SECRET || "";
  if (!clientSecret && process.platform === "darwin") {
    try {
      clientSecret = execFileSync("/usr/bin/security", ["find-generic-password", "-s", "flawless-chatgpt-auth", "-a", CLIENT_ID, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      // The service stays available for setup, without attempting authorization.
    }
  }
  const port = Number(process.env.PORT || 8787);
  const server = createAuthServer({
    clientSecret,
    baseUrl: process.env.AUTH_BASE_URL || `http://127.0.0.1:${port}`,
    extensionIds: [localExtensionId(), ...(process.env.GITHUB_APP_EXTENSION_IDS || "").split(",")],
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`GitHub login service listening on 127.0.0.1:${port}. Client secret ${clientSecret ? "configured" : "needs setup"}.`);
  });
}

module.exports = { createAuthServer, CLIENT_ID, APP_SLUG };
