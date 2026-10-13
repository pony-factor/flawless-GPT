const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sourcePath = path.join(__dirname, '../js/clipboard-utm-sanitizer.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const {
  stripTrackingFromUrlValue,
  stripTrackingFromText,
  stripMarkdownBold,
  normalizeSmartQuotes,
  normalizeMarkdownItalics,
  convertReferenceLinksToInlineMarkdown,
  sanitizeCopiedText,
  sanitizeCopiedHtml,
} = require(sourcePath);

test('removes ChatGPT UTM tracking from copied Markdown links', () => {
  const input = '[SEC](https://www.sec.gov/rules/example?utm_source=chatgpt.com)';
  assert.equal(stripTrackingFromText(input), '[SEC](https://www.sec.gov/rules/example)');
});

test('converts copied reference-style Markdown links to inline links', () => {
  const input = [
    'Read the [SEC release][1] and [DTC filing][dtc].',
    '',
    '[1]: https://www.sec.gov/rules/example',
    '[dtc]: <https://www.dtcc.com/example> "DTC filing"',
  ].join('\n');
  assert.equal(
    convertReferenceLinksToInlineMarkdown(input),
    'Read the [SEC release](https://www.sec.gov/rules/example) and [DTC filing](<https://www.dtcc.com/example> "DTC filing").\n',
  );
});

test('reuses a reference definition and leaves unrelated definitions intact', () => {
  const input = [
    '[First][source] and [second][SOURCE].',
    '',
    '[source]: https://example.com/report',
    '[unused]: https://example.com/unused',
  ].join('\n');
  assert.equal(
    convertReferenceLinksToInlineMarkdown(input),
    '[First](https://example.com/report) and [second](https://example.com/report).\n\n[unused]: https://example.com/unused',
  );
});

test('supports collapsed reference links', () => {
  const input = [
    'Read [the filing][].',
    '',
    '[the filing]: https://example.com/filing',
  ].join('\n');
  assert.equal(
    convertReferenceLinksToInlineMarkdown(input),
    'Read [the filing](https://example.com/filing).\n',
  );
});

test('normalizes reference links even when UTM removal is disabled', () => {
  const input = [
    '[source][1]',
    '',
    '[1]: https://example.com/report?utm_source=chatgpt.com&id=7',
  ].join('\n');
  assert.equal(
    sanitizeCopiedText(input, false),
    '[source](https://example.com/report?utm_source=chatgpt.com&id=7)\n',
  );
});

test('removes orphaned ChatGPT content-reference markers from copied text', () => {
  const input = 'Useful source:chatgpt-content-reference{index="3"} text';
  assert.equal(stripTrackingFromText(input), 'Useful source text');
});

test('removes multiple content references while still stripping UTM tracking', () => {
  const input = [
    'A:chatgpt-content-reference{index="1"}',
    '[source](https://example.com/report?id=7&utm_source=chatgpt.com)',
    ':chatgpt-content-reference{index="9"}',
  ].join(' ');
  assert.equal(
    stripTrackingFromText(input),
    'A [source](https://example.com/report?id=7) ',
  );
});

test('preserves non-UTM parameters and fragments', () => {
  const input = 'https://example.com/report?id=42&utm_source=chatgpt.com&utm_medium=copy#part-2';
  assert.equal(stripTrackingFromUrlValue(input), 'https://example.com/report?id=42#part-2');
});

test('sanitizes multiple URLs and case-insensitive UTM names', () => {
  const input = 'A https://a.example/?UTM_Source=chatgpt.com&x=1 B https://b.example/?q=2&utm_campaign=test';
  assert.equal(
    stripTrackingFromText(input),
    'A https://a.example/?x=1 B https://b.example/?q=2',
  );
});

test('keeps HTML-encoded query separators valid while stripping tracking', () => {
  const input = '<a href="https://example.com/?a=1&amp;utm_source=chatgpt.com&amp;b=2">Example</a>';
  assert.equal(
    stripTrackingFromText(input),
    '<a href="https://example.com/?a=1&amp;b=2">Example</a>',
  );
});

test('leaves non-tracking URLs and surrounding copy unchanged', () => {
  const input = 'See [source](https://example.com/?id=7) and mailto:test@example.com.';
  assert.equal(stripTrackingFromText(input), input);
});

