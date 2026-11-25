const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../js/chat/stale-rate-limit.js"), "utf8");
const context = vm.createContext({});
const boundary = source.indexOf("  const context = globalThis.__ghrcExtensionContext;");
assert.ok(boundary > 0);
vm.runInContext(source.slice(0, boundary) + "globalThis.synchronize = synchronize; })();", context);
const { synchronize } = context;

function fixture() {
  const root = {textContent:"", parentElement:null, querySelectorAll:()=>assistants};
  const assistants = [];
  const texts = [];
  const marked = new Set();
  const doc = {
    querySelectorAll:()=>Array.from(marked),
    createTreeWalker:()=>{let i=0;return {nextNode:()=>texts[i++] || null};}
  };
  function marker(order, {quoted=false, interactive=false, icon=true, label="Rate limited"}={}) {
    const row = {
      textContent:label, parentElement:root, children:[{}, {}, {}],
      matches: selector=>selector === 'div, [role="status"], [role="separator"]',
      querySelector: selector=>selector === "svg" ? (icon ? {} : null) : (interactive ? {} : null),
      contains:()=>false,
      compareDocumentPosition:other=>other.order>order ? 4 : 2,
      hasAttribute:()=>marked.has(row),
      setAttribute:()=>marked.add(row),
      removeAttribute:()=>marked.delete(row)
    };
    const span = {textContent:label,parentElement:row,children:[],closest:()=>quoted?{}:null,matches:()=>false};
    texts.push({nodeValue:label,parentElement:span});
    return row;
  }
  function response(order,textContent,contains=()=>false) {
    assistants.push({order,textContent,contains});
  }
  return {root,doc,marker,response,marked};
}

test("keeps an active limit and an empty assistant placeholder", () => {
  const f = fixture();
  (f=>{f.marker(2);f.response(1,"Earlier answer");f.response(3,"");})(f);
  synchronize(f.root, f.doc, true);
  assert.equal(f.marked.size, 0);
  synchronize(f.root, f.doc, false);
  assert.equal(f.marked.size, 0);
});

test("clears the old divider after a later assistant response", () => {
  const f = fixture();
  (f=>{f.marker(1);f.response(2,"Working on the repair");})(f);
  synchronize(f.root, f.doc, true);
  assert.equal(f.marked.size, 1);
  synchronize(f.root, f.doc, false);
  assert.equal(f.marked.size, 0);
});

test("does not hide a newer rate limit", () => {
  const f = fixture();
  (f=>{f.marker(1);f.response(2,"Recovered");f.marker(3);f.response(4,"Rate limited");})(f);
  synchronize(f.root, f.doc, true);
  assert.equal(f.marked.size, 1);
  synchronize(f.root, f.doc, false);
  assert.equal(f.marked.size, 0);
});

test("ignores quoted text, controls and text without an icon", () => {
  const f = fixture();
  (f=>{f.marker(1,{quoted:true});f.marker(1,{interactive:true});f.marker(1,{icon:false});f.response(2,"Answer");})(f);
  synchronize(f.root, f.doc, true);
  assert.equal(f.marked.size, 0);
  synchronize(f.root, f.doc, false);
  assert.equal(f.marked.size, 0);
});

test("does not hide a marker nested in its own assistant response", () => {
  const f = fixture();
  (f=>{const row=f.marker(1);f.response(2,"Answer",node=>node===row);})(f);
  synchronize(f.root, f.doc, true);
  assert.equal(f.marked.size, 0);
  synchronize(f.root, f.doc, false);
  assert.equal(f.marked.size, 0);
});
