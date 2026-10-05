const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash, webcrypto } = require("node:crypto");
const fs = require("node:fs");
const vm = require("node:vm");
const http = require("node:http");
const { createAuthServer, CLIENT_ID } = require("../auth/server.cjs");
const { localExtensionId } = require("../auth/extension-identity.cjs");
const EXTENSION = "gbokjelbjnifepoeklddjcjoljnfaofk";
const ORIGIN = `chrome-extension://${EXTENSION}`;
const verifier = "a".repeat(43);
const hash = (value) => createHash("sha256").update(value).digest("base64url");

async function fixture(t, { detectIdentity = false } = {}) {
  let clock = 1000;
  const exchanges = [];
  const server = createAuthServer({
    clientSecret: "test-only-secret",
    extensionIds: detectIdentity ? undefined : [EXTENSION],
    now: () => clock,
    fetchImpl: async (_url, options) => {
      exchanges.push(new URLSearchParams(options.body));
      return { ok: true, json: async () => ({ access_token: "test-only-access", refresh_token: "test-only-refresh", expires_in: 28800 }) };
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, options = {}) => new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, {
      method: options.method || "GET",
      headers: { Host: "127.0.0.1:8787", ...options.headers },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
    });
    req.on("error", reject);
    req.end(options.body);
  });
  const post = (path, body, origin = ORIGIN) => request(path, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const login = async () => {
    const params = new URLSearchParams({ extension_id: EXTENSION, state: "b".repeat(43), code_challenge: hash(verifier) });
    const response = await request(`/login?${params}`);
    assert.equal(response.status, 302);
    return new URL(response.headers.get("location"));
  };
  return { request, post, login, exchanges, advance: (ms) => { clock += ms; } };
}

test("default service accepts this checkout automatically and rejects other extensions", async (t) => {
  const f = await fixture(t, { detectIdentity: true });
  const id = localExtensionId();
  const params = new URLSearchParams({ extension_id: id, state: "b".repeat(43), code_challenge: hash(verifier) });
  assert.equal((await f.request(`/login?${params}`)).status, 302);
  assert.equal((await f.request("/health", { headers: { Origin: `chrome-extension://${id}` } })).status, 200);
  const foreignId = id === "a".repeat(32) ? "b".repeat(32) : "a".repeat(32);
  params.set("extension_id", foreignId);
  assert.equal((await f.request(`/login?${params}`)).status, 400);
  assert.equal((await f.request("/health", { headers: { Origin: `chrome-extension://${foreignId}` } })).status, 403);
});

test("browser authorization uses PKCE and exchanges a one-time ticket without tokens in redirects", async (t) => {
  const f = await fixture(t);
  const authorize = await f.login();
  assert.equal(authorize.origin, "https://github.com");
  assert.equal(authorize.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorize.searchParams.get("redirect_uri"), "http://127.0.0.1:8787/github/callback");
  const state = authorize.searchParams.get("state");
  const callback = await f.request(`/github/callback?state=${state}&code=test-code`);
  const redirect = new URL(callback.headers.get("location"));
  assert.equal(redirect.origin, `https://${EXTENSION}.chromiumapp.org`);
  assert.equal(redirect.searchParams.get("state"), "b".repeat(43));
  assert.deepEqual([...redirect.searchParams.keys()].sort(), ["login_code", "state"]);
  assert.equal(hash(f.exchanges[0].get("code_verifier")), authorize.searchParams.get("code_challenge"));
  const ticket = redirect.searchParams.get("login_code");
  assert.equal((await f.post("/token", { login_code: ticket, code_verifier: "c".repeat(43) })).status, 400);
  const token = await f.post("/token", { login_code: ticket, code_verifier: verifier });
  assert.equal(token.status, 200);
  assert.equal((await token.json()).access_token, "test-only-access");
  assert.equal((await f.post("/token", { login_code: ticket, code_verifier: verifier })).status, 400);
  assert.equal((await f.request(`/github/callback?state=${state}&code=test-code`)).status, 400);
});

test("rejects untrusted extensions, origins, hosts, and expired authorization state", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/login?extension_id=evil&state=test")).status, 400);
  assert.equal((await f.post("/refresh", { refresh_token: "test" }, "https://evil.example")).status, 403);
  assert.equal((await f.request("/health", { headers: { Host: "evil.example" } })).status, 403);
  const authorize = await f.login();
  f.advance(600001);
  assert.equal((await f.request(`/github/callback?state=${authorize.searchParams.get("state")}&code=test-code`)).status, 400);
  assert.equal(f.exchanges.length, 0);
});

test("handles rejection and refresh without putting credentials in redirect URLs", async (t) => {
  const f = await fixture(t);
  const authorize = await f.login();
  const callback = await f.request(`/github/callback?state=${authorize.searchParams.get("state")}&error=access_denied`);
  const redirect = new URL(callback.headers.get("location"));
  assert.equal(redirect.searchParams.get("error"), "access_denied");
  assert.equal(f.exchanges.length, 0);
  const refreshed = await f.post("/refresh", { refresh_token: "test-only-refresh" });
  assert.equal(refreshed.status, 200);
  assert.equal(f.exchanges[0].get("grant_type"), "refresh_token");
});

test("extension rejects callback state mismatches before redeeming a login", async () => {
  const requests = [];
  const context = {
    crypto: webcrypto, TextEncoder, TextDecoder, URL, URLSearchParams, btoa, atob,
    fetch: async (url) => {
      requests.push(url);
      return { ok: true, json: async () => ({ configured: true, clientId: CLIENT_ID }) };
    },
    chrome: {
      runtime: { id: EXTENSION },
      storage: { local: { get: async () => ({ githubAppClientId: CLIENT_ID, githubAppSlug: "flawless-chatgpt" }) } },
      identity: {
        getRedirectURL: () => `https://${EXTENSION}.chromiumapp.org/github`,
        launchWebAuthFlow: async () => `https://${EXTENSION}.chromiumapp.org/github?state=wrong&login_code=test`,
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("../js/github-app-auth.js"), "utf8"), context);
  await assert.rejects(context.GitHubAppAuth.connect(), /invalid callback/);
  assert.deepEqual(requests, ["http://127.0.0.1:8787/health"]);
});