test('strips Markdown bold while preserving its text', () => {
  assert.equal(
    stripMarkdownBold('A **bold** word and __another bold phrase__.'),
    'A bold word and another bold phrase.',
  );
});

test('converts smart quotes and apostrophes to plain ASCII', () => {
  assert.equal(
    normalizeSmartQuotes('“Quoted” and ‘apostrophe’'),
    '"Quoted" and \'apostrophe\'',
  );
});

test('normalizes single-star Markdown italics to underscores', () => {
  assert.equal(
    normalizeMarkdownItalics('*italic* and **bold**'),
    '_italic_ and **bold**',
  );
});

test('applies copied-response formatting defaults together', () => {
  assert.equal(
    sanitizeCopiedText('“**Bold** and *italic*”'),
    '"Bold and _italic_"',
  );
});

test('lets copied-response formatting transformations be disabled independently', () => {
  const input = '“**Bold** and *italic*”';
  assert.equal(
    sanitizeCopiedText(input, {
      stripTracking: false,
      stripBold: false,
      plainQuotes: false,
      underscoreItalics: false,
    }),
    input,
  );
});

test('removes rich-text bold and writes rich italics as underscore syntax', () => {
  assert.equal(
    sanitizeCopiedHtml('<p><strong>“Bold”</strong> and <em>italic</em></p>', {
      stripTracking: false,
      stripBold: true,
      plainQuotes: true,
      underscoreItalics: true,
    }),
    '<p>"Bold" and _italic_</p>',
  );
});

function runtimeFixture(settingValue, { clipboardAvailable = true } = {}) {
  const writes = [];
  const opened = [];
  class Clipboard {
    writeText(text) {
      writes.push(text);
      return Promise.resolve();
    }
  }
  const clipboard = clipboardAvailable ? new Clipboard() : undefined;
  const window = {
    open(url, ...args) {
      opened.push([url, ...args]);
      return { closed: false };
    },
  };
  const context = {
    navigator: { clipboard },
    document: {
      documentElement: {
        getAttribute: () => settingValue,
      },
    },
    URL,
    window,
  };
  if (clipboardAvailable) context.Clipboard = Clipboard;
  vm.runInNewContext(source, context);
  return { clipboard, writes, opened, window };
}

test('intercepts ChatGPT clipboard writes when the preference is enabled', async () => {
  const fixture = runtimeFixture('true');
  await fixture.clipboard.writeText('https://example.com/?utm_source=chatgpt.com&id=7');
  assert.deepEqual(fixture.writes, ['https://example.com/?id=7']);
});

test('normalizes copied response formatting in the clipboard runtime', async () => {
  const fixture = runtimeFixture('true');
  await fixture.clipboard.writeText('“**Bold** and *italic*”');
  assert.deepEqual(fixture.writes, ['"Bold and _italic_"']);
});

test('converts copied reference links in the clipboard runtime', async () => {
  const fixture = runtimeFixture('false');
  const input = '[source][1]\n\n[1]: https://example.com/report?utm_source=chatgpt.com';
  await fixture.clipboard.writeText(input);
  assert.deepEqual(
    fixture.writes,
    ['[source](https://example.com/report?utm_source=chatgpt.com)\n'],
  );
});

test('leaves ChatGPT clipboard writes untouched when the preference is disabled', async () => {
  const fixture = runtimeFixture('false');
  const input = 'https://example.com/?utm_source=chatgpt.com&id=7';
  await fixture.clipboard.writeText(input);
  assert.deepEqual(fixture.writes, [input]);
});

test('sanitizes popup URLs even when the Clipboard API is unavailable', () => {
  const fixture = runtimeFixture('true', { clipboardAvailable: false });
  const popup = fixture.window.open(
    'https://example.com/report?id=7&utm_source=chatgpt.com&utm_medium=referral#part',
    '_blank',
    'popup',
  );
  assert.equal(popup.closed, false);
  assert.deepEqual(fixture.opened, [[
    'https://example.com/report?id=7#part',
    '_blank',
    'popup',
  ]]);
});

test('leaves popup URLs untouched when tracking removal is disabled', () => {
  const fixture = runtimeFixture('false', { clipboardAvailable: false });
  const input = 'https://example.com/?utm_source=chatgpt.com&id=7';
  fixture.window.open(input, '_blank');
  assert.deepEqual(fixture.opened, [[input, '_blank']]);
});


