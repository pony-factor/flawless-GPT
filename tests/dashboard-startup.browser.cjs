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
  for (const file of ["artwork/calligraphy-initials.png", "artwork/detective-zip.png", "artwork/spellcheck-only.jpg"]) {
    fs.mkdirSync(path.dirname(path.join(extension, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(extension, file));
  }
  const workerScript = "dashboard-startup-worker.js";
  fs.writeFileSync(path.join(extension, "manifest.json"), JSON.stringify({
    manifest_version: 3, name: "Dashboard startup fixture", version: "1.0",
    permissions: ["storage"], background: { service_worker: workerScript },
    content_scripts: scripts,
    web_accessible_resources: [{ resources: ["artwork/*"], matches: ["http://127.0.0.1/*"] }],
  }));
  fs.writeFileSync(path.join(extension, workerScript), `
    chrome.runtime.onMessage.addListener((message, sender, reply) => {
      if (message.type === "load-repositories") {
        const respond = () => reply({ok:true,mode:"public",ownerOrder:["octo"],repositories:[{name:"example",fullName:"octo/example",url:"https://github.com/octo/example",pushedAt:new Date().toISOString(),owner:{login:"octo",type:"User",displayName:"Octo",avatarUrl:""}}]});
        if (globalThis.repositoriesReleased) {
          respond();
          return;
        }
        globalThis.releaseRepositories = () => {
          globalThis.repositoriesReleased = true;
          respond();
        };
        return true;
      }
      else {
        if (message.type === "open-wooten-link") globalThis.wootenSearchUrl = message.url;
        if (message.type === "open-chat-dispatcher") globalThis.openedDispatcher = true;
        reply({ok:true});
      }
    });
  `);
  let stalledResponse;
  let markupTimer;
  const server = http.createServer((request, response) => {
    if (request.url === "/slow.png") { stalledResponse = response; return; }
    response.writeHead(200, { "content-type": "text/html" });
    response.write(`<style>body{margin:0}.group\\/home-composer-layout{display:flex;flex-direction:column;min-height:100vh;justify-content:center}</style>
      <header>ChatGPT</header><main><div class="group/home-composer-layout"><div class="home-composer-anchor">Welcome</div>
      <script>
        window.startupFrames = [];
        function sample() {
          const welcome = document.querySelector(".home-composer-anchor");
          const composer = document.querySelector("form");
          startupFrames.push({
            welcomeVisible: !!welcome.getClientRects().length,
            top: composer?.getBoundingClientRect().top,
            headerVisible: document.querySelector("header").checkVisibility({opacityProperty:true,visibilityProperty:true}),
            canvasVisible: document.querySelector("main").checkVisibility({opacityProperty:true,visibilityProperty:true}),
            repositories: document.querySelectorAll(".ghrc-repository").length,
          });
          requestAnimationFrame(sample);
        }
        requestAnimationFrame(sample);
      </script>`);
    markupTimer = setTimeout(() => response.end('<form><div id="prompt-textarea" contenteditable="true"></div><button type="button">Send</button></form></div><img src="/slow.png"></main>'), 300);
  });
  let context;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    context = await chromium.launchPersistentContext(path.join(temporary, "profile"), {
      executablePath: process.env.BROWSER_EXECUTABLE || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    // Chromium can expose unrelated service workers in a persistent context.
    // Select this fixture explicitly before touching extension-only APIs.
    const isDashboardWorker = candidate => {
      const url = new URL(candidate.url());
      return url.protocol === "chrome-extension:" && url.pathname === `/${workerScript}`;
    };
    const worker = context.serviceWorkers().find(isDashboardWorker)
      || await context.waitForEvent("serviceworker", { predicate: isDashboardWorker, timeout: 10000 });
    // A worker target can be reported before its extension API bindings are ready.
    let storageReady = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      storageReady = await worker.evaluate(() => Boolean(globalThis.chrome?.storage?.local));
      if (storageReady) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(storageReady, `Dashboard fixture storage unavailable in ${worker.url()}`);
    await worker.evaluate(() => chrome.storage.local.set({
      showWootenLinkSearch: true, compactNewChatHeader: true, show2048Launcher: true,
      highlightedPages: [{ id: "saved", url: "https://example.com/", title: "Saved highlight" }],
    }));
    const page = await context.newPage();
    await page.route("https://wooten.link/404.html", route => route.fulfill({
      status: 200, contentType: "text/html", body: "<html></html>",
    }));
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    // Never wait for load: the image response remains deliberately pending.
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "domcontentloaded" });
    const widget = page.locator("#github-repositories-for-chatgpt");
    await widget.getByText("Loading repositories…").waitFor({ state: "attached" });
    await page.waitForFunction(() => startupFrames.some(frame => frame.top !== undefined));
    const waitingFrames = await page.evaluate(() => startupFrames);
    assert.ok(waitingFrames.every(frame => !frame.headerVisible && !frame.canvasVisible), JSON.stringify(waitingFrames));
    await worker.evaluate(() => globalThis.releaseRepositories());
    await widget.locator(".ghrc-repository").waitFor({ state: "visible" });
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
    const bulkMerge = page.locator(".ghrc-chat-dispatcher");
    assert.equal(await bulkMerge.count(), 1, "bulk merge stays enabled for existing users");
    assert.equal(await bulkMerge.getAttribute("aria-label"), "Bulk merge");
    assert.equal(await bulkMerge.getAttribute("title"), "Open Chat Dispatcher in a new tab");
    assert.equal(await bulkMerge.locator("svg.ghrc-sort-icon path").count(), 5);
    assert.equal(await bulkMerge.innerText(), "", "button is icon-only");
    await bulkMerge.click();
    // The click dispatches an asynchronous message to the extension worker.
    let openedDispatcher = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      openedDispatcher = await worker.evaluate(() => globalThis.openedDispatcher === true);
      if (openedDispatcher) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(openedDispatcher, true, "bulk merge requested the Chat Dispatcher");
    await worker.evaluate(() => chrome.storage.local.set({ showBulkMergeButton: false }));
    await bulkMerge.waitFor({ state: "detached" });
    assert.equal(await bulkMerge.count(), 0, "hiding the shortcut does not remove the dashboard");
    await worker.evaluate(() => chrome.storage.local.set({ showBulkMergeButton: true }));
    await bulkMerge.waitFor({ state: "visible" });
    const iconSubmit = page.locator(".ghrc-wooten-link-mark-submit");
    const wootenInput = page.locator(".ghrc-wooten-link-search input");
    assert.equal(await iconSubmit.getAttribute("type"), "submit");
    assert.equal(await iconSubmit.getAttribute("aria-label"), "Search WootenLink");
    assert.equal(await iconSubmit.locator("img.ghrc-wooten-link-mark").count(), 1);
    // Empty searches should focus the field instead of navigating.
    await iconSubmit.click();
    assert.equal(await wootenInput.evaluate(input => document.activeElement === input), true);
    const searchSubmit = page.locator(".ghrc-wooten-link-submit");
    await page.waitForFunction(() =>
      document.querySelector(".ghrc-wooten-link-zipp-placeholder")?.naturalWidth > 0);
    const desktop = page.viewportSize();
    for (const viewport of [desktop, { width: 400, height: 800 }]) {
      await page.setViewportSize(viewport);
      const inputBounds = await wootenInput.boundingBox();
      const submitBounds = await searchSubmit.boundingBox();
      assert.ok(submitBounds.x >= inputBounds.x && submitBounds.y >= inputBounds.y);
      assert.ok(submitBounds.x + submitBounds.width <= inputBounds.x + inputBounds.width);
      assert.ok(submitBounds.y + submitBounds.height <= inputBounds.y + inputBounds.height);
      assert.ok(inputBounds.x + inputBounds.width - submitBounds.x - submitBounds.width <= 2);
    }
    await page.setViewportSize(desktop);
    await wootenInput.fill("Sweetie Belle");
    await searchSubmit.click();
    let submittedUrl = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      submittedUrl = await worker.evaluate(() => globalThis.wootenSearchUrl || null);
      if (submittedUrl) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(submittedUrl, "icon click submitted the search");
    assert.equal(new URL(submittedUrl).origin, "https://wooten.link");
    assert.equal(new URL(submittedUrl).searchParams.get("q"), "Sweetie Belle");

    const frames = await page.evaluate(() => startupFrames);
    assert.ok(frames.some(frame => frame.top === undefined), 'sample before React adds the composer');
    const firstVisible = frames.find(frame => frame.headerVisible || frame.canvasVisible);
    assert.ok(firstVisible?.headerVisible && firstVisible.canvasVisible);
    assert.equal(firstVisible.repositories, 1);
    assert.ok(frames.every(frame => !frame.welcomeVisible), JSON.stringify(frames));
    assert.ok(frames.filter(frame => frame.top !== undefined).every(frame => frame.top < 100), JSON.stringify(frames));
    const linkTitles = ".ghrc-repository-name, .ghrc-owner-name-link h3, .ghrc-pinned-issue strong";
    await worker.evaluate(() => chrome.storage.local.set({
      pinnedIssues: [{ url: "https://github.com/octo/example/issues/1" }],
    }));
    await page.locator(".ghrc-pinned-issue strong").waitFor();
    const linkColors = () => page.locator(linkTitles).evaluateAll(links =>
      links.map(link => getComputedStyle(link).color));
    await page.evaluate(() => document.documentElement.classList.add("light"));
    const defaultColors = await linkColors();
    assert.equal(defaultColors.length, 3);
    await worker.evaluate(() => chrome.storage.local.set({
      dashboardColors: { repositoryLight: "#2456ab", repositoryDark: "#ac65cf" },
    }));
    await page.waitForFunction(() =>
      document.documentElement.style.getPropertyValue("--ghrc-dashboard-link-light") === "#2456ab");
    assert.deepEqual(await linkColors(), Array(3).fill("rgb(36, 86, 171)"));
    await page.evaluate(() => document.documentElement.classList.replace("light", "dark"));
    assert.deepEqual(await linkColors(), Array(3).fill("rgb(172, 101, 207)"));
    await page.evaluate(() => document.documentElement.classList.replace("dark", "light"));
    await worker.evaluate(() => chrome.storage.local.remove("dashboardColors"));
    await page.waitForFunction(() =>
      !document.documentElement.style.getPropertyValue("--ghrc-dashboard-link-light"));
    assert.deepEqual(await linkColors(), defaultColors);
    assert.deepEqual(errors, []);
  } finally {
    stalledResponse?.end();
    clearTimeout(markupTimer);
    await context?.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
