"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const checked = new Set();

assert.equal(manifest.manifest_version, 3, "Flawless must remain a Manifest V3 extension");
assert.match(manifest.version, /^\d+\.\d+\.\d+(?:\.\d+)?$/, "Invalid extension version");
assert.ok(Array.isArray(manifest.content_scripts) && manifest.content_scripts.length, "Missing content scripts");

function verifyFile(relativePath, source) {
  assert.equal(typeof relativePath, "string", source + " must reference a filename");
  assert.ok(relativePath.length > 0 && !path.isAbsolute(relativePath)
    && !relativePath.includes("\\") && !relativePath.split("/").includes(".."),
    source + " references an unsafe path: " + relativePath);
  const file = path.resolve(root, relativePath);
  assert.ok(file.startsWith(root + path.sep), source + " escapes the extension root");
  assert.ok(fs.existsSync(file) && fs.statSync(file).isFile(),
    source + " references a missing file: " + relativePath);
  checked.add(relativePath);
}

function verifyIcons(icons, source) {
  for (const filename of Object.values(icons || {})) verifyFile(filename, source);
}

for (const [index, script] of manifest.content_scripts.entries()) {
  assert.ok(Array.isArray(script.matches) && script.matches.length,
    "content_scripts[" + index + "] is missing match patterns");
  for (const filename of script.js || []) verifyFile(filename, "content script JavaScript");
  for (const filename of script.css || []) verifyFile(filename, "content script CSS");
}

if (manifest.background?.service_worker) verifyFile(manifest.background.service_worker, "service worker");
if (manifest.action?.default_popup) verifyFile(manifest.action.default_popup, "toolbar popup");
if (manifest.options_page) verifyFile(manifest.options_page, "options page");
if (manifest.options_ui?.page) verifyFile(manifest.options_ui.page, "options UI");
if (manifest.devtools_page) verifyFile(manifest.devtools_page, "developer tools");
verifyIcons(manifest.icons, "extension icon");
verifyIcons(manifest.action?.default_icon, "toolbar icon");

for (const group of manifest.web_accessible_resources || []) {
  for (const filename of group.resources || []) {
    // Wildcard resource declarations cannot be checked as individual files.
    if (!filename.includes("*")) verifyFile(filename, "web-accessible resource");
  }
}

assert.ok(checked.size > 0, "Manifest did not reference any local files");
console.log("Validated Manifest V3 and " + checked.size + " local extension resources.");
