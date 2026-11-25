const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "js", "settings/chatgpt-personalization-api.js"),
  "utf8",
);

function fixture() {
  const listeners = new Map();
  const messages = [];
  const calls = [];
  let stored = {
    object: "user_system_message_detail",
    enabled: true,
    about_user_message: "About the user",
    about_model_message: "Old guidance",
    traits_model_message: "Pragmatic",
    disabled_tools: ["voice"],
  };

  const window = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    postMessage(message) { messages.push(message); },
  };
  const location = { origin: "https://chatgpt.com" };
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === "/api/auth/session") {
      return { ok: true, async json() { return { accessToken: "token", user: { id: "user-1" } }; } };
    }
    if (url === "/backend-api/user_system_messages" && (init.method || "GET") === "GET") {
      return { ok: true, async json() { return { ...stored }; } };
    }
    if (url === "/backend-api/user_system_messages" && init.method === "POST") {
      stored = { ...stored, ...JSON.parse(init.body) };
      return { ok: true, async json() { return { ...stored }; } };
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  vm.runInNewContext(SOURCE, { Date, Error, JSON, fetch, location, window });
  return {
    calls,
    messages,
    stored: () => stored,
    async request(action, value) {
      await listeners.get("message")({
        source: window,
        data: {
          channel: "flawless-web-commit-guidance",
          direction: "request",
          id: "request-1",
          action,
          value,
        },
      });
      return messages.at(-1);
    },
  };
}

test("reads ChatGPT model instructions without persisting auth", async () => {
  const state = fixture();
  const response = await state.request("get");
  assert.equal(response.ok, true);
  assert.equal(response.guidance, "Old guidance");
  assert.equal(response.accountId, "user-1");
  assert.equal(state.calls[1].init.headers.authorization, "Bearer token");
});

test("updates only guidance while preserving other personalization fields", async () => {
  const state = fixture();
  const response = await state.request("set", "New guidance");
  assert.equal(response.ok, true);
  assert.equal(state.stored().about_model_message, "New guidance");
  assert.equal(state.stored().about_user_message, "About the user");
  assert.equal(state.stored().traits_model_message, "Pragmatic");
  assert.deepEqual(state.stored().disabled_tools, ["voice"]);

  const post = state.calls.find((call) => call.init.method === "POST");
  const body = JSON.parse(post.init.body);
  assert.equal(body.about_model_message, "New guidance");
  assert.equal(body.about_user_message, "About the user");
  assert.equal(body.traits_model_message, "Pragmatic");
});


test("rejects oversized guidance before reading auth or posting, without truncating", async () => {
  const state = fixture();
  const response = await state.request("set", "x".repeat(7492));
  assert.equal(response.ok, false);
  assert.match(response.error, /7,492.*2,492/);
  assert.equal(state.calls.length, 0);
  assert.equal(state.stored().about_model_message, "Old guidance");
});

test("accepts the 5000 character boundary, counting Unicode code points", async () => {
  const state = fixture();
  const guidance = "😀".repeat(5000);
  const response = await state.request("set", guidance);
  assert.equal(response.ok, true);
  assert.equal(state.stored().about_model_message, guidance);
});
