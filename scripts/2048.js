// ═══════════════════════════════════════════════════════════════
// Pure board-array engine. The board is the single source of
// truth. Rendering is a full rebuild from the board every time.
// No tile-object tracking — that was the source of all bugs.
// ═══════════════════════════════════════════════════════════════

const SIZE = 4;
const MAX_UNDOS = 5;
const GAP = 8; // px, must match CSS gap

let board = [];
let score = 0;
let moves = 0;
let undosLeft = MAX_UNDOS;
let history = []; // stack of {board, score, moves, undosLeft}
let won = false;
let keepGoing = false;
let gameOver = false;
let moveToken = 0; // incremented each move; lets pending timeouts detect staleness
let highScore = parseInt(localStorage.getItem("2048_best") || "0");

// ─── HELPERS ─────────────────────────────────────────────────
const clone = (b) => b.map((r) => [...r]);

function emptyBoard() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
}

// ─── SPAWN ───────────────────────────────────────────────────
// Returns {r,c} of the new tile, or null if board is full.
function spawnRandom() {
  const cells = [];
  for (let r = 0; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++) if (board[r][c] === 0) cells.push([r, c]);
  if (!cells.length) return null;
  const [r, c] = cells[Math.floor(Math.random() * cells.length)];
  board[r][c] = Math.random() < 0.9 ? 2 : 4;
  return { r, c };
}

// ─── SLIDE ONE LINE ──────────────────────────────────────────
// Takes an array of 4 values, slides+merges toward index 0.
// Returns { line, scoreGained, moved }.
function slideLine(orig) {
  // compact non-zeros
  let vals = orig.filter((v) => v !== 0);
  let gained = 0;
  let merged = false;

  for (let i = 0; i < vals.length - 1; i++) {
    if (vals[i] === vals[i + 1]) {
      vals[i] *= 2;
      gained += vals[i];
      vals[i + 1] = 0;
      i++; // skip the consumed tile
    }
  }

  // compact again after merges
  vals = vals.filter((v) => v !== 0);
  while (vals.length < SIZE) vals.push(0);

  const changed = vals.some((v, i) => v !== orig[i]);
  return { line: vals, scoreGained: gained, moved: changed };
}

// ─── MOVE ────────────────────────────────────────────────────
function move(dir) {
  if (gameOver) return;

  // Snapshot for undo BEFORE we touch anything
  const snap = { board: clone(board), score, moves, undosLeft };

  let totalScore = 0;
  let anyMoved = false;
  const newBoard = emptyBoard();

  // For each of the 4 lines in this direction:
  for (let idx = 0; idx < SIZE; idx++) {
    // Extract line in slide order (always sliding toward index 0)
    let line = [];
    if (dir === "left") for (let c = 0; c < SIZE; c++) line.push(board[idx][c]);
    if (dir === "right")
      for (let c = SIZE - 1; c >= 0; c--) line.push(board[idx][c]);
    if (dir === "up") for (let r = 0; r < SIZE; r++) line.push(board[r][idx]);
    if (dir === "down")
      for (let r = SIZE - 1; r >= 0; r--) line.push(board[r][idx]);

    const { line: result, scoreGained, moved } = slideLine(line);
    if (moved) anyMoved = true;
    totalScore += scoreGained;

    // Write result back in the same coordinate order
    for (let i = 0; i < SIZE; i++) {
      if (dir === "left") newBoard[idx][i] = result[i];
      if (dir === "right") newBoard[idx][SIZE - 1 - i] = result[i];
      if (dir === "up") newBoard[i][idx] = result[i];
      if (dir === "down") newBoard[SIZE - 1 - i][idx] = result[i];
    }
  }

  if (!anyMoved) return; // nothing happened, don't record history

  // Commit
  history.push(snap);
  board = newBoard;
  score += totalScore;
  moves++;
  if (score > highScore) {
    highScore = score;
    localStorage.setItem("2048_best", highScore);
  }

  // Capture token so a stale timeout from a superseded move
  // doesn't spawn an extra tile after the board has already advanced.
  const token = ++moveToken;

  // Render the slid board immediately so tiles animate to new positions,
  // then spawn a new tile after the CSS transition (~100 ms) completes.
  render(null);
  updateUI();

  setTimeout(() => {
    if (token !== moveToken) return; // superseded by a later move
    const spawned = spawnRandom();
    render(spawned);
    updateUI();
    checkState();
  }, 100);
}

