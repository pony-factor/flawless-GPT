const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync(require.resolve("../js/content.js"), "utf8");
const stylesheet = fs.readFileSync(require.resolve("../css/styles.css"), "utf8");
const helper = source.match(/  function chooseWootenLinkPlacement\([\s\S]*?\n  }\n/)?.[0];
assert.ok(helper, "WootenLink placement helper is present");
const choosePlacement = new Function(`${helper}\nreturn chooseWootenLinkPlacement;`)();

test("WootenLink search results open below the footer when there is room", () => {
  const placement = choosePlacement({ top: 350, bottom: 390 }, 280, 900);
  assert.deepEqual(placement, { upward: false, maxHeight: 280 });
});

test("WootenLink search results flip upward when the viewport is tight below", () => {
  const placement = choosePlacement({ top: 650, bottom: 690 }, 280, 800);
  assert.deepEqual(placement, { upward: true, maxHeight: 280 });
});

test("WootenLink search results remain scrollable in the roomiest available direction", () => {
  assert.deepEqual(
    choosePlacement({ top: 140, bottom: 180 }, 250, 300),
    { upward: true, maxHeight: 126 },
  );
  assert.deepEqual(
    choosePlacement({ top: 20, bottom: 60 }, 220, 280),
    { upward: false, maxHeight: 126 },
  );
});

test("WootenLink results are absolutely overlaid and default to opening downward", () => {
  const base = stylesheet.match(/\.ghrc-wooten-link-results \{([^}]+)\}/)?.[1];
  const upward = stylesheet.match(/\.ghrc-wooten-link-results\.ghrc-open-upward \{([^}]+)\}/)?.[1];
  assert.ok(base && upward);
  assert.match(base, /top: calc\(100% \+ 6px\)/);
  assert.match(base, /position: absolute/);
  assert.match(base, /z-index: 4/);
  assert.doesNotMatch(base, /bottom:/);
  assert.match(upward, /bottom: calc\(100% \+ 6px\)/);
  assert.match(upward, /top: auto/);
});
