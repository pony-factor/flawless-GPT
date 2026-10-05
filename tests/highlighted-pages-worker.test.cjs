const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "../js/highlighted-pages-worker.js"),
  "utf8",
);

function api(overrides = {}) {
  const helpers = {};
  const context = { __GHRC_HIGHLIGHTED_PAGES_TEST__: helpers, URL, Set, TextDecoder, Uint8Array, btoa, ...overrides };
  vm.createContext(context);
  vm.runInContext(source, context);
  return helpers;
}

test("extracts Open Graph preview metadata regardless of attribute order", () => {
  const helpers = api();
  const html = '<meta content="Example title" property="og:title"><meta name="description" content="A short description">';
  assert.equal(helpers.documentTitle(html), "Example title");
  assert.equal(helpers.metaContent(html, ["description"]), "A short description");
});

test("marks PDFs for first-page rendering without fetching a favicon", async () => {
  const url = "https://www.sec.gov/comments/sr-occ-2025-801/srocc2025801-598095-1737722.pdf";
  let cancelled = false;
  const helpers = api({ fetch: async (requested, options) => {
    if (requested === url) {
      assert.ok(options.headers.Accept.includes("application/pdf"));
      return {
        ok: true, url,
        headers: new Headers({ "content-type": "application/pdf" }),
        body: { cancel: async () => { cancelled = true; } },
        arrayBuffer: () => { throw new Error("PDF body must not be read"); },
      };
    }
    throw new Error(`Unexpected request: ${requested}`);
  } });
  const preview = await helpers.loadPreview(url);
  assert.equal(preview.url, url);
  assert.equal(preview.title, "srocc2025801-598095-1737722.pdf");
  assert.equal(preview.hostname, "sec.gov");
  assert.equal(preview.description, "PDF document");
  assert.equal(preview.documentType, "pdf");
  assert.equal(preview.faviconDataUrl, "");
  assert.equal(cancelled, true);
});

test("uses the redirected PDF filename and preserves page fragments without a favicon", async () => {
  const helpers = api({ fetch: async (url) => {
    if (url.endsWith("/favicon.ico")) throw new Error("No favicon");
    return {
      ok: true, url: "https://example.com/Annual%20Report.PDF",
      headers: new Headers({ "content-type": "application/pdf; charset=binary" }),
    };
  } });
  const preview = await helpers.loadPreview("https://example.com/download#page=3");
  assert.equal(preview.title, "Annual Report.PDF");
  assert.equal(preview.url, "https://example.com/Annual%20Report.PDF#page=3");
  assert.equal(preview.faviconDataUrl, "");
});

test("keeps HTML previews working even when the URL ends in .pdf", async () => {
  const helpers = api({ fetch: async (url) => {
    if (url.endsWith("/favicon.ico")) return new Response("", { status: 404 });
    return new Response("<title>HTML page</title>", {
      headers: { "content-type": "text/html" },
    });
  } });
  const preview = await helpers.loadPreview("https://example.com/report.pdf");
  assert.equal(preview.title, "HTML page");
  assert.equal(preview.description, "");
});

test("continues to reject unsupported content and HTTP errors", async () => {
  const helpers = api({ fetch: async () => new Response("{}", {
    headers: { "content-type": "application/json" },
  }) });
  await assert.rejects(helpers.loadPreview("https://example.com/report.pdf"), /HTML webpage or PDF/);
  const denied = api({ fetch: async () => new Response("Denied", { status: 403 }) });
  await assert.rejects(denied.loadPreview("https://example.com/report.pdf"), /HTTP 403/);
});

test("falls back to the document title and favicon", () => {
  const helpers = api();
  const html = '<title>Fallback &amp; title</title><link href="/brand.ico" rel="shortcut icon">';
  assert.equal(helpers.documentTitle(html), "Fallback & title");
  assert.equal(helpers.iconHref(html), "/brand.ico");
});

test("resolves relative preview URLs", () => {
  const helpers = api();
  assert.equal(
    helpers.absoluteUrl("../preview.png", "https://example.com/docs/page"),
    "https://example.com/preview.png",
  );
});
