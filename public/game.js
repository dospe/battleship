const socket = io();

// ── Konstanty ────────────────────────────────────────────────────────────────
// `acc` = 4. pád pro „Potopil jsi …“, `mine` = 4. pád s přivlastněním pro
// „Soupeř potopil …“ (rod lodi určuje tvar zájmena).
const SHIPS = [
  { id: 1, name: 'Letadlová loď', acc: 'letadlovou loď', mine: 'tvou letadlovou loď', size: 5 },
  { id: 2, name: 'Bitevní loď',   acc: 'bitevní loď',    mine: 'tvou bitevní loď',    size: 4 },
  { id: 3, name: 'Křižník',       acc: 'křižník',        mine: 'tvůj křižník',        size: 3 },
  { id: 4, name: 'Ponorka',       acc: 'ponorku',        mine: 'tvou ponorku',        size: 3 },
  { id: 5, name: 'Torpédoborec',  acc: 'torpédoborec',   mine: 'tvůj torpédoborec',   size: 2 },
];
const COLS = 'ABCDEFGHIJ';
const DOUBLE_TAP_MS = 350;
const THEME_KEY = 'lodeTheme';
let lastShipTap = { shipId: null, at: 0 };

const TXT = {
  yourTurn: 'Tvůj tah',
  oppTurn: 'Soupeř na tahu',
  victory: 'VÍTĚZSTVÍ!',
  defeat: 'PORÁŽKA',
  wonSub: 'Potopil jsi všechny nepřátelské lodě!',
  lostSub: 'Tvoje flotila byla zničena.',
  copied: 'Zkopírováno!',
  copyCode: 'Kopírovat kód',
  copyLink: 'Kopírovat odkaz',
  joiningRoom: 'Připojuji se do místnosti {code}…',
  waitingJoin: 'Pošli kód nebo odkaz soupeři a počkej, až se připojí…',
  oppReady: 'Soupeř je připraven!',
  oppDisconnected: 'Soupeř se odpojil.',
  youSunkTheir: 'Potopil jsi {ship}!',
  theySunkYour: 'Soupeř potopil {ship}!',
  youHit: 'Zásah {cell}',
  youMissed: 'Minul jsi {cell}',
  oppHit: 'Soupeř zasáhl {cell}',
  oppMissed: 'Soupeř minul {cell}',
  readyHint: 'Nejdřív rozmísti všechny lodě',
};
const T = (k, p) => {
  let s = TXT[k] || k;
  if (p) for (const n in p) s = s.split('{' + n + '}').join(p[n]);
  return s;
};
const cellName = (r, c) => COLS[c] + (r + 1);
const cellsLabel = (n) => n >= 5 ? `${n} polí` : `${n} pole`;

// Cache of cell elements per board id, populated by buildBoard(), so getCell()
// is an O(1) array lookup instead of a DOM query. Boards are rebuilt (not just
// re-rendered) on every placement/game init, so the cache is always refreshed
// before any render that reads from it.
const boardCellCache = {};

// Cells currently showing a ship-placement preview highlight, tracked directly
// so clearPreview() can reset just those elements instead of re-querying the
// DOM for '.ship-preview, .ship-invalid' on every mouseenter (fires up to 100x
// per pass over the placement board).
let previewCells = [];

// ── Stav ─────────────────────────────────────────────────────────────────────
let state = {
  mode: null,          // 'single' | 'multi'
  difficulty: 'medium',
  roomCode: null,
  myBoard: null,       // 10x10, cell = 0|shipId (pracovní; při hře proti AI se zásahy nulují)
  myLayout: null,      // 10x10, nedotčená kopie rozmístění pro vykreslení potopených lodí
  oppHits: null,       // 10x10 false|'hit'|'miss'|'sunk' — moje výstřely na soupeřovu desku
  myHits: null,        // 10x10 false|'hit'|'miss' — soupeřovy výstřely na moji desku
  myTurn: false,
  sunk: { my: new Set(), opp: new Set() },
  gameOver: false,

  // rozmístění
  placedShips: new Set(),
  selectedShip: null,
  horizontal: true,
  hoverCell: null,

  // AI
  aiBoard: null,
  aiLayout: null,
  aiHits: null,
  aiQueue: [],
  aiLastHit: null,
  aiDirection: null,
  aiShipCounts: {},
  aiProbGrid: null,
};

