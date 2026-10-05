(() => {
  const SIZE = 4;
  const LAUNCHER_ID = "ghrc-2048-launcher";
  const MODAL_ID = "ghrc-2048-modal";
  const STORAGE_KEY = "show2048Launcher";

  function emptyBoard() {
    return Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
  }

  function cloneBoard(board) {
    return board.map((row) => [...row]);
  }

  function sameBoard(first, second) {
    return first.every((row, rowIndex) => (
      row.every((value, columnIndex) => value === second[rowIndex][columnIndex])
    ));
  }

  function availableCells(board) {
    const cells = [];
    board.forEach((row, rowIndex) => {
      row.forEach((value, columnIndex) => {
        if (value === 0) cells.push([rowIndex, columnIndex]);
      });
    });
    return cells;
  }

  function addRandomTile(board, random = Math.random) {
    const open = availableCells(board);
    if (!open.length) return false;
    const [row, column] = open[Math.floor(random() * open.length)];
    board[row][column] = random() < 0.9 ? 2 : 4;
    return true;
  }

  function collapseLine(line) {
    const values = line.filter(Boolean);
    const collapsed = [];
    let score = 0;

    for (let index = 0; index < values.length; index += 1) {
      if (values[index] === values[index + 1]) {
        const merged = values[index] * 2;
        collapsed.push(merged);
        score += merged;
        index += 1;
      } else {
        collapsed.push(values[index]);
      }
    }

    while (collapsed.length < SIZE) collapsed.push(0);
    return { line: collapsed, score };
  }

  function moveBoard(board, direction) {
    const next = emptyBoard();
    let gainedScore = 0;

    for (let index = 0; index < SIZE; index += 1) {
      const source = direction === "left" || direction === "right"
        ? [...board[index]]
        : board.map((row) => row[index]);

      if (direction === "right" || direction === "down") source.reverse();
      const collapsed = collapseLine(source);
      let output = collapsed.line;
      gainedScore += collapsed.score;
      if (direction === "right" || direction === "down") output = [...output].reverse();

      output.forEach((value, lineIndex) => {
        if (direction === "left" || direction === "right") {
          next[index][lineIndex] = value;
        } else {
          next[lineIndex][index] = value;
        }
      });
    }

    return {
      board: next,
      score: gainedScore,
      moved: !sameBoard(board, next),
    };
  }

  function canMove(board) {
    if (availableCells(board).length) return true;

    for (let row = 0; row < SIZE; row += 1) {
      for (let column = 0; column < SIZE; column += 1) {
        if (column + 1 < SIZE && board[row][column] === board[row][column + 1]) {
          return true;
        }
        if (row + 1 < SIZE && board[row][column] === board[row + 1][column]) {
          return true;
        }
      }
    }
    return false;
  }

  function newGame(random = Math.random) {
    const board = emptyBoard();
    addRandomTile(board, random);
    addRandomTile(board, random);
    return { board, score: 0, history: [] };
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      SIZE,
      emptyBoard,
      cloneBoard,
      sameBoard,
      availableCells,
      addRandomTile,
      collapseLine,
      moveBoard,
      canMove,
      newGame,
    };
    return;
  }

  function tileIcon() {
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    icon.classList.add("ghrc-2048-launcher-icon");

    const dpad = document.createElementNS("http://www.w3.org/2000/svg", "path");
    dpad.setAttribute("d", "M8 2.5h8V8h5.5v8H16v5.5H8V16H2.5V8H8z");
    dpad.classList.add("ghrc-2048-button-mash-mark");

    const center = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    center.setAttribute("cx", "12");
    center.setAttribute("cy", "12");
    center.setAttribute("r", "2.6");
    center.classList.add("ghrc-2048-button-mash-center");

    icon.append(dpad, center);
    return icon;
  }

  function createLauncher() {
    const button = document.createElement("button");
    button.id = LAUNCHER_ID;
    button.type = "button";
    button.className = "ghrc-2048-launcher";
    button.setAttribute("aria-label", "Play 2048");
    button.title = "Play 2048";
    button.append(tileIcon());
    button.addEventListener("click", openGame);
    return button;
  }

  function jamJarIcon() {
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    icon.classList.add("ghrc-2048-jam-jar");
    icon.innerHTML = `
      <path d="M7 6v3l-2 3v7a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-7l-2-3V6Z" fill="#b83e78" stroke="#f2a6cb" stroke-width="1.3"/>
      <rect x="6" y="2" width="12" height="5" rx="1.5" fill="#bda1e7" stroke="#e2d4f8" stroke-width="1.3"/>
      <path d="M9 3.5v2M12 3.5v2M15 3.5v2" stroke="#8060ae" stroke-width="1"/>
      <rect x="7" y="12" width="10" height="7" rx="1.5" fill="#fff0d8"/>
      <path d="M12 17.5c-4-2.3-2-5.3 0-3.4 2-1.9 4 1.1 0 3.4Z" fill="#b83e78"/>
      <path d="M7 10.5v8" stroke="#ffd2e7" stroke-linecap="round" opacity=".6"/>
    `;
    return icon;
  }

  let launcherEnabled = !globalThis.chrome?.storage?.local;

  function removeLauncher() {
    const launcher = document.getElementById(LAUNCHER_ID);
    const left = launcher?.closest(".ghrc-2048-footer-left");
    launcher?.remove();
    if (left && !left.childElementCount) left.remove();
  }

  function installLauncher() {
    if (!launcherEnabled) {
      removeLauncher();
      return;
    }

    const footer = document.querySelector(
      "#github-repositories-for-chatgpt .ghrc-dashboard-footer",
    );
    if (!footer || footer.querySelector(`#${LAUNCHER_ID}`)) return;

    let left = footer.querySelector(".ghrc-2048-footer-left");
    if (!left) {
      left = document.createElement("div");
      left.className = "ghrc-2048-footer-left";
      footer.prepend(left);
    }
    left.prepend(createLauncher());
  }

  function setLauncherEnabled(enabled) {
    launcherEnabled = Boolean(enabled);
    installLauncher();
  }

  function tileClass(value) {
    return value <= 2048 ? `ghrc-2048-tile-${value}` : "ghrc-2048-tile-super";
  }

  function openGame() {
    if (document.getElementById(MODAL_ID)) return;

    let game = newGame();
    const overlay = document.createElement("div");
    overlay.id = MODAL_ID;
    overlay.className = "ghrc-2048-overlay";
    overlay.setAttribute("role", "presentation");

    const dialog = document.createElement("section");
    dialog.className = "ghrc-2048-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "2048");

    const close = document.createElement("button");
    close.type = "button";
    close.className = "ghrc-2048-close";
    close.setAttribute("aria-label", "Close 2048");
    close.title = "Close 2048";
    close.append(jamJarIcon());

    const controls = document.createElement("div");
    controls.className = "ghrc-2048-controls";

    const score = document.createElement("div");
    score.className = "ghrc-2048-score";
    const scoreLabel = document.createElement("span");
    scoreLabel.textContent = "Score";
    const scoreValue = document.createElement("strong");
    score.append(scoreLabel, scoreValue);

    const actions = document.createElement("div");
    actions.className = "ghrc-2048-actions";
    const undo = document.createElement("button");
    undo.type = "button";
    undo.textContent = "Undo";
    undo.title = "Undo as many moves as this session has";
    const restart = document.createElement("button");
    restart.type = "button";
    restart.textContent = "New";
    actions.append(undo, restart, close);
    controls.append(score, actions);

    const boardElement = document.createElement("div");
    boardElement.className = "ghrc-2048-board";
    boardElement.setAttribute("aria-label", "2048 board");

    const tiles = Array.from({ length: SIZE * SIZE }, () => {
      const tile = document.createElement("div");
      tile.className = "ghrc-2048-tile ghrc-2048-tile-empty";
      tile.setAttribute("aria-label", "Empty");
      return tile;
    });
    boardElement.append(...tiles);

    const status = document.createElement("p");
    status.className = "ghrc-2048-status";
    status.setAttribute("aria-live", "polite");

    dialog.append(controls, boardElement, status);
    overlay.append(dialog);
    document.body.append(overlay);

    const render = () => {
      game.board.flat().forEach((value, index) => {
        const tile = tiles[index];
        tile.className = value
          ? `ghrc-2048-tile ${tileClass(value)}`
          : "ghrc-2048-tile ghrc-2048-tile-empty";
        tile.textContent = value || "";
        tile.setAttribute("aria-label", value ? String(value) : "Empty");
      });

      scoreValue.textContent = game.score.toLocaleString();
      undo.disabled = game.history.length === 0;
      status.textContent = canMove(game.board) ? "" : "No moves left";
    };

    const move = (direction) => {
      const result = moveBoard(game.board, direction);
      if (!result.moved) {
        render();
        return;
      }

      game.history.push({
        board: cloneBoard(game.board),
        score: game.score,
      });
      game.board = result.board;
      game.score += result.score;
      addRandomTile(game.board);
      render();
    };

    const undoMove = () => {
      const previous = game.history.pop();
      if (!previous) return;
      game.board = cloneBoard(previous.board);
      game.score = previous.score;
      render();
    };

    const reset = () => {
      game = newGame();
      render();
    };

    const keyMap = {
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "up",
      ArrowDown: "down",
      ".": "up",
      ">": "up",
      u: "right",
      U: "right",
      o: "left",
      O: "left",
      e: "down",
      E: "down",
    };

    const onKeyDown = (event) => {
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      const pressedKey = event.detail?.key || event.key;
      if (pressedKey === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        destroy();
        return;
      }

      const direction = keyMap[pressedKey];
      if (!direction) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      move(direction);
    };

    let touchStart = null;
    const onTouchStart = (event) => {
      const touch = event.changedTouches[0];
      touchStart = touch ? { x: touch.clientX, y: touch.clientY } : null;
    };
    const onTouchEnd = (event) => {
      if (!touchStart) return;
      const touch = event.changedTouches[0];
      if (!touch) return;
      const deltaX = touch.clientX - touchStart.x;
      const deltaY = touch.clientY - touchStart.y;
      touchStart = null;
      if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < 24) return;
      if (Math.abs(deltaX) > Math.abs(deltaY)) {
        move(deltaX > 0 ? "right" : "left");
      } else {
        move(deltaY > 0 ? "down" : "up");
      }
    };

    const restoreGameFocus = () => {
      if (!overlay.isConnected || document.visibilityState === "hidden") return;
      if (!dialog.contains(document.activeElement)) close.focus({ preventScroll: true });
    };
    const onWindowBlur = () => {
      // Focusing an iframe also blurs the parent window and redirects its keys.
      requestAnimationFrame(() => {
        if (document.hasFocus()) restoreGameFocus();
      });
    };

    function destroy() {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("focus", restoreGameFocus);
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("visibilitychange", restoreGameFocus);
      document.removeEventListener("focusin", restoreGameFocus, true);
      document.removeEventListener("ghrc:2048-key", onKeyDown);
      boardElement.removeEventListener("touchstart", onTouchStart);
      boardElement.removeEventListener("touchend", onTouchEnd);
      overlay.remove();
    }

    close.addEventListener("click", destroy);
    overlay.addEventListener("pointerdown", (event) => {
      if (event.target === overlay) destroy();
    });
    undo.addEventListener("click", undoMove);
    restart.addEventListener("click", reset);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("focus", restoreGameFocus);
    window.addEventListener("blur", onWindowBlur);
    document.addEventListener("visibilitychange", restoreGameFocus);
    document.addEventListener("focusin", restoreGameFocus, true);
    document.addEventListener("ghrc:2048-key", onKeyDown);
    boardElement.addEventListener("touchstart", onTouchStart, { passive: true });
    boardElement.addEventListener("touchend", onTouchEnd, { passive: true });

    render();
    close.focus();
  }

  const observer = new MutationObserver(installLauncher);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  const storage = globalThis.chrome?.storage?.local;
  if (storage) {
    storage.get({ [STORAGE_KEY]: false }).then((settings) => {
      setLauncherEnabled(settings[STORAGE_KEY]);
    });
    globalThis.chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || !changes[STORAGE_KEY]) return;
      setLauncherEnabled(changes[STORAGE_KEY].newValue);
    });
  } else {
    installLauncher();
  }
})();
