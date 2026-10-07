const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../js/spellcheck-launcher.js'), 'utf8');

function fixture({ nestedPicker = true, clipboard = 'clipboard text', draft = '' } = {}) {
  let now = 0;
  let menuStage = 0;
  let pluginSelected = false;

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
  const picker = makeAction('Add files and more', () => { menuStage = 1; });
  const plugins = makeAction('Plugins', () => { menuStage = 2; });
  const plugin = makeAction('Spellcheck Only', () => { pluginSelected = true; menuStage = 0; });

  const container = {
    parentElement: null,
    matches: () => false,
    querySelectorAll(selector) {
      if (/aria-label\*="add"|aria-label\*="attach"|aria-label\*="tools"|aria-label\*="more"|title\*="add"|title\*="attach"|title\*="tools"|title\*="more"/.test(selector)) return [picker];
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
    dispatchEvent(event) {
      if (event.type === 'paste') {
        this.innerText = event.clipboardData.text;
        return false;
      }
      return true;
    },
  };

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
    DataTransfer: class { setData(type, text) { this.text = text; } },
    ClipboardEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    window: {
      getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
      setTimeout(fn, delay) { now += delay; queueMicrotask(fn); },
    },
    document: {
      querySelector() { return composer; },
      querySelectorAll() {
        if (menuStage === 1) return nestedPicker ? [plugins] : [plugin];
        if (menuStage === 2) return [plugin];
        return [];
      },
      createRange: () => ({ selectNodeContents() {} }),
      execCommand(command, ui, text) { composer.innerText = text; return true; },
    },
    console: { warn() {} },
  };

  vm.createContext(context);
  const prefix = source.slice(0, source.indexOf('  chrome.storage.onChanged'));
  vm.runInContext(prefix + `
    globalThis.api = { launchSpellcheck, activateSpellcheckPlugin, pasteIntoComposer, submitWhenReady };
  })();`, context);

  return { context, composer, send, picker, plugins, plugin, api: context.api, get pluginSelected() { return pluginSelected; } };
}

test('selects Spellcheck Only through Plugins and sends clipboard text on the homepage', async () => {
  const f = fixture();
  await f.api.launchSpellcheck();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.pluginSelected, true);
  assert.equal(f.composer.innerText, 'clipboard text');
  assert.equal(f.send.clicks, 1);
  assert.equal(f.context.location.pathname, '/');
});

test('supports Spellcheck Only directly in the first composer menu', async () => {
  const f = fixture({ nestedPicker: false });
  await f.api.launchSpellcheck();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.pluginSelected, true);
  assert.equal(f.send.clicks, 1);
});

test('replaces an existing homepage draft with the clipboard text after plugin selection', async () => {
  const f = fixture({ draft: 'old draft', clipboard: 'replacement' });
  await f.api.launchSpellcheck();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.composer.innerText, 'replacement');
  assert.equal(f.send.clicks, 1);
});

test('blank clipboard does not open the plugin picker or submit', async () => {
  const f = fixture({ clipboard: '  \n' });
  await f.api.launchSpellcheck();
  assert.equal(f.pluginSelected, false);
  assert.equal(f.send.clicks, 0);
});

test('submission cancels if navigation leaves the main new-chat page', async () => {
  const f = fixture();
  await f.api.activateSpellcheckPlugin(f.composer);
  await f.api.pasteIntoComposer(f.composer, 'clipboard text');
  f.context.location.pathname = '/c/example';
  f.api.submitWhenReady(f.composer, 'clipboard text', 10_000);
  assert.equal(f.send.clicks, 0);
});