// ── Vzhled (tmavý / světlý) ───────────────────────────────────────────────────
// Výchozí režim nastavuje inline skript v <head> (uložená volba, jinak systém).
function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
  const meta = document.getElementById('theme-color');
  if (meta) meta.content = theme === 'light' ? '#f4efe4' : '#0a1628';
  paintThemeButton();
}

function toggleTheme() {
  if (window.SFX) SFX.play('click');
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
}

// Ikona ukazuje režim, na který se přepne.
function paintThemeButton() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  const dark = currentTheme() === 'dark';
  btn.textContent = dark ? '☀️' : '🌙';
  btn.setAttribute('aria-label', dark ? 'Přepnout na světlý vzhled' : 'Přepnout na tmavý vzhled');
  btn.title = btn.getAttribute('aria-label');
}

// ── Obrazovky ─────────────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  if (id === 'screen-menu') history.replaceState(null, '', '/');
}

// ── Sdílení místnosti odkazem ─────────────────────────────────────────────────
function setRoomInUrl(code) {
  history.replaceState(null, '', `/?room=${code}`);
}

function copyLink() {
  navigator.clipboard.writeText(window.location.href);
  const btn = event.target;
  btn.textContent = T('copied');
  setTimeout(() => btn.textContent = T('copyLink'), 1500);
}

window.addEventListener('DOMContentLoaded', () => {
  paintThemeButton();

  const params = new URLSearchParams(window.location.search);
  const room = params.get('room');
  if (room) {
    showScreen('screen-mp-menu');
    document.getElementById('room-input').value = room.toUpperCase();
    document.getElementById('mp-status').textContent = T('joiningRoom', { code: room.toUpperCase() });
    socket.emit('join_room', { code: room.toUpperCase() });
  }
});

// ── Menu ──────────────────────────────────────────────────────────────────────
function startSinglePlayer() {
  state.mode = 'single';
  showScreen('screen-difficulty');
}

function setDifficulty(d) {
  state.difficulty = d;
  initPlacement();
  showScreen('screen-placement');
}

function createRoom() {
  socket.emit('create_room');
}

function joinRoom() {
  const code = document.getElementById('room-input').value.trim().toUpperCase();
  if (!code) return;
  socket.emit('join_room', { code });
}

function copyCode() {
  navigator.clipboard.writeText(state.roomCode);
  const btn = event.target;
  btn.textContent = T('copied');
  setTimeout(() => btn.textContent = T('copyCode'), 1500);
}

// ── Socket události ───────────────────────────────────────────────────────────
socket.on('room_created', ({ code }) => {
  state.roomCode = code;
  state.mode = 'multi';
  document.getElementById('room-code-text').textContent = code;
  document.getElementById('room-code-display').classList.remove('hidden');
  document.getElementById('mp-status').textContent = T('waitingJoin');
  setRoomInUrl(code);
});

socket.on('join_error', (msg) => {
  if (window.SFX) SFX.play('error');
  document.getElementById('mp-status').textContent = msg;
});

socket.on('room_joined', ({ code }) => {
  state.roomCode = code;
  state.mode = 'multi';
  initPlacement();
  showScreen('screen-placement');
});

socket.on('opponent_joined', () => {
  if (window.SFX) SFX.play('join');
  initPlacement();
  showScreen('screen-placement');
});

socket.on('opponent_ready', () => {
  const el = document.getElementById('mp-status');
  if (el) el.textContent = T('oppReady');
});

socket.on('waiting_for_opponent', () => {
  showScreen('screen-waiting');
});

socket.on('game_start', ({ firstTurn }) => {
  if (window.SFX) SFX.play('turn');
  state.myTurn = (firstTurn === socket.id || firstTurn === 'ai');
  initGame();
  showScreen('screen-game');
});

