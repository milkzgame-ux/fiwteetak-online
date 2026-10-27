const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const DB_FILE = path.join(__dirname, 'users_db.json');

const DEFAULT_USERS = {
  "admin": {
    username: "admin",
    displayName: "Admin Sheriff",
    password: "admin052063",
    role: "admin",
    chips: 100000,
    bankSavings: 0,
    bankDebt: 0,
    isBanned: false,
    lastDailyClaim: 0,
    avatar: { hatStyle: 'cattleman', hatColor: '#4a2e18', skinTone: '#ffd1a4', sleeveColor: '#881337', badge: 'star' }
  }
};

let USERS = {};

function loadUsersDatabase() {
  try {
    if (fs.existsSync(DB_FILE)) {
      USERS = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } else {
      USERS = { ...DEFAULT_USERS };
      saveUsersDatabase();
    }
  } catch (err) {
    USERS = { ...DEFAULT_USERS };
  }
  if (!USERS["admin"]) {
    USERS["admin"] = { ...DEFAULT_USERS["admin"] };
    saveUsersDatabase();
  }
}

function saveUsersDatabase() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(USERS, null, 2), 'utf8');
  } catch (err) {
    console.error('Save DB error:', err);
  }
}

loadUsersDatabase();

const ACTIVE_SESSIONS = {};
const DISCONNECTED_PLAYERS = {};
const ROOMS = {};

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_VALUES = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10,
  'J': 11, 'Q': 12, 'K': 13, 'A': 14
};

function createDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (const r of RANKS) {
      deck.push({ suit: s, rank: r, value: RANK_VALUES[r], color: (s === '♥' || s === '♦') ? 'red' : 'black' });
    }
  }
  return deck.sort(() => Math.random() - 0.5);
}

const BOT_PRESETS = [
  { name: 'Wyatt', hat: 'cattleman', hatColor: '#2b1d0c', skin: '#ffd1a4', sleeve: '#1e3a8a', badge: 'star' },
  { name: 'Jesse', hat: 'sombrero', hatColor: '#8b0000', skin: '#e0ac69', sleeve: '#14532d', badge: 'feather' },
  { name: 'Belle', hat: 'gambler', hatColor: '#1c1917', skin: '#fcd0a1', sleeve: '#581c87', badge: 'cards' },
  { name: 'Doc', hat: 'derby', hatColor: '#3d2817', skin: '#ffd1a4', sleeve: '#78350f', badge: 'cross' },
  { name: 'Billy', hat: 'outback', hatColor: '#713f12', skin: '#c68642', sleeve: '#047857', badge: 'star' },
  { name: 'Annie', hat: 'fedora', hatColor: '#b45309', skin: '#fde047', sleeve: '#b91c1c', badge: 'feather' }
];

