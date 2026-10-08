const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../js/link-preview-host.js'), 'utf8');
function fixture(url) {
  const frames = [];
  const body = { append: frame => frames.push(frame), textContent: '' };
  vm.runInNewContext(source, {
    URL, decodeURIComponent, location: { hash: '#' + encodeURIComponent(url) },
    document: { body, createElement: () => ({}) },
  });
  return { frames, body };
}
test('PDF download URLs retain query parameters and use a frame compatible with PDF viewers', () => {
  const url = 'https://example.org/download.asp?docId=%7B123%7D';
  const { frames } = fixture(url);
  assert.equal(frames[0].src, url);
  assert.equal(frames[0].referrerPolicy, 'no-referrer');
  assert.equal(frames[0].sandbox, undefined);
});
test('preview host rejects non-web URLs and embedded credentials', () => {
  for (const url of ['javascript:alert(1)', 'file:///tmp/test', 'https://user:pass@example.org/']) {
    const { frames, body } = fixture(url);
    assert.equal(frames.length, 0);
    assert.match(body.textContent, /cannot be previewed/);
  }
});