socket.on('attack_result', ({ attacker, row, col, hit, sunkShip, sunkCells, won, nextTurn }) => {
  const iMadeAttack = (attacker === socket.id);
  if (iMadeAttack) {
    state.oppHits[row][col] = hit ? 'hit' : 'miss';
    if (sunkShip) {
      updateShipStatus('opp', sunkShip);
      markSunkCells(state.oppHits, sunkCells || []);
    }
    renderOppBoard();
    logEntry(hit ? T('youHit', { cell: cellName(row, col) }) : T('youMissed', { cell: cellName(row, col) }), hit ? (sunkShip ? 'sunk' : 'hit') : 'miss');
    if (sunkShip) logEntry(T('youSunkTheir', { ship: shipAcc(sunkShip) }), 'sunk');
  } else {
    state.myHits[row][col] = hit ? 'hit' : 'miss';
    if (sunkShip) updateShipStatus('my', sunkShip);
    renderMyBoard();
    logEntry(hit ? T('oppHit', { cell: cellName(row, col) }) : T('oppMissed', { cell: cellName(row, col) }), hit ? (sunkShip ? 'sunk' : 'hit') : 'miss');
    if (sunkShip) logEntry(T('theySunkYour', { ship: shipMine(sunkShip) }), 'sunk');
  }
  if (won) {
    showResult(iMadeAttack);
  } else {
    state.myTurn = (nextTurn === socket.id);
    updateTurnDisplay();
  }
});

socket.on('opponent_disconnected', () => {
  if (!state.gameOver) alert(T('oppDisconnected'));
  showScreen('screen-menu');
});

// ── Rozmístění ────────────────────────────────────────────────────────────────
function initPlacement() {
  state.myBoard = Array.from({ length: 10 }, () => Array(10).fill(0));
  state.myLayout = null;
  state.placedShips = new Set();
  state.selectedShip = null;
  state.horizontal = true;
  lastShipTap = { shipId: null, at: 0 };
  previewCells = [];

  buildShipList();
  buildBoard('place-board', onPlaceCellClick, onPlaceCellHover, onPlaceBoardLeave);
  buildLabels('col-labels-place', 'row-labels-place');
  setReadyEnabled(false);

  document.addEventListener('keydown', handleKey);
}

function buildShipList() {
  const list = document.getElementById('ship-list');
  list.innerHTML = '';
  SHIPS.forEach(ship => {
    const el = document.createElement('div');
    el.className = 'ship-item';
    el.id = `ship-item-${ship.id}`;
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-pressed', 'false');
    el.setAttribute('aria-label', `${ship.name}, ${cellsLabel(ship.size)}`);
    el.onclick = () => selectShip(ship.id);
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectShip(ship.id);
      }
    });
    el.addEventListener('pointerup', e => handleShipPointerUp(e, ship.id));
    el.innerHTML = `
      <div class="ship-blocks">${'<div class="ship-block"></div>'.repeat(ship.size)}</div>
      <div><div class="ship-name">${ship.name}</div><div class="ship-len">${cellsLabel(ship.size)}</div></div>`;
    list.appendChild(el);
  });
}

function selectShip(id) {
  if (state.placedShips.has(id)) return;
  state.selectedShip = SHIPS.find(s => s.id === id);
  document.querySelectorAll('.ship-item').forEach(el => {
    el.classList.remove('selected');
    el.setAttribute('aria-pressed', 'false');
  });
  const el = document.getElementById(`ship-item-${id}`);
  if (el) {
    el.classList.add('selected');
    el.setAttribute('aria-pressed', 'true');
  }
  updateOrientationIndicator();
  clearPreview();
}

function markShipItemPlaced(id) {
  const el = document.getElementById(`ship-item-${id}`);
  if (!el) return;
  el.classList.add('placed');
  el.setAttribute('tabindex', '-1');
  el.setAttribute('aria-disabled', 'true');
  el.setAttribute('aria-pressed', 'false');
}

function rotateShip() {
  state.horizontal = !state.horizontal;
  updateOrientationIndicator();
  if (state.hoverCell) showPreview(...state.hoverCell);
}

function handleKey(e) {
  if ((e.key === 'r' || e.key === 'R') && !e.repeat) {
    e.preventDefault();
    rotateShip();
  }
}

function handleShipPointerUp(e, shipId) {
  if (e.pointerType !== 'touch') return;

  const now = performance.now();
  const isDoubleTap = lastShipTap.shipId === shipId && now - lastShipTap.at <= DOUBLE_TAP_MS;
  lastShipTap = isDoubleTap ? { shipId: null, at: 0 } : { shipId, at: now };
  if (!isDoubleTap) return;

  e.preventDefault();
  selectShip(shipId);
  if (state.selectedShip?.id === shipId) rotateShip();
}

