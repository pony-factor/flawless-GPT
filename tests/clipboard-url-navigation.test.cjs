const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const read = name => fs.readFileSync(path.join(__dirname, "../js", name), "utf8");
const fileUrl = "file:///Users/example/Desktop/1973%20Reg%20of%20CAs%20and%20TAs.pdf";

function clipboard(url, response = { ok: true }) {
  const navigations = [], messages = [];
  const button = { disabled: false, toggleAttribute() {}, setAttribute(name, value) {
    if (name === "aria-label") this.label = value;
  } };
  const scope = { URL, navigator: { clipboard: { readText: async () => url } },
    window: { location: { assign: url => navigations.push(url) } },
    chrome: { runtime: { sendMessage: async message => {
      messages.push(JSON.parse(JSON.stringify(message))); return response;
    } } },
    __ghrcExtensionContext: { active: () => true, handleError: error => { throw error; } },
  };
  vm.createContext(scope);
  const source = read("clipboard-send.js"), end = source.indexOf("  async function sendClipboardPrompt");
  assert.ok(end > 0);
  vm.runInContext(source.slice(0, end) + "\nglobalThis.openForTest = openClipboardUrl;\n})();", scope);
  return { run: () => scope.openForTest(button), navigations, messages, button };
}

function worker(allowed = true, fail = false) {
  const navigations = []; let listener;
  vm.runInNewContext(read("clipboard-url-navigation.js"), { URL, chrome: {
    extension: { isAllowedFileSchemeAccess: async () => allowed },
    tabs: { update: async (id, { url }) => {
      if (fail) throw Error("browser blocked local URL");
      navigations.push([id, url]);
    } },
    runtime: { onMessage: { addListener: callback => { listener = callback; } } },
  } });
  const sender = { url: "https://chatgpt.com/", frameId: 0, tab: { id: 4 } };
  return { navigations, send: (url, from = sender) => new Promise(resolve => {
    assert.equal(listener({ type: "open-local-clipboard-url", url }, from, resolve), true);
  }), listener };
}

test("clipboard file PDF is routed to the worker without losing percent-encoded spaces", async () => {
  const f = clipboard(fileUrl); await f.run();
  assert.deepEqual(f.messages, [{ type: "open-local-clipboard-url", url: fileUrl }]);
  assert.deepEqual(f.navigations, []);
  assert.equal(f.button.disabled, false);
});

test("clipboard surfaces file permission errors", async () => {
  const f = clipboard(fileUrl, { ok: false, error: "Enable file URLs" }); await f.run();
  assert.equal(f.button.title, "Enable file URLs");
  assert.equal(f.button.label, "Enable file URLs");
});

test("HTTP URLs keep working and javascript URLs are rejected", async () => {
  const good = clipboard("https://www.sec.gov/report.pdf"); await good.run();
  assert.deepEqual(good.navigations, ["https://www.sec.gov/report.pdf"]);
  assert.deepEqual(good.messages, []);
  const bad = clipboard("javascript:alert(1)"); await bad.run();
  assert.deepEqual(bad.navigations, []);
  assert.deepEqual(bad.messages, []);
});

test("worker opens permitted local files in the originating tab", async () => {
  const f = worker(); assert.equal((await f.send(fileUrl)).ok, true);
  assert.deepEqual(f.navigations, [[4, fileUrl]]);
  assert.equal(f.listener({ type: "unrelated" }, {}, () => {}), false);
});

test("worker explains disabled file permission without navigation", async () => {
  const f = worker(false), res = await f.send(fileUrl);
  assert.equal(res.ok, false); assert.match(res.error, /Allow access to file URLs/);
  assert.deepEqual(f.navigations, []);
});

test("worker rejects untrusted callers and unsupported URL schemes", async () => {
  const f = worker();
  assert.equal((await f.send(fileUrl, { url: "https://evil.example/", frameId: 0, tab: { id: 4 } })).ok, false);
  assert.equal((await f.send(fileUrl, { url: "https://chatgpt.com/", frameId: 1, tab: { id: 4 } })).ok, false);
  for (const url of ["https://example.org", "file://server/document.pdf", "javascript:alert(1)", "invalid"])
    assert.equal((await f.send(url)).ok, false);
  assert.deepEqual(f.navigations, []);
});

test("worker reports browser navigation failures", async () => {
  const f = worker(true, true), res = await f.send(fileUrl);
  assert.equal(res.ok, false); assert.match(res.error, /file-URL access/);
  assert.deepEqual(f.navigations, []);
});
