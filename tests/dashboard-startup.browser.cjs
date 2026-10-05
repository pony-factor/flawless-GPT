// Verify the actual manifest timing in an isolated extension while the host page is still loading.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { chromium } = require("playwright");

test("cached dashboard controls and highlights mount before the host page finishes loading", async () => {
  const root = path.resolve(__dirname, "..");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-startup-"));
  const extension = path.join(temporary, "extension");
  fs.mkdirSync(extension);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const scripts = manifest.content_scripts.filter(entry => entry.matches.includes("https://chatgpt.com/*"));
  for (const entry of scripts) {
    for (const file of [...(entry.js || []), ...(entry.css || [])]) {
      fs.mkdirSync(path.dirname(path.join(extension, file)), { recursive: true });
      fs.copyFileSync(path.join(root, file), path.join(extension, file));
    }
    entry.matches = ["http://127.0.0.1/*"];
  }
  for (const file of ["artwork/calligraphy-initials.png", "artwork/spellcheck-only.png"]) {
    fs.mkdirSync(path.dirname(path.join(extension, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(extension, file));
  }
  fs.writeFileSync(path.join(extension, "manifest.json"), JSON.stringify({
    manifest_version: 3, name: "Dashboard startup fixture", version: "1.0",
    permissions: ["storage"], background: { service_worker: "background.js" },
    content_scripts: scripts,
    web_accessible_resources: [{ resources: ["artwork/*"], matches: ["http://127.0.0.1/*"] }],
  }));
  fs.writeFileSync(path.join(extension, "background.js"), `
    chrome.runtime.onMessage.addListener((message, sender, reply) => {
      if (message.type === "load-repositories") reply({ok:true,mode:"public",ownerOrder:["octo"],repositories:[{name:"example",fullName:"octo/example",url:"https://github.com/octo/example",pushedAt:new Date().toISOString(),owner:{login:"octo",type:"User",displayName:"Octo",avatarUrl:""}}]});
      else reply({ok:true});
    });
  `);
  let stalledResponse;
  let markupTimer;
  const server = http.createServer((request, response) => {
    if (request.url === "/slow.png") { stalledResponse = response; return; }
    response.writeHead(200, { "content-type": "text/html" });
    response.write('<style>body{margin:0}.group\\/home-composer-layout{display:flex;flex-direction:column;min-height:100vh;justify-content:center}</style><main><div class="group/home-composer-layout"><div class="home-composer-anchor">Welcome</div><script>window.startupFrames=[];function sample(){const w=document.querySelector(".home-composer-anchor"),c=document.querySelector("form");if(w)startupFrames.push({welcomeVisible:!!w.getClientRects().length,top:c?.getBoundingClientRect().top});requestAnimationFrame(sample)}requestAnimationFrame(sample)</script>');
    markupTimer = setTimeout(() => response.end('<form><div id="prompt-textarea" contenteditable="true"></div><button type="button">Send</button></form></div><img src="/slow.png"></main>'), 300);
  });
  let context;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    context = await chromium.launchPersistentContext(path.join(temporary, "profile"), {
      executablePath: process.env.BROWSER_EXECUTABLE || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    await worker.evaluate(() => chrome.storage.local.set({
      showWootenLinkSearch: true, compactNewChatHeader: true, show2048Launcher: true,
      highlightedPages: [{ id: "saved", url: "https://example.com/", title: "Saved highlight" }],
    }));
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    // Never wait for load: the image response remains deliberately pending.
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector(".ghrc-youtube-search") && document.querySelector("#ghrc-highlighted-pages"), { timeout: 2000 });
    const state = await page.evaluate(() => ({
      ready: document.readyState,
      repositories: document.querySelectorAll(".ghrc-repository").length,
      grouped: document.querySelector(".ghrc-wooten-link-search").parentElement === document.querySelector(".ghrc-youtube-search").parentElement,
      styled: getComputedStyle(document.querySelector(".ghrc-footer-searches")).display,
      imageHeight: document.querySelector(".ghrc-wooten-link-zipp-placeholder").getBoundingClientRect().height,
      launcher: Boolean(document.querySelector("#ghrc-2048-launcher")),
    }));
    assert.equal(state.ready, "interactive");
    assert.equal(state.repositories, 1);
    assert.equal(state.grouped, true);
    assert.equal(state.styled, "flex");
    assert.ok(state.imageHeight > 0 && state.imageHeight < 50);
    assert.equal(state.launcher, true);
    const frames = await page.evaluate(() => startupFrames);
    assert.ok(frames.some(frame => frame.top === undefined), 'sample before React adds the composer');
    assert.ok(frames.every(frame => !frame.welcomeVisible), JSON.stringify(frames));
    assert.ok(frames.filter(frame => frame.top !== undefined).every(frame => frame.top < 100), JSON.stringify(frames));
    assert.deepEqual(errors, []);
  } finally {
    stalledResponse?.end();
    clearTimeout(markupTimer);
    await context?.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