function updateOrientationIndicator() {
  document.querySelectorAll('.ship-item').forEach(el => el.removeAttribute('data-orientation'));
  if (!state.selectedShip) return;
  const selected = document.getElementById(`ship-item-${state.selectedShip.id}`);
  if (selected) selected.dataset.orientation = state.horizontal ? '↔' : '↕';
}

function onPlaceCellHover(r, c) {
  state.hoverCell = [r, c];
  clearPreview();
  if (state.selectedShip) showPreview(r, c);
}

function onPlaceBoardLeave() {
  state.hoverCell = null;
  clearPreview();
}

function showPreview(r, c) {
  const ship = state.selectedShip;
  if (!ship) return;
  const cells = getShipCells(r, c, ship.size, state.horizontal);
  const valid = cells && cells.every(([rr, cc]) => state.myBoard[rr][cc] === 0);
  if (!cells) return;
  cells.forEach(([rr, cc]) => {
    const cell = getCell('place-board', rr, cc);
    cell.classList.add(valid ? 'ship-preview' : 'ship-invalid');
    previewCells.push(cell);
  });
}

function clearPreview() {
  previewCells.forEach(cell => cell.classList.remove('ship-preview', 'ship-invalid'));
  previewCells = [];
}

function onPlaceCellClick(r, c) {
  if (!state.selectedShip) return;
  const ship = state.selectedShip;
  const cells = getShipCells(r, c, ship.size, state.horizontal);
  if (!cells) return;
  if (!cells.every(([rr, cc]) => state.myBoard[rr][cc] === 0)) return;

  cells.forEach(([rr, cc]) => {
    state.myBoard[rr][cc] = ship.id;
    getCell('place-board', rr, cc).classList.add('ship');
  });
  clearPreview();
  if (window.SFX) SFX.play('place');

  state.placedShips.add(ship.id);
  markShipItemPlaced(ship.id);
  state.selectedShip = null;
  document.querySelectorAll('.ship-item').forEach(el => el.classList.remove('selected'));

  const next = SHIPS.find(s => !state.placedShips.has(s.id));
  if (next) selectShip(next.id);
  else setReadyEnabled(true);
}

function setReadyEnabled(enabled) {
  const btn = document.getElementById('ready-btn');
  btn.disabled = !enabled;
  btn.title = enabled ? '' : T('readyHint');
}

function getShipCells(r, c, size, horiz) {
  const cells = [];
  for (let i = 0; i < size; i++) {
    const rr = horiz ? r : r + i;
    const cc = horiz ? c + i : c;
    if (rr >= 10 || cc >= 10) return null;
    cells.push([rr, cc]);
  }
  return cells;
}

function randomPlacement() {
  state.myBoard = Array.from({ length: 10 }, () => Array(10).fill(0));
  state.placedShips = new Set();
  SHIPS.forEach(ship => {
    let placed = false;
    while (!placed) {
      const horiz = Math.random() < 0.5;
      const r = Math.floor(Math.random() * 10);
      const c = Math.floor(Math.random() * 10);
      const cells = getShipCells(r, c, ship.size, horiz);
      if (cells && cells.every(([rr, cc]) => state.myBoard[rr][cc] === 0)) {
        cells.forEach(([rr, cc]) => { state.myBoard[rr][cc] = ship.id; });
        state.placedShips.add(ship.id);
        placed = true;
      }
    }
    markShipItemPlaced(ship.id);
  });
  renderPlacementBoard();
  state.selectedShip = null;
  document.querySelectorAll('.ship-item').forEach(el => el.classList.remove('selected'));
  updateOrientationIndicator();
  setReadyEnabled(true);
}

function renderPlacementBoard() {
  for (let r = 0; r < 10; r++)
    for (let c = 0; c < 10; c++) {
      const cell = getCell('place-board', r, c);
      cell.className = 'cell';
      if (state.myBoard[r][c] > 0) cell.classList.add('ship');
    }
}

function confirmPlacement() {
  document.removeEventListener('keydown', handleKey);
  state.myLayout = state.myBoard.map(row => row.slice());
  if (state.mode === 'single') {
    setupAI();
    state.myTurn = true;
    initGame();
    showScreen('screen-game');
  } else {
    socket.emit('ships_placed', { code: state.roomCode, board: state.myBoard });
  }
}