// ─── UNDO ────────────────────────────────────────────────────
function undo() {
  if (!history.length || undosLeft <= 0) return;
  const prev = history.pop();
  board = prev.board;
  score = prev.score;
  moves = prev.moves;
  undosLeft = prev.undosLeft - 1;
  gameOver = false;
  hideOverlays();
  render(null);
  updateUI();
}

// ─── NEW GAME ────────────────────────────────────────────────
function newGame() {
  board = emptyBoard();
  score = 0;
  moves = 0;
  undosLeft = MAX_UNDOS;
  history = [];
  won = false;
  keepGoing = false;
  gameOver = false;
  moveToken = 0;
  hideOverlays();
  renderSlots();
  spawnRandom();
  spawnRandom();
  render(null);
  updateUI();
  setStatus("In progress");
}

// ─── GAME STATE ──────────────────────────────────────────────
function checkState() {
  if (!won && !keepGoing) {
    for (let r = 0; r < SIZE; r++)
      for (let c = 0; c < SIZE; c++)
        if (board[r][c] === 2048) {
          won = true;
          showWin();
          return;
        }
  }
  if (!canMove()) {
    gameOver = true;
    setTimeout(showOver, 300);
  }
}

function canMove() {
  for (let r = 0; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c] === 0) return true;
      if (c < SIZE - 1 && board[r][c] === board[r][c + 1]) return true;
      if (r < SIZE - 1 && board[r][c] === board[r + 1][c]) return true;
    }
  return false;
}

// ─── RENDER ──────────────────────────────────────────────────
// Full teardown + rebuild of tile layer every frame.
// `newCell` = {r,c} of tile to animate as "new", or null.
function render(newCell) {
  const layer = document.getElementById("tile-layer");
  layer.innerHTML = "";

  const boardEl = document.getElementById("game-board");
  const inner = boardEl.clientWidth - GAP * 2; // subtract padding
  const ts = (inner - GAP * (SIZE - 1)) / SIZE;

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const val = board[r][c];
      if (!val) continue;

      const el = document.createElement("div");
      el.className = "tile";
      el.dataset.value = val;
      el.textContent = val;
      el.style.width = ts + "px";
      el.style.height = ts + "px";
      el.style.left = c * (ts + GAP) + "px";
      el.style.top = r * (ts + GAP) + "px";

      if (newCell && newCell.r === r && newCell.c === c) {
        el.classList.add("new");
      }

      layer.appendChild(el);
    }
  }
}

// ─── GRID SLOTS ──────────────────────────────────────────────
function renderSlots() {
  const gb = document.getElementById("game-board");
  gb.innerHTML = "";
  for (let i = 0; i < SIZE * SIZE; i++) {
    const slot = document.createElement("div");
    slot.className = "cell-slot";
    gb.appendChild(slot);
  }
}

// ─── UI UPDATES ──────────────────────────────────────────────
function highestTile() {
  let max = 0;
  for (let r = 0; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++) if (board[r][c] > max) max = board[r][c];
  return max || null;
}

function filledCount() {
  let n = 0;
  for (let r = 0; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++) if (board[r][c]) n++;
  return n;
}

function updateUI() {
  const ht = highestTile();
  const htStr = ht ? ht.toLocaleString() : "—";
  const best = Math.max(score, highScore);

  document.getElementById("score-display").textContent = score.toLocaleString();
  document.getElementById("best-display").textContent = best.toLocaleString();
  document.getElementById("moves-display").textContent = moves;

  document.getElementById("highest-display").textContent = htStr;
  document.getElementById("undo-display").textContent = undosLeft;
  document.getElementById("tiles-display").textContent = filledCount();

  document.getElementById("left-score").textContent = score.toLocaleString();
  document.getElementById("left-best").textContent = best.toLocaleString();
  document.getElementById("left-moves").textContent = moves;
  document.getElementById("left-highest").textContent = htStr;

  document.getElementById("undo-btn").disabled =
    !history.length || undosLeft <= 0;
}

