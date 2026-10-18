const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {MAX_ISSUES,parseIssueUrl,normalizePinnedIssues}=require("../js/pinned-issues-model.js");
test("GitHub issue URLs are canonicalized",()=>{
  assert.deepEqual(parseIssueUrl("https://github.com/pony-factor/flawless-GPT/issues/12?x=y#c"),
    {url:"https://github.com/pony-factor/flawless-GPT/issues/12",owner:"pony-factor",repository:"flawless-GPT",number:12});
  assert.equal(parseIssueUrl("github.com/o/r/issues/1/").url,"https://github.com/o/r/issues/1");
  for(const url of ["https://evil.example/o/r/issues/1","http://github.com/o/r/issues/1",
    "https://github.com/o/r/pull/1","https://github.com/o/r/issues/0",
    "https://github.com/o/r/issues/1/extra","javascript:alert(1)",
    "https://user:pass@github.com/o/r/issues/1",
    "https://github.com/o/r/issues/9007199254740992"])assert.throws(()=>parseIssueUrl(url));
});
test("normalizer deduplicates, rejects untrusted links and limits labels",()=>{
  const many=Array.from({length:MAX_ISSUES+4},(_,index)=>({
    url:`https://github.com/o/r/issues/${index+1}`,label:"x".repeat(140)}));
  const pins=normalizePinnedIssues([null,{url:"https://github.com/O/R/issues/1",label:"<img onerror=alert(1)>"},
    ...many,{url:"https://evil.example/o/r/issues/8"}]);
  assert.equal(pins.length,MAX_ISSUES);
  assert.equal(pins[0].label,"<img onerror=alert(1)>");
  assert.equal(pins[1].number,2);
  assert.equal(pins[1].label.length,120);
});
test("settings panels and content scripts load pinned issues before Highlights",()=>{
  for(const name of ["options.html","popup.html"]){
    const html=fs.readFileSync(path.join(__dirname,"..",name),"utf8");
    assert.ok(html.indexOf('id="pinned-issues-settings"')<html.indexOf('id="highlighted-pages-settings"'));
    assert.ok(html.includes('id="pinned-issue-template"'));
    assert.ok(html.indexOf("js/pinned-issues-model.js")<html.indexOf("js/pinned-issues-options.js"));
  }
  const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,"..","manifest.json"),"utf8"));
  const scripts=manifest.content_scripts.find(x=>x.js.includes("js/highlighted-pages.js")).js;
  assert.ok(scripts.indexOf("js/pinned-issues-model.js")<scripts.indexOf("js/pinned-issues.js"));
  assert.ok(scripts.indexOf("js/pinned-issues.js")<scripts.indexOf("js/highlighted-pages.js"));
});
