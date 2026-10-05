// Run with Playwright available: node --test tests/highlighted-pages.browser.cjs
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");
let context, temporary, server, origin, page, pdf;

before(async () => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "highlighted-pdf-test-"));
  const extension = path.join(temporary, "extension");
  fs.mkdirSync(extension);
  for (const directory of ["js", "css", "vendor/pdfjs"]) {
    fs.mkdirSync(path.join(extension, directory), { recursive: true });
  }
  for (const file of ["js/pdf-preview.mjs", "js/highlighted-pages-worker.js", "js/highlighted-pages-options.js", "js/highlighted-pages.js", "css/highlighted-pages.css", "css/options.css", "css/styles.css"]) {
    fs.copyFileSync(path.join(root, file), path.join(extension, file));
  }
  fs.cpSync(path.join(root, "vendor/pdfjs"), path.join(extension, "vendor/pdfjs"), { recursive: true });
  fs.writeFileSync(path.join(extension, "manifest.json"), JSON.stringify({
    manifest_version: 3, name: "PDF preview fixture", version: "1.0",
    permissions: ["storage"], host_permissions: ["http://127.0.0.1/*"],
    background: { service_worker: "js/highlighted-pages-worker.js" },
    content_security_policy: JSON.parse(fs.readFileSync(path.join(root, "manifest.json"))).content_security_policy,
  }));
  const options = fs.readFileSync(path.join(root, "options.html"), "utf8");
  const section = options.match(/<fieldset id="highlighted-pages-settings">[\s\S]*?<\/fieldset>/)[0];
  const template = options.match(/<template id="highlighted-page-template">[\s\S]*?<\/template>/)[0];
  fs.writeFileSync(path.join(extension, "fixture.html"), `<!doctype html><link rel="stylesheet" href="css/options.css"><link rel="stylesheet" href="css/styles.css"><link rel="stylesheet" href="css/highlighted-pages.css">${section}${template}<div id="github-repositories-for-chatgpt"><p>Repository dashboard</p></div><script src="js/highlighted-pages-options.js"></script><script src="js/highlighted-pages.js"></script>`);
  const popup = fs.readFileSync(path.join(root, "popup.html"), "utf8");
  const popupSection = popup.match(/<fieldset id="highlighted-pages-settings">[\s\S]*?<\/fieldset>/)[0];
  const popupTemplate = popup.match(/<template id="highlighted-page-template">[\s\S]*?<\/template>/)[0];
  fs.writeFileSync(path.join(extension, "popup-fixture.html"), `<!doctype html>${popupSection}${popupTemplate}<script src="js/highlighted-pages-options.js"></script>`);
  context = await chromium.launchPersistentContext(path.join(temporary, "profile"), {
    executablePath: process.env.BROWSER_EXECUTABLE || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const source = await context.newPage();
  await source.setContent('<style>@page{size:300px 600px;margin:0}body{margin:0}.sheet{height:600px;break-after:page;background:#ff0000}.sheet+div{background:#0000ff}</style><div class="sheet">FIRST PAGE</div><div class="sheet">SECOND PAGE</div>');
  pdf = await source.pdf({ preferCSSPageSize: true, printBackground: true });
  await source.close();
  server = http.createServer((request, response) => {
    if (request.url.startsWith("/redirect")) {
      response.writeHead(302, { location: "/report.pdf" });
      return response.end();
    }
    response.writeHead(200, { "content-type": "application/pdf" });
    response.end(request.url.startsWith("/invalid") ? "invalid PDF" : pdf);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const id = new URL(worker.url()).host;
  page = await context.newPage();
  await page.goto(`chrome-extension://${id}/fixture.html`);
});

after(async () => {
  await context?.close();
  await new Promise(resolve => server ? server.close(resolve) : resolve());
  if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
});

test("popup renders saved highlights and supports renaming without an exception", async () => {
  const popup = await context.newPage();
  const errors = [];
  popup.on("pageerror", error => errors.push(error.message));
  await page.evaluate(async () => chrome.storage.local.set({ highlightedPages: [{ id: "popup-test", url: "https://example.com/", title: "Example" }] }));
  await popup.goto(new URL("popup-fixture.html", page.url()).href);
  const rename = popup.locator(".rename-highlight");
  await rename.waitFor();
  popup.once("dialog", dialog => dialog.accept("Renamed from popup"));
  await rename.click();
  await popup.waitForFunction(() => document.querySelector(".highlighted-page-setting-copy strong")?.textContent === "Renamed from popup");
  assert.deepEqual(errors, []);
  await page.evaluate(async () => chrome.storage.local.set({ highlightedPages: [] }));
  await popup.close();
});

test("adding and refreshing a PDF caches the complete first page, preserves links, and fits the card", async () => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.locator("#highlighted-page-url").fill(`${origin}/redirect#page=2`);
  await page.locator("#add-highlighted-page").click();
  await page.waitForFunction(() => document.querySelector("#highlighted-pages-status").dataset.state === "success");
  const saved = await page.evaluate(async () => (await chrome.storage.local.get("highlightedPages")).highlightedPages[0]);
  assert.equal(saved.url, `${origin}/report.pdf#page=2`);
  assert.equal(saved.documentType, "pdf");
  assert.equal(saved.faviconDataUrl, "");
  assert.match(saved.imageDataUrl, /^data:image\/webp;base64,/);
  const pixels = await page.evaluate(async dataUrl => {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    return { width: image.width, height: image.height, color: [...context.getImageData(image.width / 2, image.height / 2, 1, 1).data] };
  }, saved.imageDataUrl);
  assert.equal(pixels.height, 560);
  assert.equal(pixels.width, 280);
  assert.ok(pixels.color[0] > 240 && pixels.color[2] < 20, "first page is red; second page is blue");
  await page.locator(".ghrc-highlighted-page-pdf img").waitFor();
  const layout = await page.evaluate(() => {
    const widget = document.getElementById("github-repositories-for-chatgpt");
    const highlights = document.getElementById("ghrc-highlighted-pages");
    const repositoryBounds = widget.getBoundingClientRect();
    const highlightBounds = highlights.getBoundingClientRect();
    return { separate: widget.nextElementSibling === highlights, below: highlightBounds.top > repositoryBounds.bottom, sameWidth: repositoryBounds.width === highlightBounds.width, title: highlights.querySelector("h2").textContent };
  });
  assert.deepEqual(layout, { separate: true, below: true, sameWidth: true, title: "Highlights" });
  const centered = await page.evaluate(() => {
    const heading = document.querySelector("#ghrc-highlighted-pages h2");
    const row = document.querySelector(".ghrc-highlighted-pages-row");
    const card = row.firstElementChild;
    const bounds = row.getBoundingClientRect();
    const cardBounds = card.getBoundingClientRect();
    return { heading: getComputedStyle(heading).textAlign, gap: parseFloat(getComputedStyle(heading).marginBottom), card: getComputedStyle(card).textAlign, offset: Math.abs(bounds.left + bounds.width / 2 - cardBounds.left - cardBounds.width / 2) };
  });
  assert.equal(centered.heading, "center");
  assert.equal(centered.card, "center");
  assert.ok(centered.gap >= 20);
  assert.ok(centered.offset < 1);
  assert.equal(await page.locator(".ghrc-highlighted-page-pdf img").evaluate(image => getComputedStyle(image).objectFit), "cover");
  assert.equal(await page.locator(".ghrc-highlighted-page-pdf img").evaluate(image => getComputedStyle(image).objectPosition), "50% 0%");
  assert.ok(await page.locator(".ghrc-highlighted-page").evaluate(card => card.getBoundingClientRect().width <= 220));
  assert.equal(await page.locator(".highlighted-page-setting-preview").evaluate(image => getComputedStyle(image).backgroundSize), "contain");
  // Refresh must reuse existing access rather than request another user gesture.
  await page.evaluate(() => document.querySelector(".refresh-highlight").click());
  await page.waitForFunction(() => document.querySelector("#highlighted-pages-status").textContent === "Cached preview refreshed.");
  assert.equal(await page.evaluate(async () => (await chrome.storage.local.get("highlightedPages")).highlightedPages[0].id), saved.id);
  assert.deepEqual(errors, []);
});

test("invalid PDFs fail visibly and are not added to the cached shelf", async () => {
  await page.locator("#highlighted-page-url").fill(`${origin}/invalid.pdf`);
  await page.locator("#add-highlighted-page").click();
  await page.waitForFunction(() => document.querySelector("#highlighted-pages-status").dataset.state === "error");
  assert.match(await page.locator("#highlighted-pages-status").textContent(), /first page could not be rendered/);
  assert.equal(await page.locator("#add-highlighted-page").isEnabled(), true);
  assert.equal(await page.evaluate(async () => (await chrome.storage.local.get("highlightedPages")).highlightedPages.length), 1);
});

test("custom highlight names survive refresh and reload, and can be cancelled or reset", async () => {
  page.once("dialog", dialog => dialog.accept("  My report  "));
  await page.locator(".rename-highlight").click();
  await page.waitForFunction(() => document.querySelector(".ghrc-highlighted-page-copy strong").textContent === "My report");
  assert.equal(await page.locator(".highlighted-page-setting-copy strong").textContent(), "My report");
  await page.locator(".refresh-highlight").click();
  await page.waitForFunction(() => document.querySelector("#highlighted-pages-status").textContent === "Cached preview refreshed.");
  await page.reload();
  await page.waitForFunction(() => document.querySelector(".ghrc-highlighted-page-copy strong")?.textContent === "My report");
  page.once("dialog", dialog => dialog.dismiss());
  await page.locator(".rename-highlight").click();
  assert.equal(await page.locator(".highlighted-page-setting-copy strong").textContent(), "My report");
  const saved = await page.evaluate(async () => (await chrome.storage.local.get("highlightedPages")).highlightedPages[0]);
  assert.equal(saved.customTitle, "My report");
  assert.equal(saved.title, "report.pdf");
  assert.equal(saved.url, `${origin}/report.pdf#page=2`);
  page.once("dialog", dialog => dialog.accept(" "));
  await page.locator(".rename-highlight").click();
  await page.waitForFunction(() => document.querySelector(".ghrc-highlighted-page-copy strong").textContent === "report.pdf");
});