// ── AI ────────────────────────────────────────────────────────────────────────
function setupAI() {
  state.aiBoard = Array.from({ length: 10 }, () => Array(10).fill(0));
  state.aiHits = Array.from({ length: 10 }, () => Array(10).fill(false));
  state.aiQueue = [];
  state.aiLastHit = null;
  state.aiDirection = null;
  state.aiShipCounts = {};

  SHIPS.forEach(ship => {
    let placed = false;
    while (!placed) {
      const horiz = Math.random() < 0.5;
      const r = Math.floor(Math.random() * 10);
      const c = Math.floor(Math.random() * 10);
      const cells = getShipCells(r, c, ship.size, horiz);
      if (cells && cells.every(([rr, cc]) => state.aiBoard[rr][cc] === 0)) {
        cells.forEach(([rr, cc]) => { state.aiBoard[rr][cc] = ship.id; });
        placed = true;
      }
    }
    state.aiShipCounts[ship.id] = ship.size;
  });
  state.aiLayout = state.aiBoard.map(row => row.slice());
}

function aiAttack() {
  setTimeout(() => {
    const [r, c] = chooseAIMove();
    state.aiHits[r][c] = true;

    const cellVal = state.myBoard[r][c];
    const hit = cellVal > 0;
    let sunkShip = null;

    if (hit) {
      state.myBoard[r][c] = 0;
      if (!state.myBoard.some(row => row.some(v => v === cellVal))) {
        sunkShip = cellVal;
        updateShipStatus('my', sunkShip);
        resetAIHuntChain();
      } else {
        enqueueAdjacentForAI(r, c);
      }
    }

    state.myHits[r][c] = hit ? 'hit' : 'miss';
    renderMyBoard();
    logEntry(hit ? T('oppHit', { cell: cellName(r, c) }) : T('oppMissed', { cell: cellName(r, c) }), hit ? (sunkShip ? 'sunk' : 'hit') : 'miss');
    if (sunkShip) logEntry(T('theySunkYour', { ship: shipMine(sunkShip) }), 'sunk');

    const won = !state.myBoard.some(row => row.some(v => v > 0));
    if (won) { showResult(false); return; }

    state.myTurn = true;
    updateTurnDisplay();
  }, 700 + Math.random() * 600);
}

function chooseAIMove() {
  const diff = state.difficulty;
  if (diff === 'easy') return randomUnattacked();
  if (diff === 'medium') return huntTarget();
  return probabilistic();
}

function randomUnattacked() {
  const avail = [];
  for (let r = 0; r < 10; r++)
    for (let c = 0; c < 10; c++)
      if (!state.aiHits[r][c]) avail.push([r, c]);
  return avail[Math.floor(Math.random() * avail.length)];
}

function huntTarget() {
  while (state.aiQueue.length) {
    const [r, c] = state.aiQueue.shift();
    if (!state.aiHits[r][c]) return [r, c];
  }
  return randomUnattacked();
}

function enqueueAdjacentForAI(r, c) {
  [[r-1,c],[r+1,c],[r,c-1],[r,c+1]].forEach(([rr, cc]) => {
    if (rr >= 0 && rr < 10 && cc >= 0 && cc < 10 && !state.aiHits[rr][cc])
      if (!state.aiQueue.some(([a,b]) => a===rr && b===cc))
        state.aiQueue.push([rr, cc]);
  });
}

function resetAIHuntChain() { state.aiQueue = []; }

function probabilistic() {
  const grid = Array.from({ length: 10 }, () => Array(10).fill(0));
  const remaining = SHIPS.filter(s => state.myBoard.some(row => row.some(v => v === s.id)));

  remaining.forEach(ship => {
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 10; c++) {
        ['h','v'].forEach(dir => {
          const cells = getShipCells(r, c, ship.size, dir === 'h');
          if (cells && cells.every(([rr, cc]) => !state.aiHits[rr][cc])) {
            cells.forEach(([rr, cc]) => grid[rr][cc]++);
          }
        });
      }
    }
  });

  let best = -1, bestCells = [];
  for (let r = 0; r < 10; r++)
    for (let c = 0; c < 10; c++)
      if (!state.aiHits[r][c]) {
        if (grid[r][c] > best) { best = grid[r][c]; bestCells = [[r,c]]; }
        else if (grid[r][c] === best) bestCells.push([r,c]);
      }
  return bestCells[Math.floor(Math.random() * bestCells.length)] || randomUnattacked();
}

