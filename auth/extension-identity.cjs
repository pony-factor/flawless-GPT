const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const path = require("node:path");

// Match Chromium's ID algorithm without opening browser profile data.
function extensionId(root, manifest, platform = process.platform) {
  let input;
  if (manifest.key) {
    input = Buffer.from(manifest.key, "base64");
  } else {
    const location = platform === "win32"
      ? path.win32.resolve(root).replace(/^[a-z]:/, drive => drive.toUpperCase())
      : path.resolve(root);
    input = Buffer.from(location, platform === "win32" ? "utf16le" : "utf8");
  }
  return createHash("sha256").update(input).digest("hex").slice(0, 32)
    .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
}

function localExtensionId(root = path.resolve(__dirname, "..")) {
  const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
  return extensionId(root, manifest);
}

module.exports = { extensionId, localExtensionId };