test('removes a citation favicon and its standalone DOC filename from copied blockquotes', () => {
  const input = [
    'Under Part II.A.1, the report states:',
    '',
    '> Contractual claimants are generally afforded the status of mere unsecured creditors.',
    '>',
    '> [image](https://www.google.com/s2/favicons?domain=https://www.newyorkfed.org\\&sz=32)',
    '>',
    '> 2074323_5.DOC',
    '>',
    '',
    '[Open directly to page 25](https://www.newyorkfed.org/medialibrary/media/markets/Full_Report.pdf#page=30)',
  ].join('\n');
  const result = sanitizeCopiedText(input);
  assert.doesNotMatch(result, /favicons|2074323_5\.DOC|\[image\]/);
  assert.match(result, /Contractual claimants/);
  assert.match(result, /Full_Report\.pdf#page=30/);
});

test('removes a standalone favicon without swallowing the following content', () => {
  const input = 'One\n\n![image](https://www.google.com/s2/favicons?domain=sec.gov&sz=32)\n\nTwo';
  assert.equal(sanitizeCopiedText(input), 'One\n\n\n\nTwo');
});

test('preserves image citations and document filenames that are actual content', () => {
  const input = [
    'See 2074323_5.DOC for the precise paragraph.',
    '![Figure](https://newyorkfed.org/figure.png)',
    '[image](https://newyorkfed.org/diagram.png)',
    '[Open report](https://newyorkfed.org/full.pdf)',
  ].join('\n');
  assert.equal(sanitizeCopiedText(input), input);
});

test('does not remove an unrelated filename unless immediately after a citation favicon', () => {
  const input = '[image](https://www.google.com/s2/favicons?domain=sec.gov&sz=32)\n\nThe report states:\n\nsummary.DOC';
  const result = sanitizeCopiedText(input);
  assert.doesNotMatch(result, /favicons/);
  assert.match(result, /summary\.DOC/);
});

test('removes decorative favicons from rich HTML but preserves real image content', () => {
  const input = '<p>Source <img src="https://www.google.com/s2/favicons?domain=sec.gov&amp;sz=32" alt="image"></p><img src="https://sec.gov/chart.png" alt="Chart">';
  assert.equal(sanitizeCopiedHtml(input), '<p>Source </p><img src="https://sec.gov/chart.png" alt="Chart">');
});

test('citation previews are excluded regardless of optional text-formatting settings', () => {
  const input = '[image](https://www.google.com/s2/favicons?domain=sec.gov&sz=32)\n\nexample.PDF';
  assert.doesNotMatch(sanitizeCopiedText(input, {
    stripTracking: false, stripBold: false, plainQuotes: false, underscoreItalics: false,
  }), /favicon|example\.PDF/);
});


test('rich clipboard keeps explicitly disabled formatting while removing citation favicons', async () => {
  const writes = [];
  class Clipboard {
    write(items) { writes.push(items); return Promise.resolve(); }
  }
  class ClipboardItem {
    constructor(data, options) { this.data = data; this.types = Object.keys(data); this.presentationStyle = options?.presentationStyle; }
    getType(type) { return Promise.resolve(this.data[type]); }
  }
  const clipboard = new Clipboard();
  const context = {
    navigator: { clipboard },
    Clipboard,
    ClipboardItem,
    Blob,
    URL,
    document: {
      documentElement: {
        getAttribute(name) {
          return name === 'data-ghrc-strip-copied-bold' ? 'false' : 'true';
        },
      },
    },
    window: { open() {} },
  };
  vm.runInNewContext(source, context);
  const image = '<img src="https://www.google.com/s2/favicons?domain=sec.gov&amp;sz=32">';
  await clipboard.write([new ClipboardItem({
    'text/html': Promise.resolve(new Blob(['<strong>Important</strong>' + image], { type: 'text/html' })),
    'text/plain': Promise.resolve(new Blob(['**Important**\n[image](https://www.google.com/s2/favicons?domain=sec.gov&sz=32)'], { type: 'text/plain' })),
  })]);
  const copy = writes[0][0];
  assert.equal(await (await copy.getType('text/html')).text(), '<strong>Important</strong>');
  assert.equal(await (await copy.getType('text/plain')).text(), '**Important**');
});