// ── Začátek hry ───────────────────────────────────────────────────────────────
function initGame() {
  state.oppHits = Array.from({ length: 10 }, () => Array(10).fill(false));
  state.myHits = Array.from({ length: 10 }, () => Array(10).fill(false));
  state.sunk = { my: new Set(), opp: new Set() };
  state.gameOver = false;
  if (!state.myLayout) state.myLayout = state.myBoard.map(row => row.slice());

  buildBoard('my-board', null, null, null, true);
  buildBoard('opp-board', onOppCellClick, null, null, false);
  buildLabels('col-labels-my', 'row-labels-my');
  buildLabels('col-labels-opp', 'row-labels-opp');

  initShipStatus('my');
  initShipStatus('opp');

  renderMyBoard();
  renderOppBoard();
  updateTurnDisplay();
  document.getElementById('game-log').innerHTML = '';
}

// Stav flotily v záhlaví: jedna „lišta“ dílků na loď, potopená se přebarví.
function initShipStatus(who) {
  const el = document.getElementById(`${who}-ships`);
  el.innerHTML = '';
  SHIPS.forEach(s => {
    const bar = document.createElement('span');
    bar.className = 'ship-bar';
    bar.id = `pip-${who}-${s.id}`;
    bar.title = s.name;
    bar.innerHTML = '<i></i>'.repeat(s.size);
    el.appendChild(bar);
  });
}

function updateShipStatus(who, shipId) {
  state.sunk[who].add(shipId);
  const bar = document.getElementById(`pip-${who}-${shipId}`);
  if (bar) {
    bar.classList.add('sunk');
    bar.title = `${shipName(shipId)} – potopena`;
  }
}

function updateTurnDisplay() {
  const el = document.getElementById('turn-indicator');
  el.textContent = state.myTurn ? T('yourTurn') : T('oppTurn');
  el.classList.toggle('opponent-turn', !state.myTurn);

  // Use the cached cell elements (see boardCellCache) instead of re-querying
  // the DOM for all 100 cells and parsing their dataset every turn change.
  const cache = boardCellCache['opp-board'];
  if (!cache) return;
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      const cell = cache[r][c];
      const alreadyHit = state.oppHits[r][c] !== false;
      if (!alreadyHit && state.myTurn && !state.gameOver) {
        cell.classList.add('attackable');
        cell.classList.remove('no-hover');
      } else {
        cell.classList.remove('attackable');
        cell.classList.add('no-hover');
      }
    }
  }
}

function onOppCellClick(r, c) {
  if (!state.myTurn || state.gameOver) return;
  if (state.oppHits[r][c] !== false) return;

  if (state.mode === 'single') {
    state.myTurn = false;
    updateTurnDisplay();

    const board = state.aiBoard;
    const cellVal = board[r][c];
    const hit = cellVal > 0;
    let sunkShip = null;

    if (hit) {
      board[r][c] = 0;
      if (!board.some(row => row.some(v => v === cellVal))) sunkShip = cellVal;
    }
    state.oppHits[r][c] = hit ? 'hit' : 'miss';
    if (sunkShip) {
      updateShipStatus('opp', sunkShip);
      markSunkCells(state.oppHits, shipCells(state.aiLayout, sunkShip));
    }
    renderOppBoard();
    logEntry(hit ? T('youHit', { cell: cellName(r, c) }) : T('youMissed', { cell: cellName(r, c) }), hit ? (sunkShip ? 'sunk' : 'hit') : 'miss');
    if (sunkShip) logEntry(T('youSunkTheir', { ship: shipAcc(sunkShip) }), 'sunk');

    const won = !board.some(row => row.some(v => v > 0));
    if (won) { showResult(true); return; }

    aiAttack();
  } else {
    state.myTurn = false;
    updateTurnDisplay();
    socket.emit('attack', { code: state.roomCode, row: r, col: c });
  }
}

// ── Vykreslení ────────────────────────────────────────────────────────────────
function renderMyBoard() {
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      const cell = getCell('my-board', r, c);
      cell.className = 'cell no-hover';
      const hit = state.myHits[r][c];
      const shipId = state.myLayout[r][c];
      if (hit === 'hit') cell.classList.add(shipId > 0 && state.sunk.my.has(shipId) ? 'sunk' : 'hit');
      else if (hit === 'miss') cell.classList.add('miss');
      else if (shipId > 0) cell.classList.add('ship');
    }
  }
}

