const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../js/spellcheck-launcher.js'), 'utf8');

function fixture({ clipboard = 'clipboard text', draft = '', suggestionAvailable = true } = {}) {
  let now = 0;
  let suggestionOpen = false;
  let pluginSelected = false;
  let pluginSuggestionClicks = 0;
  let pickerLookups = 0;

  const makeAction = (text, onClick = () => {}) => ({
    textContent: text,
    isConnected: true,
    disabled: false,
    getClientRects: () => [{}],
    getAttribute(name) { return name === 'aria-label' ? text : null; },
    click() { onClick(); },
  });

  const send = makeAction('Send', () => { send.clicks++; });
  send.clicks = 0;

  const mention = {
    textContent: 'Spellcheck Only',
    isConnected: true,
    getClientRects: () => [{}],
    getAttribute(name) {
      return ({
        'app-mention-name': 'spellcheck-only',
        'app-mention-display-name': 'Spellcheck Only',
        'app-mention-path': 'app://plugin/spellcheck-only',
      })[name] ?? null;
    },
  };

  const plugin = makeAction('Spellcheck Only', () => {
    pluginSuggestionClicks++;
    pluginSelected = true;
    suggestionOpen = false;
    composer.innerText = 'Spellcheck Only';
  });

  const suggestionSurface = {
    isConnected: true,
    getClientRects: () => [{}],
    closest: () => null,
    querySelectorAll() { return suggestionAvailable ? [plugin] : []; },
  };

  const container = {
    parentElement: null,
    matches: () => false,
    querySelectorAll(selector) {
      if (/aria-label\*="add"|aria-label\*="attach"|aria-label\*="tools"|aria-label\*="more"/.test(selector)) pickerLookups++;
      if (/send-button|aria-label\^="Send"|composer-submit-button/.test(selector)) return [send];
      return [];
    },
  };

  const composer = {
    parentElement: container,
    innerText: draft,
    children: [],
    isContentEditable: true,
    isConnected: true,
    focus() {},
    closest() { return null; },
    querySelectorAll(selector) {
      return selector === '[app-mention-path]' && pluginSelected ? [mention] : [];
    },
  };

  const selection = { removeAllRanges() {}, addRange() {} };
  const context = {
    __ghrcExtensionContext: { active: () => true },
    chrome: { runtime: { getURL: (x) => x }, storage: { local: {} } },
    Date: { now: () => now },
    location: { pathname: '/' },
    navigator: { clipboard: { readText: async () => clipboard } },
    HTMLTextAreaElement: class {},
    HTMLInputElement: class {},
    InputEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    KeyboardEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    window: {
      getSelection: () => selection,
      setTimeout(fn, delay) { now += delay; queueMicrotask(fn); },
    },
    document: {
      querySelector() { return composer; },
      querySelectorAll(selector) {
        if (/data-mention-list-scroll-area|role="listbox"/.test(selector)) {
          return suggestionOpen ? [suggestionSurface] : [];
        }
        return [];
      },
      createRange: () => ({ selectNodeContents() {}, collapse() {} }),
      execCommand(command, ui, text) {
        if (command !== 'insertText') return false;
        if (text === '@') {
          composer.innerText = '@';
          pluginSelected = false;
          suggestionOpen = true;
          return true;
        }
        if (composer.innerText === '@' && text === 'Spellcheck Only') {
          composer.innerText = '@Spellcheck Only';
          suggestionOpen = true;
          return true;
        }
        if (pluginSelected && text.startsWith('\n')) {
          composer.innerText += text;
          return true;
        }
        composer.innerText = text;
        return true;
      },
    },
    console: { warn() {} },
  };

  vm.createContext(context);
  const prefix = source.slice(0, source.indexOf('  chrome.storage.onChanged'));
  vm.runInContext(prefix + `
    globalThis.api = { launchSpellcheck, activateSpellcheckPlugin, appendSpellcheckText, submitWhenReady };
  })();`, context);

  return {
    context, composer, send, api: context.api,
    get pluginSelected() { return pluginSelected; },
    get pluginSuggestionClicks() { return pluginSuggestionClicks; },
    get pickerLookups() { return pickerLookups; },
  };
}

test('resolves Spellcheck Only through the app mention service and sends clipboard text', async () => {
  const f = fixture();
  await f.api.launchSpellcheck();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.pluginSelected, true);
  assert.equal(f.pluginSuggestionClicks, 1);
  assert.equal(f.pickerLookups, 0);
  assert.equal(f.composer.innerText, 'Spellcheck Only\nclipboard text');
  assert.equal(f.send.clicks, 1);
});

test('replaces an existing homepage draft before resolving the plugin mention', async () => {
  const f = fixture({ draft: 'old draft', clipboard: 'replacement' });
  await f.api.launchSpellcheck();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.pluginSelected, true);
  assert.equal(f.composer.innerText, 'Spellcheck Only\nreplacement');
  assert.equal(f.send.clicks, 1);
});

test('blank clipboard does not resolve the plugin or submit', async () => {
  const f = fixture({ clipboard: '  \n' });
  await f.api.launchSpellcheck();
  assert.equal(f.pluginSelected, false);
  assert.equal(f.pluginSuggestionClicks, 0);
  assert.equal(f.send.clicks, 0);
});

test('missing Spellcheck Only mention result fails closed without submitting', async () => {
  const f = fixture({ suggestionAvailable: false });
  await f.api.launchSpellcheck();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.pluginSelected, false);
  assert.equal(f.send.clicks, 0);
  assert.equal(f.pickerLookups, 0);
});

test('submission cancels if navigation leaves the main new-chat page', async () => {
  const f = fixture();
  assert.equal(await f.api.activateSpellcheckPlugin(f.composer), true);
  assert.equal(await f.api.appendSpellcheckText(f.composer, 'clipboard text'), true);
  f.context.location.pathname = '/c/example';
  f.api.submitWhenReady(f.composer, 'clipboard text', 10_000);
  assert.equal(f.send.clicks, 0);
});
