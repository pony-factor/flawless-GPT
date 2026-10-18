const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "js/settings/options.js"), "utf8");
const sharedIds = [...source.matchAll(/document\.getElementById\("([^"]+)"\)/g)]
  .map((match) => match[1]);

for (const page of ["popup.html", "options.html"]) {
  test(`${page} supplies every control required by the shared settings script`, () => {
    const html = fs.readFileSync(path.join(root, page), "utf8");
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    for (const id of sharedIds) {
      assert.equal(ids.filter((candidate) => candidate === id).length, 1,
        `${page} must contain exactly one #${id}`);
    }
  });
}

test("web commit guidance sync status is centered below the editor", () => {
  const html = fs.readFileSync(path.join(root, "options.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "css/options.css"), "utf8");
  assert.match(html, /<p\s+id="web-commit-guidance-status"[^>]*role="status"/);
  assert.match(css, /#web-commit-guidance-status\s*\{\s*text-align:\s*center\s*;/);
});