function renderOppBoard() {
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      const cell = getCell('opp-board', r, c);
      const hit = state.oppHits[r][c];
      const cls = ['cell'];
      if (hit === 'hit') cls.push('hit');
      else if (hit === 'sunk') cls.push('sunk');
      else if (hit === 'miss') cls.push('miss');
      cell.className = cls.join(' ');
      if (!hit && state.myTurn && !state.gameOver) cell.classList.add('attackable');
      else cell.classList.add('no-hover');
    }
  }
}

// Pole potopené lodi (seznam [r, c]) přepne na stav 'sunk'.
function markSunkCells(hits, cells) {
  cells.forEach(([r, c]) => {
    if (Number.isInteger(r) && Number.isInteger(c) && hits[r] && c >= 0 && c < 10) hits[r][c] = 'sunk';
  });
}

function shipCells(layout, shipId) {
  const cells = [];
  for (let r = 0; r < 10; r++)
    for (let c = 0; c < 10; c++)
      if (layout[r][c] === shipId) cells.push([r, c]);
  return cells;
}

// ── Stavba desky ──────────────────────────────────────────────────────────────
function buildBoard(id, onClick, onHover, onLeave, noClick) {
  const board = document.getElementById(id);
  board.innerHTML = '';
  const cache = Array.from({ length: 10 }, () => new Array(10));
  boardCellCache[id] = cache;
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.r = r;
      cell.dataset.c = c;
      cell.dataset.code = cellName(r, c);
      if (onClick) cell.addEventListener('click', () => onClick(r, c));
      if (onHover) cell.addEventListener('mouseenter', () => onHover(r, c));
      if (onLeave) {
        const wrap = document.getElementById(id);
        wrap.addEventListener('mouseleave', onLeave);
      }
      cache[r][c] = cell;
      board.appendChild(cell);
    }
  }
}

function buildLabels(colId, rowId) {
  const cols = document.getElementById(colId);
  cols.innerHTML = '';
  for (let c = 0; c < 10; c++) {
    const span = document.createElement('span');
    span.textContent = COLS[c];
    cols.appendChild(span);
  }
  const rows = document.getElementById(rowId);
  rows.innerHTML = '';
  for (let r = 0; r < 10; r++) {
    const span = document.createElement('span');
    span.textContent = r + 1;
    rows.appendChild(span);
  }
}

function getCell(boardId, r, c) {
  return boardCellCache[boardId]?.[r]?.[c];
}

// ── Výsledek ──────────────────────────────────────────────────────────────────
function showResult(won) {
  state.gameOver = true;
  if (window.SFX) setTimeout(() => SFX.play(won ? 'win' : 'lose'), 500);
  updateTurnDisplay();
  const resultTitle = won ? T('victory') : T('defeat');
  const turnIndicator = document.getElementById('turn-indicator');
  turnIndicator.textContent = resultTitle;
  turnIndicator.classList.toggle('opponent-turn', !won);
  document.getElementById('result-icon').textContent = won ? '🏆' : '💥';
  document.getElementById('result-title').textContent = resultTitle;
  document.getElementById('result-sub').textContent = won ? T('wonSub') : T('lostSub');
  document.getElementById('result-title').style.color = won ? 'var(--accent)' : 'var(--danger)';
  const panel = document.getElementById('result-panel');
  panel.hidden = false;
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function hideResult() {
  document.getElementById('result-panel').hidden = true;
}

function playAgain() {
  hideResult();
  if (state.mode === 'single') {
    initPlacement();
    showScreen('screen-difficulty');
  } else {
    showScreen('screen-menu');
  }
}

// ── Záznam průběhu ────────────────────────────────────────────────────────────
function logEntry(msg, cls) {
  if (window.SFX && (cls === 'hit' || cls === 'miss' || cls === 'sunk')) SFX.play(cls);
  const log = document.getElementById('game-log');
  const entry = document.createElement('div');
  entry.className = 'log-entry ' + (cls || '');
  entry.textContent = msg;
  log.prepend(entry);
}

// ── Pomocné ───────────────────────────────────────────────────────────────────
function shipName(id) { return SHIPS.find(s => s.id === id)?.name || 'Loď'; }
function shipAcc(id) { return SHIPS.find(s => s.id === id)?.acc || 'loď'; }
function shipMine(id) { return SHIPS.find(s => s.id === id)?.mine || 'tvou loď'; }
