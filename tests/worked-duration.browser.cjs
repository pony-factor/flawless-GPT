// Optional Playwright regression: run with node --test tests/worked-duration.browser.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const css = fs.readFileSync(path.join(__dirname, "../css/worked-duration.css"), "utf8");
const source = fs.readFileSync(path.join(__dirname, "../js/chat/worked-duration.js"), "utf8");

test("clicking the cannon toggles native details without an extra chevron", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const layout of ["direct", "nested"]) {
      const page = await browser.newPage();
      try {
        const direct = layout === "direct";
        const label = direct ? 'aria-label="Worked for 59s"' : "";
        const body = direct
          ? '<span>Original duration</span>'
          : '<span id="duration">Worked for 59s</span>';
        await page.setContent(`<main><button type="button" id="disclosure"
          aria-expanded="false" ${label}>
          <svg id="chevron" width="14" height="14"><path d="m2 4 5 5 5-5"/></svg>
          ${body}</button></main>`);
        await page.addStyleTag({ content: css });
        await page.evaluate(() => {
          window.__ghrcExtensionContext = { active: () => true, onStop() {} };
          window.chrome = {
            runtime: { getURL: name => "chrome-extension://fixture/" + name },
            storage: {
              local: { get: async defaults => defaults },
              onChanged: { addListener() {}, removeListener() {} },
            },
          };
          document.querySelector("#disclosure").addEventListener("click", function () {
            this.setAttribute("aria-expanded",
              this.getAttribute("aria-expanded") === "true" ? "false" : "true");
          });
        });
        await page.addScriptTag({ content: source });
        await page.waitForFunction(() =>
          document.querySelector("[data-ghrc-worked-duration]")?.getAttribute("data-ghrc-worked-minutes") === "");
        assert.equal(await page.locator("#disclosure").isVisible(), false,
          `${layout}: no empty control below one minute`);

        if (direct) {
          await page.locator("#disclosure").evaluate(node => node.setAttribute("aria-label", "Worked for 1m"));
        } else {
          await page.locator("#duration").evaluate(node => { node.textContent = "Worked for 1m"; });
        }
        await page.waitForFunction(() =>
          document.querySelector("[data-ghrc-worked-duration]")?.getAttribute("data-ghrc-worked-minutes") === "1m");
        assert.equal(await page.locator("#disclosure").isVisible(), true,
          `${layout}: native clickable disclosure is visible at one minute`);
        assert.equal(await page.locator("#chevron").evaluate(node => getComputedStyle(node).display), "none",
          `${layout}: native chevron graphic is hidden`);
        assert.equal(await page.locator("[data-ghrc-worked-duration]").evaluate(node =>
          getComputedStyle(node, "::before").display), "inline-block",
          `${layout}: cannon artwork remains visible`);

        // This hits the badge itself, not an arrow or a synthetic proxy button.
        const badge = page.locator("[data-ghrc-worked-duration]");
        await badge.click({ position: { x: 8, y: 9 } });
        assert.equal(await page.locator("#disclosure").getAttribute("aria-expanded"), "true",
          `${layout}: clicking cannon opens native disclosure`);
        await page.locator("#disclosure").press("Enter");
        assert.equal(await page.locator("#disclosure").getAttribute("aria-expanded"), "false",
          `${layout}: native keyboard activation still works`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});
