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
  const source = read("composer/clipboard-send.js"), end = source.indexOf("  async function sendClipboardPrompt");
  assert.ok(end > 0);
  vm.runInContext(source.slice(0, end) + "\nglobalThis.openForTest = openClipboardUrl;\n})();", scope);
  return { run: () => scope.openForTest(button), navigations, messages, button };
}

function worker(allowed = true, fail = false, searchFail = false) {
  const navigations = [], searches = []; let listener;
  vm.runInNewContext(read("links/clipboard-url-navigation.js"), { URL, chrome: {
    search: { query: async query => {
      if (searchFail) throw Error("Browser search unavailable");
      searches.push(JSON.parse(JSON.stringify(query)));
    } },
    extension: { isAllowedFileSchemeAccess: async () => allowed },
    tabs: { update: async (id, { url }) => {
      if (fail) throw Error("browser blocked local URL");
      navigations.push([id, url]);
    } },
    runtime: { onMessage: { addListener: callback => { listener = callback; } } },
  } });
  const sender = { url: "https://chatgpt.com/", frameId: 0, tab: { id: 4 } };
  return { navigations, searches, send: (url, from = sender) => new Promise(resolve => {
    assert.equal(listener({ type: "open-local-clipboard-url", url }, from, resolve), true);
  }), search: (text, from = sender) => new Promise(resolve => {
    assert.equal(listener({ type: "search-clipboard-text", text }, from, resolve), true);
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

test("HTTP URLs keep working and unsafe schemes use the default search engine", async () => {
  const good = clipboard("https://www.sec.gov/report.pdf"); await good.run();
  assert.deepEqual(good.navigations, ["https://www.sec.gov/report.pdf"]);
  assert.deepEqual(good.messages, []);
  const bad = clipboard("javascript:alert(1)"); await bad.run();
  assert.deepEqual(bad.navigations, []);
  assert.deepEqual(bad.messages, [{ type: "search-clipboard-text", text: "javascript:alert(1)" }]);
});

test("clipboard URL button strips surrounding punctuation and repairs spaces after the scheme", async () => {
  for (const [input, expected] of [
    ['", https:// cyber.harvard.edu/openlaw/contribute.html.', "https://cyber.harvard.edu/openlaw/contribute.html"],
    ['“https://example.org/docs?x=1&y=2.”', "https://example.org/docs?x=1&y=2"],
    ["(https://example.org/article).", "https://example.org/article"],
    ["https://\nexample.org/article", "https://example.org/article"],
  ]) {
    const f = clipboard(input);
    await f.run();
    assert.deepEqual(f.navigations, [expected], input);
  }
});

test("clipboard URLs keep meaningful punctuation inside paths, queries and fragments", async () => {
  for (const url of [
    "https://en.wikipedia.org/wiki/Function_(mathematics)",
    "https://example.org/foo?a=1,b=2#part",
    "https://example.org/path%20with%20spaces",
  ]) {
    const f = clipboard(url);
    await f.run();
    assert.deepEqual(f.navigations, [url]);
  }
  const wrapped = clipboard("(https://en.wikipedia.org/wiki/Function_(mathematics)).");
  await wrapped.run();
  assert.deepEqual(wrapped.navigations, ["https://en.wikipedia.org/wiki/Function_(mathematics)"]);
});

test("clipboard text that is not a standalone URL searches with the default engine", async () => {
  for (const input of [
    "See https://example.org/article", "https://example.org/article and other text",
    "javascript:alert(1)", "ftp://example.org/file", "https://",
    "Stellar transfer agents", "  A & B? #C  ",
  ]) {
    const f = clipboard(input);
    await f.run();
    assert.deepEqual(f.navigations, [], input);
    assert.deepEqual(f.messages, [{ type: "search-clipboard-text", text: input.trim() }], input);
  }
});

test("clipboard search errors are surfaced and the button becomes available again", async () => {
  const f = clipboard("search terms", { ok: false, error: "Browser search unavailable" });
  await f.run();
  assert.deepEqual(f.navigations, []);
  assert.equal(f.button.title, "Browser search unavailable");
  assert.equal(f.button.label, "Browser search unavailable");
  assert.equal(f.button.disabled, false);
});

test("empty clipboard does not navigate or submit a search", async () => {
  for (const input of ["", "  \t\n  "]) {
    const f = clipboard(input);
    await f.run();
    assert.deepEqual(f.navigations, []);
    assert.deepEqual(f.messages, []);
    assert.equal(f.button.title, "Clipboard has no text to open or search");
  }
});

test("punctuation around local file URLs does not alter the worker destination", async () => {
  const f = clipboard('"' + fileUrl + '".');
  await f.run();
  assert.deepEqual(f.messages, [{ type: "open-local-clipboard-url", url: fileUrl }]);
  assert.deepEqual(f.navigations, []);
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

test("worker uses the browser default provider and originating tab", async () => {
  const f = worker();
  assert.deepEqual(await f.search("  My Little Pony & Stellar  "), { ok: true });
  assert.deepEqual(f.searches, [{ tabId: 4, text: "My Little Pony & Stellar" }]);
  assert.deepEqual(f.navigations, []);
});

test("worker refuses searches from untrusted origins, frames or empty content", async () => {
  const f = worker();
  for (const from of [
    { url: "https://evil.example/", frameId: 0, tab: { id: 4 } },
    { url: "https://chatgpt.com/", frameId: 1, tab: { id: 4 } },
    { url: "https://chatgpt.com/", frameId: 0 },
  ]) assert.equal((await f.search("hi", from)).ok, false);
  for (const query of ["", "   ", null, 123])
    assert.equal((await f.search(query)).ok, false);
  assert.deepEqual(f.searches, []);
});

test("worker surfaces search failures without assuming Google or another provider", async () => {
  const f = worker(true, false, true), result = await f.search("Brave search");
  assert.equal(result.ok, false);
  assert.match(result.error, /default search engine/);
  assert.deepEqual(f.navigations, []);
  assert.deepEqual(f.searches, []);
});

test("extension requests the native search permission", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8"));
  assert.ok(manifest.permissions.includes("search"));
});