io.on('connection', (socket) => {
  let currentAuthUser = null;
  let currentRoomId = null;

  socket.on('auth:register', ({ username, password }, cb) => {
    if (!username || !password) return cb({ success: false, msg: 'กรุณากรอกข้อมูลให้ครบ' });
    if (USERS[username]) return cb({ success: false, msg: 'ชื่อผู้ใช้นี้มีในระบบแล้ว' });
    USERS[username] = {
      username,
      displayName: username,
      password,
      role: 'player',
      chips: 2000,
      bankSavings: 0,
      bankDebt: 0,
      isBanned: false,
      lastDailyClaim: 0,
      avatar: { hatStyle: 'cattleman', hatColor: '#4a2e18', skinTone: '#ffd1a4', sleeveColor: '#881337', badge: 'star' }
    };
    saveUsersDatabase();
    cb({ success: true, user: sanitizeUser(USERS[username]) });
  });

  socket.on('auth:login', ({ username, password }, cb) => {
    const user = USERS[username];
    if (!user || user.password !== password) return cb({ success: false, msg: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    if (user.isBanned) return cb({ success: false, msg: 'บัญชีถูกระงับการใช้งาน' });

    if (ACTIVE_SESSIONS[username] && ACTIVE_SESSIONS[username] !== socket.id) {
      const oldSocket = io.sockets.sockets.get(ACTIVE_SESSIONS[username]);
      if (oldSocket) {
        oldSocket.emit('auth:force_logout', { msg: 'มีการเข้าสู่ระบบซ้อนจากอุปกรณ์อื่น' });
        oldSocket.disconnect(true);
      }
    }

    ACTIVE_SESSIONS[username] = socket.id;
    currentAuthUser = username;

    let reconnectData = null;
    if (DISCONNECTED_PLAYERS[username]) {
      const rCode = DISCONNECTED_PLAYERS[username].roomCode;
      if (ROOMS[rCode]) {
        reconnectData = { roomCode: rCode, roomName: ROOMS[rCode].name };
      } else {
        delete DISCONNECTED_PLAYERS[username];
      }
    }

    cb({ success: true, user: sanitizeUser(user), reconnectData });
  });

  socket.on('room:confirm_reconnect', ({ roomCode, accept }, cb) => {
    if (!currentAuthUser) return cb({ success: false });
    const room = ROOMS[roomCode];

    if (!accept || !room) {
      if (DISCONNECTED_PLAYERS[currentAuthUser]) {
        clearTimeout(DISCONNECTED_PLAYERS[currentAuthUser].disconnectTimer);
        delete DISCONNECTED_PLAYERS[currentAuthUser];
      }
      if (room) handlePlayerLeave(socket, roomCode, currentAuthUser);
      return cb({ success: false });
    }

    clearTimeout(DISCONNECTED_PLAYERS[currentAuthUser].disconnectTimer);
    delete DISCONNECTED_PLAYERS[currentAuthUser];

    const player = room.players.find(p => p.username === currentAuthUser);
    if (player) {
      player.isOffline = false;
      player.isBotTemporary = false;
    }

    socket.join(roomCode);
    socket.currentRoomId = roomCode;
    currentRoomId = roomCode;

    cb({ success: true, roomCode });
    emitRoomState(room);
  });

  socket.on('user:update_avatar', ({ avatar, displayName }, cb) => {
    if (!currentAuthUser) return cb({ success: false });
    if (avatar) USERS[currentAuthUser].avatar = avatar;
    if (displayName && displayName.trim()) {
      USERS[currentAuthUser].displayName = displayName.trim().substring(0, 16);
    }
    saveUsersDatabase();

    if (currentRoomId && ROOMS[currentRoomId]) {
      const p = ROOMS[currentRoomId].players.find(x => x.username === currentAuthUser);
      if (p) {
        if (avatar) p.avatar = avatar;
        if (displayName) p.displayName = USERS[currentAuthUser].displayName;
      }
      emitRoomState(ROOMS[currentRoomId]);
    }
    cb({ success: true, user: sanitizeUser(USERS[currentAuthUser]) });
  });

  socket.on('chat:global_send', ({ text }) => {
    if (!currentAuthUser || !text.trim()) return;
    const sName = USERS[currentAuthUser].displayName || currentAuthUser;
    io.emit('chat:global_broadcast', {
      sender: sName,
      text: text.trim().substring(0, 80),
      time: new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
    });
  });

  socket.on('chat:room_send', ({ text }) => {
    if (!currentRoomId || !currentAuthUser || !text.trim()) return;
    const sName = USERS[currentAuthUser].displayName || currentAuthUser;
    io.to(currentRoomId).emit('chat:room_broadcast', {
      sender: sName,
      text: text.trim().substring(0, 50)
    });
  });

  socket.on('user:claim_daily', (_, cb) => {
    if (!currentAuthUser) return cb({ success: false });
    const user = USERS[currentAuthUser];
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    if (user.lastDailyClaim && (now - user.lastDailyClaim < oneDay)) {
      const waitMs = oneDay - (now - user.lastDailyClaim);
      return cb({ success: false, msg: 'ยังไม่ถึงรอบรับเหรียญประจำวัน', waitMs });
    }
    user.chips += 2000;
    user.lastDailyClaim = now;
    saveUsersDatabase();
    cb({ success: true, chips: user.chips });
  });

  socket.on('admin:skip_day', (_, cb) => {
    if (!currentAuthUser || USERS[currentAuthUser].role !== 'admin') return cb({ success: false, msg: 'ปฏิเสธสิทธิ์' });
    const user = USERS[currentAuthUser];
    user.lastDailyClaim = 0;
    for (const u of Object.values(USERS)) {
      if (u.bankSavings > 0) u.bankSavings = Math.floor(u.bankSavings * 1.05);
      if (u.bankDebt > 0) u.bankDebt = Math.floor(u.bankDebt * 1.05);
    }
    saveUsersDatabase();
    cb({ success: true, user: sanitizeUser(user) });
  });

  socket.on('admin:get_players', (_, cb) => {
    if (!currentAuthUser || USERS[currentAuthUser].role !== 'admin') return cb({ success: false });
    cb({ success: true, list: Object.values(USERS).map(sanitizeUser) });
  });

  socket.on('admin:mod_user', ({ targetUser, addChips, clearDebt, toggleBan }, cb) => {
    if (!currentAuthUser || USERS[currentAuthUser].role !== 'admin') return cb({ success: false });
    const u = USERS[targetUser];
    if (!u) return cb({ success: false, msg: 'ไม่พบผู้ใช้' });
    if (addChips) u.chips += Number(addChips);
    if (clearDebt) u.bankDebt = 0;
    if (toggleBan !== undefined) u.isBanned = toggleBan;
    saveUsersDatabase();
    cb({ success: true, user: sanitizeUser(u) });
  });

  socket.on('bank:action', ({ type, amount }, cb) => {
    if (!currentAuthUser) return cb({ success: false });
    const u = USERS[currentAuthUser];
    amount = Math.max(0, parseInt(amount) || 0);

    if (type === 'borrow') {
      u.chips += amount;
      u.bankDebt += amount;
    } else if (type === 'repay') {
      const pay = Math.min(amount, u.chips, u.bankDebt);
      u.chips -= pay;
      u.bankDebt -= pay;
    } else if (type === 'deposit') {
      const dep = Math.min(amount, u.chips);
      u.chips -= dep;
      u.bankSavings += dep;
    } else if (type === 'withdraw') {
      const wit = Math.min(amount, u.bankSavings);
      u.bankSavings -= wit;
      u.chips += wit;
    }
    saveUsersDatabase();
    cb({ success: true, user: sanitizeUser(u) });
  });

  socket.on('room:create', ({ roomName, maxPlayers, password, mode }, cb) => {
    if (!currentAuthUser) return cb({ success: false });
    const roomCode = Math.floor(100000 + Math.random() * 900000).toString();
    const newRoom = {
      code: roomCode,
      name: roomName || `Saloon #${roomCode}`,
      host: currentAuthUser,
      maxPlayers: parseInt(maxPlayers) || 6,
      password: password || null,
      mode: mode || 'bot',
      pot: 0,
      round: 1,
      deck: [],
      players: [],
      waitingQueue: [],
      spectators: [],
      activeTurnIndex: 0,
      dealerIndex: 0,
      isGameRunning: false,
      roundHistory: [],
      timer: null
    };

    ROOMS[roomCode] = newRoom;
    currentRoomId = roomCode;
    socket.currentRoomId = roomCode;
    joinRoomInternal(socket, roomCode, currentAuthUser);
    cb({ success: true, roomCode });
    broadcastLobbyRooms();
  });

  socket.on('room:join', ({ roomCode, password }, cb) => {
    if (!currentAuthUser) return cb({ success: false });
    const room = ROOMS[roomCode];
    if (!room) return cb({ success: false, msg: 'ไม่พบเลขห้องนี้ หรือห้องถูกลบแล้ว' });
    if (room.password && room.password !== password) return cb({ success: false, msg: 'รหัสผ่านห้องไม่ถูกต้อง' });
    if (room.players.length + room.waitingQueue.length >= room.maxPlayers) {
      return cb({ success: false, msg: 'ที่นั่งบนโต๊ะเต็มแล้ว' });
    }

    currentRoomId = roomCode;
    socket.currentRoomId = roomCode;
    joinRoomInternal(socket, roomCode, currentAuthUser);
    cb({ success: true, roomCode });
    broadcastLobbyRooms();
  });

  socket.on('game:stand_up', () => {
    if (!currentRoomId || !ROOMS[currentRoomId]) return;
    const room = ROOMS[currentRoomId];
    const pIdx = room.players.findIndex(p => p.username === currentAuthUser);
    if (pIdx !== -1) {
      room.players.splice(pIdx, 1);
      room.spectators.push(currentAuthUser);
      if (room.isGameRunning) {
        if (room.activeTurnIndex >= room.players.length) room.activeTurnIndex = 0;
        clearTimeout(room.timer);
        checkNextTurnOrRoundEnd(room);
      }
    } else {
      room.waitingQueue = room.waitingQueue.filter(p => p.username !== currentAuthUser);
      room.spectators.push(currentAuthUser);
    }
    emitRoomState(room);
    checkAndCleanEmptyRoom(currentRoomId);
  });

  socket.on('game:sit_down', () => {
    if (!currentRoomId || !ROOMS[currentRoomId]) return;
    const room = ROOMS[currentRoomId];
    if (room.players.length + room.waitingQueue.length >= room.maxPlayers) return;

    room.spectators = room.spectators.filter(u => u !== currentAuthUser);
    const pObj = {
      username: currentAuthUser,
      displayName: USERS[currentAuthUser].displayName || currentAuthUser,
      chips: USERS[currentAuthUser].chips,
      hand: [],
      avatar: USERS[currentAuthUser].avatar,
      isWaiting: room.isGameRunning,
      lastBet: 0
    };

    if (room.isGameRunning) {
      room.waitingQueue.push(pObj);
      socket.emit('game:msg', 'คุณนั่งเข้ามาระหว่างเกม! ตัวละครจะอยู่ในสถานะ "รอเล่น" จนกว่ากองกลาง (Pot) จะหมดเหลือ 0');
    } else {
      room.players.push(pObj);
    }

    emitRoomState(room);
  });

  socket.on('game:start_click', () => {
    if (!currentRoomId || !ROOMS[currentRoomId]) return;
    const room = ROOMS[currentRoomId];

    // เงื่อนไขเคร่งครัด: ย้ายคนจาก waitingQueue ได้ก็ต่อเมื่อ Pot เป็น 0 เท่านั้น
    if (room.pot === 0 && room.waitingQueue.length > 0) {
      while (room.waitingQueue.length > 0 && room.players.length < room.maxPlayers) {
        const waitingP = room.waitingQueue.shift();
        waitingP.isWaiting = false;
        room.players.push(waitingP);
      }
    }

    if (room.players.length < 2) {
      return socket.emit('game:msg', '⚠️ ต้องมีผู้เล่นอย่างน้อย 2 คนขึ้นไปจึงจะเริ่มเกมได้!');
    }

    startNewGameRound(room);
  });

  socket.on('game:bet', ({ amount }) => {
    if (!currentRoomId || !ROOMS[currentRoomId]) return;
    const room = ROOMS[currentRoomId];
    if (!room.isGameRunning) return;

    const player = room.players[room.activeTurnIndex];
    if (!player || player.username !== currentAuthUser) {
      return socket.emit('game:msg', 'ยังไม่ถึงรอบของคุณ ไม่สามารถวางเดิมพันได้');
    }

    clearTimeout(room.timer);
    processPlayerBet(room, player, amount);
  });

  socket.on('room:leave', () => {
    if (socket.currentRoomId) handlePlayerLeave(socket, socket.currentRoomId, currentAuthUser);
  });

  socket.on('disconnect', () => {
    if (currentAuthUser && ACTIVE_SESSIONS[currentAuthUser] === socket.id) {
      delete ACTIVE_SESSIONS[currentAuthUser];
    }

    if (socket.currentRoomId) {
      const room = ROOMS[socket.currentRoomId];
      if (room && currentAuthUser) {
        const player = room.players.find(p => p.username === currentAuthUser);
        if (player) {
          player.isOffline = true;
          player.isBotTemporary = true;

          // ถ้าถึงตาของคนที่หลุดพอดี ให้บอทวางเดิมพันแทน
          if (room.isGameRunning && room.players[room.activeTurnIndex] && room.players[room.activeTurnIndex].username === currentAuthUser) {
            clearTimeout(room.timer);
            setTimeout(() => {
              processPlayerBet(room, player, 10);
            }, 1500);
          }

          // ตั้งเวลารอ 3 นาที (180,000 ms) ถ้าไม่กลับมาจะเตะออกห้องทันที
          const tId = setTimeout(() => {
            handlePlayerLeave(socket, room.code, currentAuthUser);
            delete DISCONNECTED_PLAYERS[currentAuthUser];
          }, 180000);

          DISCONNECTED_PLAYERS[currentAuthUser] = {
            roomCode: room.code,
            disconnectTimer: tId
          };

          emitRoomState(room);
          return;
        }
      }
      handlePlayerLeave(socket, socket.currentRoomId, currentAuthUser);
    }
  });
});

function sanitizeUser(u) {
  return {
    username: u.username,
    displayName: u.displayName || u.username,
    role: u.role,
    chips: u.chips,
    bankSavings: u.bankSavings,
    bankDebt: u.bankDebt,
    lastDailyClaim: u.lastDailyClaim,
    avatar: u.avatar
  };
}

function broadcastLobbyRooms() {
  const roomList = Object.values(ROOMS).map(r => ({
    code: r.code,
    name: r.name,
    host: r.host,
    players: r.players.length + (r.waitingQueue ? r.waitingQueue.length : 0),
    maxPlayers: r.maxPlayers,
    hasPassword: !!r.password,
    pot: r.pot,
    isGameRunning: r.isGameRunning
  }));
  io.emit('lobby:rooms_update', roomList);
}

function joinRoomInternal(socket, roomCode, username) {
  const room = ROOMS[roomCode];
  socket.join(roomCode);

  const playerObj = {
    username,
    displayName: USERS[username].displayName || username,
    chips: USERS[username].chips,
    hand: [],
    avatar: USERS[username].avatar || { hatStyle: 'cattleman', hatColor: '#4a2e18', skinTone: '#ffd1a4', sleeveColor: '#881337', badge: 'star' },
    isWaiting: room.isGameRunning,
    lastBet: 0,
    isOffline: false,
    isBotTemporary: false
  };

  if (room.isGameRunning) {
    room.waitingQueue.push(playerObj);
    socket.emit('game:msg', 'คุณเข้าห้องกลางเกม! ต้องรอกองกลาง (Pot) หมดเหลือ 0 ก่อนจึงจะเข้าร่วมเล่นและรับปันผลได้');
  } else {
    room.players.push(playerObj);
  }

  if (room.mode === 'bot' && (room.players.length + room.waitingQueue.length) < room.maxPlayers) {
    let botIdx = 0;
    while ((room.players.length + room.waitingQueue.length) < room.maxPlayers) {
      const bData = BOT_PRESETS[botIdx % BOT_PRESETS.length];
      const bName = `${bData.name}_${Math.floor(Math.random()*90+10)}`;
      room.players.push({
        username: bName,
        displayName: bName,
        chips: 2000,
        hand: [],
        avatar: { hatStyle: bData.hat, hatColor: bData.hatColor, skinTone: bData.skin, sleeveColor: bData.sleeve, badge: bData.badge },
        isBot: true,
        isWaiting: false,
        lastBet: 0
      });
      botIdx++;
    }
  }

  emitRoomState(room);

  if (!room.isGameRunning) {
    if (room.players.length >= 2) {
      io.to(room.code).emit('game:need_start_click', 'โต๊ะพร้อมแล้ว! กดเริ่มเกมส์เพื่อเริ่มเล่นรอบแรก (หัก Ante 50)');
    } else {
      io.to(room.code).emit('game:need_start_click', 'กำลังรอผู้เล่นอย่างน้อย 2 คนเพื่อเริ่มเกม...');
    }
  }
}

function startNewGameRound(room) {
  room.isGameRunning = true;
  room.deck = createDeck();

  if (room.pot === 0) {
    room.players.forEach(p => {
      const ante = Math.min(50, p.chips);
      p.chips -= ante;
      p.lastBet = ante;
      room.pot += ante;
      if (USERS[p.username]) USERS[p.username].chips = p.chips;
    });
    saveUsersDatabase();
  }

  // แจกไพ่ 4 ใบเฉพาะผู้เล่นที่ไม่ได้รอ
  room.players.forEach(p => {
    p.hand = [room.deck.pop(), room.deck.pop(), room.deck.pop(), room.deck.pop()];
  });

  room.activeTurnIndex = room.dealerIndex;
  
  // แจ้งเตือนแอนิเมชันแจกไพ่
  io.to(room.code).emit('game:dealing_cards');

  emitRoomState(room);
  startTurnTimer(room);
}

function startTurnTimer(room) {
  clearTimeout(room.timer);
  const currentP = room.players[room.activeTurnIndex];
  if (!currentP) return;

  const currentDisplayName = currentP.displayName || currentP.username;
  
  // สั่งนับเวลาเต็ม 3 นาที (180 วินาที)
  io.to(room.code).emit('game:turn_start', {
    activeUsername: currentP.username,
    activeDisplayName: currentDisplayName,
    timeoutSec: 180
  });

  if (currentP.isBot || currentP.isBotTemporary) {
    setTimeout(() => {
      const maxBet = Math.min(currentP.chips, room.pot);
      const betAmt = Math.min(Math.max(10, Math.floor(Math.random() * (maxBet - 10 + 1)) + 10), maxBet);
      processPlayerBet(room, currentP, betAmt);
    }, 1800);
    return;
  }

  // จับเวลา 180 วินาที (3 นาที)
  room.timer = setTimeout(() => {
    processPlayerBet(room, currentP, 10);
  }, 180000);
}

function processPlayerBet(room, player, amount) {
  const maxPossible = Math.min(player.chips, room.pot);
  let finalBet = parseInt(amount) || 10;
  if (finalBet < 10) finalBet = 10;
  if (finalBet > maxPossible) finalBet = maxPossible;

  player.chips -= finalBet;
  player.lastBet = finalBet;
  if (USERS[player.username]) USERS[player.username].chips = player.chips;

  const communityCard = room.deck.pop() || createDeck().pop();

  let highestWinningCard = null;
  player.hand.forEach(c => {
    if (c.suit === communityCard.suit && c.value > communityCard.value) {
      if (!highestWinningCard || c.value > highestWinningCard.value) {
        highestWinningCard = c;
      }
    }
  });

  const isWin = highestWinningCard !== null;

  if (isWin) {
    const wonAmount = finalBet * 2;
    room.pot -= finalBet;
    player.chips += wonAmount;
    if (USERS[player.username]) USERS[player.username].chips = player.chips;
  } else {
    room.pot += finalBet;
  }

  const pName = player.displayName || player.username;
  room.roundHistory.unshift({
    round: room.round,
    player: pName,
    betAmount: finalBet,
    communityCard,
    winningCard: highestWinningCard,
    isWin,
    potRemaining: room.pot,
    timestamp: new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
  });

  saveUsersDatabase();

  // ส่งผลลัพธ์หงายไพ่กลางโต๊ะและไพ่ที่ชนะ
  io.to(room.code).emit('game:showdown_result', {
    player: pName,
    communityCard,
    winningCard: highestWinningCard,
    isWin,
    betAmount: finalBet,
    potNow: room.pot
  });

  setTimeout(() => {
    checkNextTurnOrRoundEnd(room);
  }, 3500);
}

function checkNextTurnOrRoundEnd(room) {
  // เมื่อ Pot กองกลางหมดเหลือ 0
  if (room.pot <= 0) {
    room.pot = 0;
    room.isGameRunning = false;

    // 1. ถ้ามีคนหลุดการเชื่อมต่ออยู่ ให้เตะออกจากห้องทันทีเมื่อ Pot หมด
    const offlinePlayers = room.players.filter(p => p.isOffline);
    offlinePlayers.forEach(p => {
      handlePlayerLeave(null, room.code, p.username);
      if (DISCONNECTED_PLAYERS[p.username]) {
        clearTimeout(DISCONNECTED_PLAYERS[p.username].disconnectTimer);
        delete DISCONNECTED_PLAYERS[p.username];
      }
    });

    // 2. ดึงผู้เล่นที่รออยู่ใน waitingQueue เข้ามาเล่นเป็นผู้เล่นจริงในรอบถัดไป
    while (room.waitingQueue.length > 0 && room.players.length < room.maxPlayers) {
      const waitingP = room.waitingQueue.shift();
      waitingP.isWaiting = false;
      room.players.push(waitingP);
    }

    emitRoomState(room);
    io.to(room.code).emit('game:need_start_click', 'กองกลางหมดแล้ว (Pot Reset)! ผู้เล่นใหม่เข้าร่วมได้แล้ว กดเริ่มเกมส์เพื่อเริ่มรอบใหม่');
    return;
  }

  room.activeTurnIndex++;

  if (room.activeTurnIndex >= room.players.length) {
    const activeCount = room.players.length;
    const threshold = activeCount * 400;

    if (room.pot >= threshold) {
      const splitPool = Math.floor(room.pot * 0.80);
      const perPlayer = Math.floor(splitPool / activeCount);
      room.players.forEach(p => {
        p.chips += perPlayer;
        if (USERS[p.username]) USERS[p.username].chips = p.chips;
      });
      room.pot -= (perPlayer * activeCount);
      saveUsersDatabase();

      io.to(room.code).emit('game:pot_split_jackpot', {
        amountDistributed: perPlayer * activeCount,
        perPlayer,
        remainingPot: room.pot
      });
    }

    room.players = room.players.filter(p => p.chips > 0);
    room.dealerIndex = (room.dealerIndex + 1) % Math.max(1, room.players.length);
    room.activeTurnIndex = room.dealerIndex;
    room.round++;

    startNewGameRound(room);
  } else {
    startTurnTimer(room);
    emitRoomState(room);
  }
}

function checkAndCleanEmptyRoom(roomCode) {
  const room = ROOMS[roomCode];
  if (!room) return;

  const realHumans = 
    room.players.filter(p => !p.isBot && !p.isOffline).length +
    room.waitingQueue.filter(p => !p.isBot).length +
    (room.spectators ? room.spectators.length : 0);

  if (realHumans === 0) {
    clearTimeout(room.timer);
    delete ROOMS[roomCode];
    broadcastLobbyRooms();
    return true;
  }
  return false;
}

function handlePlayerLeave(socket, roomCode, username) {
  const room = ROOMS[roomCode];
  if (!room) return;

  room.players = room.players.filter(p => p.username !== username);
  room.waitingQueue = room.waitingQueue.filter(p => p.username !== username);
  if (room.spectators) room.spectators = room.spectators.filter(u => u !== username);

  if (socket) {
    socket.leave(roomCode);
    socket.currentRoomId = null;
  }

  if (checkAndCleanEmptyRoom(roomCode)) return;

  if (room.host === username) {
    const nextH = room.players.find(p => !p.isBot) || room.waitingQueue.find(p => !p.isBot);
    if (nextH) room.host = nextH.username;
  }

  room.isGameRunning = false;
  clearTimeout(room.timer);
  const pName = USERS[username] ? (USERS[username].displayName || username) : username;
  io.to(roomCode).emit('game:need_start_click', `ผู้เล่น ${pName} ออกจากห้อง กดเริ่มเกมส์เพื่อเริ่มรอบใหม่`);
  emitRoomState(room);
  broadcastLobbyRooms();
}

function emitRoomState(room) {
  const allSeatPlayers = [
    ...room.players.map(p => ({
      username: p.username,
      displayName: p.displayName || p.username,
      chips: p.chips,
      cardCount: p.hand ? p.hand.length : 0,
      hand: p.hand,
      avatar: p.avatar,
      isBot: p.isBot,
      isWaiting: false,
      isOffline: p.isOffline,
      lastBet: p.lastBet || 0
    })),
    ...room.waitingQueue.map(p => ({
      username: p.username,
      displayName: p.displayName || p.username,
      chips: p.chips,
      cardCount: 0,
      hand: [],
      avatar: p.avatar,
      isBot: p.isBot,
      isWaiting: true,
      isOffline: false,
      lastBet: 0
    }))
  ];

  io.to(room.code).emit('game:state_sync', {
    code: room.code,
    name: room.name,
    host: room.host,
    pot: room.pot,
    round: room.round,
    players: allSeatPlayers,
    waitingCount: room.waitingQueue.length,
    spectators: room.spectators,
    activeTurnIndex: room.activeTurnIndex,
    dealerIndex: room.dealerIndex,
    isGameRunning: room.isGameRunning,
    roundHistory: room.roundHistory || []
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server online with 3-Min timeout & Pot-Reset Queue on port ${PORT}`);
});