function setStatus(text, cls = "") {
  const el = document.getElementById("board-status");
  el.textContent = text;
  el.className = "board-status" + (cls ? " " + cls : "");
}

function showWin() {
  document.getElementById("win-score").textContent = score.toLocaleString();
  setTimeout(
    () => document.getElementById("win-overlay").classList.add("show"),
    300,
  );
  setStatus("2048 — You won!", "win");
}
function showOver() {
  document.getElementById("over-score").textContent = score.toLocaleString();
  document.getElementById("over-overlay").classList.add("show");
  setStatus("Game over", "over");
}
function hideOverlays() {
  document.getElementById("win-overlay").classList.remove("show");
  document.getElementById("over-overlay").classList.remove("show");
}

// ─── LEGEND ──────────────────────────────────────────────────
const LEGEND_VALUES = [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096];
function buildLegend() {
  const grid = document.getElementById("legend-grid");
  grid.innerHTML = "";
  LEGEND_VALUES.forEach((v) => {
    const item = document.createElement("div");
    item.className = "legend-item";
    const swatch = document.createElement("div");
    swatch.className = "legend-swatch tile";
    swatch.dataset.value = v;
    swatch.textContent = v;
    swatch.style.cssText =
      "position:static;width:28px;height:28px;font-size:0.6rem;transition:none;";
    const label = document.createElement("span");
    label.className = "legend-val";
    label.textContent = v.toLocaleString();
    item.appendChild(swatch);
    item.appendChild(label);
    grid.appendChild(item);
  });
}

// ─── COLLAPSIBLE RULES ───────────────────────────────────────
document.getElementById("rules-toggle").addEventListener("click", () => {
  document.getElementById("rules-card").classList.toggle("open");
});

// ─── BUTTONS ─────────────────────────────────────────────────
document.getElementById("new-game-btn").addEventListener("click", newGame);
document.getElementById("undo-btn").addEventListener("click", undo);
document.getElementById("win-new-btn").addEventListener("click", newGame);
document.getElementById("over-new-btn").addEventListener("click", newGame);
document.getElementById("keep-going-btn").addEventListener("click", () => {
  keepGoing = true;
  hideOverlays();
  setStatus("In progress");
});

// ─── KEYBOARD ────────────────────────────────────────────────
const KEY_MAP = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  w: "up",
  s: "down",
  a: "left",
  d: "right",
  W: "up",
  S: "down",
  A: "left",
  D: "right",
};
document.addEventListener("keydown", (e) => {
  const dir = KEY_MAP[e.key];
  if (dir) {
    e.preventDefault();
    move(dir);
  }
});

// ─── SWIPE ───────────────────────────────────────────────────
let touchStart = null;
const boardEl = document.getElementById("game-board");
boardEl.addEventListener(
  "touchstart",
  (e) => {
    touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  },
  { passive: true },
);
boardEl.addEventListener(
  "touchend",
  (e) => {
    if (!touchStart) return;
    const dx = e.changedTouches[0].clientX - touchStart.x;
    const dy = e.changedTouches[0].clientY - touchStart.y;
    touchStart = null;
    if (Math.abs(dx) < 20 && Math.abs(dy) < 20) return;
    move(
      Math.abs(dx) > Math.abs(dy)
        ? dx > 0
          ? "right"
          : "left"
        : dy > 0
          ? "down"
          : "up",
    );
  },
  { passive: true },
);

// ─── RESIZE ──────────────────────────────────────────────────
window.addEventListener("resize", () => render(null));

// ─── INIT ────────────────────────────────────────────────────
buildLegend();
newGame();
