const { test } = require("node:test");
const assert = require("node:assert/strict");
const { version, newest, desired, matches, effort, sliderDirection } = require("../js/chat/force-high-thinking.js");

test("newest enabled numbered GPT version is ordered by components, not decimals", () => {
  const choices = ["6", "6.2 High", "GPT-6.10", "7", "GPT-5.6 Sol"].map((name, index) => ({
    name, version: version(name), enabled: index !== 3,
  }));
  assert.equal(newest(choices).name, "GPT-6.10");
  assert.equal(matches(version("GPT-6.10 High"), version("6.10")), true);
  assert.equal(matches(version("6.1"), version("6.10")), false);
  assert.equal(version("GPT-5.6 Sol"), null);
});
test("High is exact and never falls through to Extra High", () => {
  const choices = ["Medium", "High", "Extra High"].map(name => ({ name, effort: effort(name), enabled: true }));
  assert.equal(desired(choices, "high").name, "High");
  assert.equal(desired(choices, "extra high").name, "Extra High");
  assert.equal(desired(choices.filter(option => option.name !== "High"), "high"), null);
  assert.equal(desired([{ ...choices[2], enabled: false }], "extra high"), null);
});
test("slider moves toward the explicit target instead of its maximum", () => {
  assert.equal(sliderDirection("high", "high"), 0);
  assert.equal(sliderDirection("extra high", "high"), -1);
  assert.equal(sliderDirection("high", "extra high"), 1);
  assert.equal(sliderDirection("unknown", "high"), 0);
  assert.equal(effort("6.2 Extra High"), "extra high");
});
