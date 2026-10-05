const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash, generateKeyPairSync } = require("node:crypto");
const { extensionId, localExtensionId } = require("../auth/extension-identity.cjs");

test("matches the observed Brave ID for the current unpacked checkout", () => {
  assert.equal(extensionId("/Users/windsor/GitHub/pony-factor/flawless-GPT", {}),
    "bdcefbjebknpplphepnebilogenpcipg");
});

test("automatically follows unpacked folder changes", () => {
  assert.notEqual(extensionId("/tmp/first/flawless-GPT", {}),
    extensionId("/tmp/second/flawless-GPT", {}));
  assert.match(localExtensionId(), /^[a-p]{32}$/);
});

test("a public manifest key keeps identity independent of path and platform", () => {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const bytes = publicKey.export({ type: "spki", format: "der" });
  const manifest = { key: bytes.toString("base64") };
  const expected = createHash("sha256").update(bytes).digest("hex").slice(0, 32)
    .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
  assert.equal(extensionId("/tmp/first", manifest), expected);
  assert.equal(extensionId("/tmp/second", manifest), expected);
  assert.equal(extensionId("C:\\extension", manifest, "win32"), expected);
});

test("Windows path IDs normalize drive case and hash UTF-16 bytes", () => {
  assert.equal(extensionId("c:\\extension", {}, "win32"),
    extensionId("C:\\extension", {}, "win32"));
  assert.notEqual(extensionId("C:\\extension", {}, "win32"),
    extensionId("C:\\extension", {}, "darwin"));
});
