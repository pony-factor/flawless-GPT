const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  collapseLine,
  moveBoard,
  canMove,
  cloneBoard,
} = require('../js/2048.js');

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

test('2048 launcher uses Button Mash D-pad styling and a darker tile palette', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'js', '2048.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'css', '2048.css'), 'utf8');

  assert.match(source, /ghrc-2048-button-mash-mark/);
  assert.match(source, /M8 2\.5h8V8h5\.5v8H16v5\.5H8V16H2\.5V8H8z/);
  assert.match(styles, /\.ghrc-2048-tile-empty \{\s*background: #303844;/);
  assert.match(styles, /\.ghrc-2048-tile-2 \{\s*background: #34404a;/);
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
