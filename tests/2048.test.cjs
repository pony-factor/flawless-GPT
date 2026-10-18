const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  collapseLine,
  moveBoard,
  canMove,
  cloneBoard,
} = require('../js/games/2048.js');

test('merges each pair only once per move', () => {
  assert.deepEqual(collapseLine([2, 2, 2, 2]), {
    line: [4, 4, 0, 0],
    score: 8,
  });
  assert.deepEqual(collapseLine([4, 4, 8, 8]), {
    line: [8, 16, 0, 0],
    score: 24,
  });
});

test('supports movement in all four directions', () => {
  const board = [
    [2, 0, 2, 0],
    [0, 0, 0, 0],
    [4, 0, 4, 0],
    [0, 0, 0, 0],
  ];
  assert.deepEqual(moveBoard(board, 'left').board, [
    [4, 0, 0, 0],
    [0, 0, 0, 0],
    [8, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  assert.deepEqual(moveBoard(board, 'right').board, [
    [0, 0, 0, 4],
    [0, 0, 0, 0],
    [0, 0, 0, 8],
    [0, 0, 0, 0],
  ]);
  assert.equal(moveBoard(board, 'up').moved, true);
  assert.equal(moveBoard(board, 'down').moved, true);
});

test('2048 is not treated as a terminal state', () => {
  const board = [
    [2048, 0, 0, 0],
    [2, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  assert.equal(canMove(board), true);
  assert.equal(moveBoard(board, 'right').moved, true);
});

test('only a genuinely blocked board is game over', () => {
  assert.equal(canMove([
    [2, 4, 2, 4],
    [4, 2, 4, 2],
    [2, 4, 2, 4],
    [4, 2, 4, 2],
  ]), false);
  assert.equal(canMove([
    [2, 4, 2, 4],
    [4, 4, 8, 2],
    [2, 8, 2, 4],
    [4, 2, 4, 2],
  ]), true);
});

test('snapshots remain independent for unlimited undo history', () => {
  const original = [[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const history = [];
  for (let index = 0; index < 200; index += 1) history.push(cloneBoard(original));
  original[0][0] = 4;
  assert.equal(history.length, 200);
  assert.equal(history[0][0][0], 2);
  assert.equal(history[199][0][0], 2);
});


test('2048 keeps its board geometry stable while rendering moves', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'js', '2048.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'css', '2048.css'), 'utf8');

  assert.doesNotMatch(source, /boardElement\.replaceChildren\(\)/);
  assert.match(source, /const tiles = Array\.from\(\{ length: SIZE \* SIZE \}/);
  assert.match(styles, /\.ghrc-2048-board \{[\s\S]*?aspect-ratio: 1;/);
  assert.match(styles, /grid-template-rows: repeat\(4, minmax\(0, 1fr\)\);/);
});

test('2048 captures game keys before the ChatGPT page can react', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'js', '2048.js'), 'utf8');

  assert.match(source, /window\.addEventListener\("keydown", onKeyDown, true\);/);
  assert.match(source, /event\.stopImmediatePropagation\(\);/);
});

test('2048 launcher keeps Button Mash icon and uses Windsor Flight palette', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'js', '2048.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'css', '2048.css'), 'utf8');

  assert.match(source, /ghrc-2048-button-mash-mark/);
  assert.match(source, /M8 2\.5h8V8h5\.5v8H16v5\.5H8V16H2\.5V8H8z/);
  assert.match(styles, /\.ghrc-2048-tile-empty \{\s*background: #C9CBCF;/);
  assert.match(styles, /\.ghrc-2048-tile-2 \{\s*background: #F6E0EA;/);
  assert.match(styles, /\.ghrc-2048-tile-4 \{\s*background: #7F7BD7;/);
  assert.match(styles, /\.ghrc-2048-tile-2048 \{\s*background: #C188E7;/);
});

test('all 23 Windsor Flight colors are used for empty and numbered tiles', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'css', '2048.css'), 'utf8');
  const colors = [
    ["empty", "#C9CBCF"],
    ["2", "#F6E0EA"],
    ["4", "#7F7BD7"],
    ["8", "#F4A081"],
    ["16", "#DC72C4"],
    ["32", "#F8E96F"],
    ["64", "#9F5EC1"],
    ["128", "#A3EAD7"],
    ["256", "#D969C1"],
    ["512", "#7599E4"],
    ["1024", "#F9BD6D"],
    ["2048", "#C188E7"],
    ["4096", "#6F6BCB"],
    ["8192", "#E0886D"],
    ["16384", "#F4C3EC"],
    ["32768", "#F2AE67"],
    ["65536", "#9F737C"],
    ["131072", "#D0D4D7"],
    ["262144", "#BFC3C6"],
    ["524288", "#EC729A"],
    ["1048576", "#64625F"],
    ["2097152", "#453940"],
    ["4194304", "#FFFFFF"],
  ];
  assert.equal(colors.length, 23);
  assert.equal(new Set(colors.map(([, color]) => color)).size, 23);
  for (const [value, color] of colors) {
    assert.match(styles, new RegExp(`\\.ghrc-2048-tile-${value} \\{\\s*background: ${color};`, 'i'));
  }
});

test('higher-than-2048 tile classes remain colored without limiting the game', () => {
  const { tileClass } = require('../js/games/2048.js');
  for (const value of [2048, 4096, 8192, 16384, 131072, 4194304]) {
    assert.equal(tileClass(value), `ghrc-2048-tile-${value}`);
  }
  assert.equal(tileClass(8388608), 'ghrc-2048-tile-4096');
  assert.equal(tileClass(16777216), 'ghrc-2048-tile-8192');
  assert.equal(tileClass(3), 'ghrc-2048-tile-super');
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'js', '2048.js'), 'utf8');
  assert.match(source, /value >= 1000000 \? "micro"/);
  assert.match(source, /value >= 10000 \? "tiny"/);
});


test('2048 launcher is disabled by default and controlled by the display preference', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'js', '2048.js'), 'utf8');
  const options = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  const settings = fs.readFileSync(path.join(__dirname, '..', 'js', 'options.js'), 'utf8');

  assert.match(options, /id="show-2048-launcher" type="checkbox"/);
  assert.doesNotMatch(options, /id="show-2048-launcher"[^>]*checked/);
  assert.match(settings, /show2048Launcher: false/);
  assert.match(settings, /show2048Launcher: show2048LauncherInput\.checked/);
  assert.match(source, /const STORAGE_KEY = "show2048Launcher";/);
  assert.match(source, /storage\.get\(\{ \[STORAGE_KEY\]: false \}\)/);
  assert.match(source, /chrome\.storage\.onChanged\.addListener/);
});
