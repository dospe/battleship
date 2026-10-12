const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

// Hard cap on concurrent rooms. Without this, a single connection can call
// create_room in a loop and grow `rooms` without bound — each entry holds
// two 10x10 board/hit arrays, so this is a real memory-exhaustion DoS, not
// just theoretical. Comfortably above any real simultaneous-match count.
const MAX_ROOMS = 1000;

// Expected fleet: shipId -> number of cells that ship must occupy.
// Must match the SHIPS list in public/game.js.
const SHIP_SIZES = { 1: 5, 2: 4, 3: 3, 4: 3, 5: 2 };

function makeCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Reject anything the client sends as a "board" that isn't a well-formed
// 10x10 grid containing exactly the expected fleet. Without this check a
// client could submit a malformed shape (crashing the server the first time
// it's indexed during an attack) or an empty/invalid board (guaranteeing it
// can never be fully sunk, i.e. guaranteeing the sender can never lose).
function isValidBoard(board) {
  if (!Array.isArray(board) || board.length !== 10) return false;
  const counts = {};
  for (const row of board) {
    if (!Array.isArray(row) || row.length !== 10) return false;
    for (const cell of row) {
      if (cell === 0) continue;
      if (!Number.isInteger(cell) || !SHIP_SIZES[cell]) return false;
      counts[cell] = (counts[cell] || 0) + 1;
    }
  }
  return Object.keys(SHIP_SIZES).every(id => counts[id] === SHIP_SIZES[id]);
}

function checkSunk(board, shipId) {
  for (let r = 0; r < 10; r++)
    for (let c = 0; c < 10; c++)
      if (board[r][c] === shipId) return false;
  return true;
}

function checkWin(board) {
  for (let r = 0; r < 10; r++)
    for (let c = 0; c < 10; c++)
      if (typeof board[r][c] === 'number' && board[r][c] > 0) return false;
  return true;
}

// Cells a ship occupies in the untouched copy of a board, so the attacker's
// client can repaint the whole ship as sunk (its working board has the hit
// cells zeroed out by then).
function shipCells(layout, shipId) {
  const cells = [];
  for (let r = 0; r < 10; r++)
    for (let c = 0; c < 10; c++)
      if (layout[r][c] === shipId) cells.push([r, c]);
  return cells;
}

io.on('connection', (socket) => {
  socket.on('create_room', () => {
    if (Object.keys(rooms).length >= MAX_ROOMS) {
      return socket.emit('join_error', 'Server je plný, zkus to za chvíli.');
    }
    const code = makeCode();
    rooms[code] = { players: [socket.id], boards: {}, layouts: {}, hits: {}, ready: new Set(), turn: null };
    socket.join(code);
    socket.emit('room_created', { code });
  });

  socket.on('join_room', ({ code } = {}) => {
    if (typeof code !== 'string' || !code) return socket.emit('join_error', 'Místnost nenalezena.');
    const upperCode = code.toUpperCase();
    const room = rooms[upperCode];
    if (!room) return socket.emit('join_error', 'Místnost nenalezena.');
    if (room.players.length >= 2) return socket.emit('join_error', 'Místnost je plná.');
    room.players.push(socket.id);
    socket.join(upperCode);
    socket.emit('room_joined', { code: upperCode });
    io.to(upperCode).emit('opponent_joined');
  });

  socket.on('ships_placed', ({ code, board } = {}) => {
    const room = rooms[code];
    if (!room) return;
    if (!isValidBoard(board)) return;
    room.boards[socket.id] = board;
    room.layouts[socket.id] = board.map(row => row.slice());
    room.hits[socket.id] = Array.from({ length: 10 }, () => Array(10).fill(false));
    room.ready.add(socket.id);
    if (room.ready.size === 2) {
      room.turn = room.players[0];
      io.to(code).emit('game_start', { firstTurn: room.turn });
    } else {
      socket.to(code).emit('opponent_ready');
      socket.emit('waiting_for_opponent');
    }
  });

  socket.on('attack', ({ code, row, col } = {}) => {
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row > 9 || col < 0 || col > 9) return;
    const room = rooms[code];
    if (!room || room.turn !== socket.id) return;
    const oppId = room.players.find(id => id !== socket.id);
    const board = room.boards[oppId];
    if (!board || !room.hits[oppId] || room.hits[oppId][row][col]) return;

    room.hits[oppId][row][col] = true;
    const cellVal = board[row][col];
    const hit = typeof cellVal === 'number' && cellVal > 0;
    let sunkShip = null;
    let sunkCells = null;

    if (hit) {
      board[row][col] = 0;
      if (checkSunk(board, cellVal)) {
        sunkShip = cellVal;
        sunkCells = shipCells(room.layouts[oppId], cellVal);
      }
    }

    const won = hit && checkWin(board);
    const nextTurn = won ? null : (hit ? socket.id : oppId);
    if (!won) room.turn = nextTurn;

    io.to(code).emit('attack_result', {
      attacker: socket.id,
      row, col, hit, sunkShip, sunkCells, won, nextTurn
    });

    if (won) delete rooms[code];
  });

  socket.on('disconnect', () => {
    // A socket can be a player in more than one room (e.g. it called
    // create_room several times without ever being joined). Sweep every
    // room, not just the first match, or the rest leak for the life of
    // the process — see MAX_ROOMS above for why that matters.
    for (const [code, room] of Object.entries(rooms)) {
      if (room.players.includes(socket.id)) {
        io.to(code).emit('opponent_disconnected');
        delete rooms[code];
      }
    }
  });
});

const PORT = process.env.PORT || 3025;
server.listen(PORT, () => console.log(`Lodě běží na portu ${PORT}`));
