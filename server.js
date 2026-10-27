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
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
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

  socket.emit('lobby:rooms_update', getRoomList());

  socket.on('db:sync_restore', ({ backupData }) => {
    if (backupData && backupData.username) {
      const u = backupData.username;
      if (!USERS[u] || (backupData.chips > USERS[u].chips)) {
        USERS[u] = backupData;
        saveUsersDatabase();
      }
    }
  });

  socket.on('auth:register', ({ username, password }, cb) => {
    if (!username || !password) return cb({ success: false, msg: 'กรุณากรอกข้อมูลให้ครบ' });
    if (USERS[username]) return cb({ success: false, msg: 'ชื่อผู้ใช้นี้มีในระบบแล้ว' });
    
    USERS[username] = {
      username,
      displayName: username,
      password,
      role: 'player',
      chips: 5000, 
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
    cb({ success: true, user: sanitizeUser(user) });
    broadcastLobbyRooms();
  });

  socket.on('auth:logout', () => {
    if (currentAuthUser) {
      if (ACTIVE_SESSIONS[currentAuthUser] === socket.id) {
        delete ACTIVE_SESSIONS[currentAuthUser];
      }
      if (socket.currentRoomId) {
        handlePlayerLeave(socket, socket.currentRoomId, currentAuthUser);
      }
      currentAuthUser = null;
    }
  });

  socket.on('user:update_avatar', ({ avatar, displayName }, cb) => {
    if (!currentAuthUser) return cb({ success: false });
    if (avatar) USERS[currentAuthUser].avatar = avatar;
    if (displayName && displayName.trim()) {
      USERS[currentAuthUser].displayName = displayName.trim().substring(0, 16);
    }
    saveUsersDatabase();

    if (socket.currentRoomId && ROOMS[socket.currentRoomId]) {
      const p = ROOMS[socket.currentRoomId].players.find(x => x.username === currentAuthUser);
      if (p) {
        if (avatar) p.avatar = avatar;
        if (displayName) p.displayName = USERS[currentAuthUser].displayName;
      }
      emitRoomState(ROOMS[socket.currentRoomId]);
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
    if (!socket.currentRoomId || !currentAuthUser || !text.trim()) return;
    const sName = USERS[currentAuthUser].displayName || currentAuthUser;
    io.to(socket.currentRoomId).emit('chat:room_broadcast', {
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

  socket.on('lobby:get_rooms', () => {
    socket.emit('lobby:rooms_update', getRoomList());
  });

  // สร้างห้องใหม่ (เคลียร์ของเก่าออกหมดจด)
  socket.on('room:create', ({ roomName, maxPlayers, password, mode }, cb) => {
    if (!currentAuthUser) return cb({ success: false });
    
    if (socket.currentRoomId) {
      handlePlayerLeave(socket, socket.currentRoomId, currentAuthUser);
    }

    const roomCode = Math.floor(100000 + Math.random() * 900000).toString();
    const newRoom = {
      code: roomCode,
      name: roomName || `Saloon #${roomCode}`,
      host: currentAuthUser,
      maxPlayers: parseInt(maxPlayers) || 6,
      password: password || null,
      mode: mode || 'human',
      pot: 0,
      round: 1,
      deck: [],
      players: [],
      waitingQueue: [],
      spectators: [],
      activeTurnIndex: 0,
      dealerIndex: 0,
      isGameRunning: false,
      cardsDealt: false,
      roundHistory: [],
      timer: null
    };

    ROOMS[roomCode] = newRoom;
    socket.currentRoomId = roomCode;
    socket.join(roomCode);
    
    joinRoomInternal(socket, roomCode, currentAuthUser);
    
    cb({ success: true, roomCode });
    broadcastLobbyRooms();
  });

  socket.on('room:join', ({ roomCode, password }, cb) => {
    if (!currentAuthUser) return cb({ success: false });
    
    if (socket.currentRoomId) {
      handlePlayerLeave(socket, socket.currentRoomId, currentAuthUser);
    }

    const room = ROOMS[roomCode];
    if (!room) return cb({ success: false, msg: 'ไม่พบเลขห้องนี้ หรือห้องถูกปิดแล้ว' });
    if (room.password && room.password !== password) return cb({ success: false, msg: 'รหัสผ่านห้องไม่ถูกต้อง' });

    socket.currentRoomId = roomCode;
    socket.join(roomCode);
    joinRoomInternal(socket, roomCode, currentAuthUser);

    cb({ success: true, roomCode });
    broadcastLobbyRooms();
  });

  // ลุกจากโต๊ะ: เคลียร์ตัวออกจากที่นั่งและคิวทันที ไปเป็นผู้ชม
  socket.on('game:stand_up', () => {
    if (!socket.currentRoomId || !ROOMS[socket.currentRoomId]) return;
    const room = ROOMS[socket.currentRoomId];
    
    room.players = room.players.filter(p => p.username !== currentAuthUser);
    room.waitingQueue = room.waitingQueue.filter(p => p.username !== currentAuthUser);
    
    if (!room.spectators.includes(currentAuthUser)) {
      room.spectators.push(currentAuthUser);
    }

    if (room.isGameRunning) {
      if (room.activeTurnIndex >= room.players.length) room.activeTurnIndex = 0;
      clearTimeout(room.timer);
      checkNextTurnOrRoundEnd(room);
    }
    
    emitRoomState(room);
    checkAndCleanEmptyRoom(socket.currentRoomId);
  });

  socket.on('game:sit_down', () => {
    if (!socket.currentRoomId || !ROOMS[socket.currentRoomId]) return;
    const room = ROOMS[socket.currentRoomId];
    
    if (room.players.length + room.waitingQueue.length >= room.maxPlayers) {
      return socket.emit('game:msg', 'ที่นั่งโต๊ะเต็มแล้ว!');
    }

    room.spectators = room.spectators.filter(u => u !== currentAuthUser);
    const userDbInfo = USERS[currentAuthUser] || { chips: 5000, displayName: currentAuthUser };

    const pObj = {
      username: currentAuthUser,
      displayName: userDbInfo.displayName,
      chips: userDbInfo.chips,
      hand: [],
      avatar: userDbInfo.avatar || { hatStyle: 'cattleman', hatColor: '#4a2e18', skinTone: '#ffd1a4', sleeveColor: '#881337', badge: 'star' },
      isWaiting: room.isGameRunning,
      lastBet: 0,
      isOffline: false,
      isBotTemporary: false
    };

    if (room.isGameRunning) {
      room.waitingQueue.push(pObj);
      socket.emit('game:msg', 'คุณนั่งเข้ามาระหว่างเกม! ต้องรอกองกลาง (Pot) หมดเหลือ 0 ก่อนจึงจะเข้าเล่นได้');
    } else {
      room.players.push(pObj);
    }

    emitRoomState(room);
  });

  // กดเริ่มเกมส์คนเดียว: เกมจะเริ่มทันทีและปุ่มจะหายไปจากทุกคน
  socket.on('game:start_click', () => {
    if (!socket.currentRoomId || !ROOMS[socket.currentRoomId]) return;
    const room = ROOMS[socket.currentRoomId];

    if (room.isGameRunning) return; // ป้องกันการกดเริ่มซ้ำซ้อน

    if (room.pot === 0 && room.waitingQueue.length > 0) {
      while (room.waitingQueue.length > 0 && room.players.length < room.maxPlayers) {
        const waitingP = room.waitingQueue.shift();
        waitingP.isWaiting = false;
        room.players.push(waitingP);
      }
    }

    const readyPlayers = room.players.filter(p => !p.isWaiting).length;
    if (readyPlayers < 2) {
      return socket.emit('game:msg', '⚠️ ต้องมีผู้เล่นอย่างน้อย 2 คนขึ้นไปจึงจะเริ่มเกมได้!');
    }

    // ซ่อนปุ่มเริ่มเกมจากทุกคนทันที
    io.to(room.code).emit('game:hide_start_btn');
    startNewGameRound(room);
  });

  socket.on('game:bet', ({ amount }) => {
    if (!socket.currentRoomId || !ROOMS[socket.currentRoomId]) return;
    const room = ROOMS[socket.currentRoomId];
    if (!room.isGameRunning || !room.cardsDealt) return;

    const player = room.players[room.activeTurnIndex];
    if (!player || player.username !== currentAuthUser) {
      return socket.emit('game:msg', 'ยังไม่ถึงรอบของคุณ ไม่สามารถวางเดิมพันได้');
    }

    clearTimeout(room.timer);
    processPlayerBet(room, player, amount);
  });

  // ออกจากห้อง: ดึงตัวลุกจากโต๊ะและออกจากห้องทันที
  socket.on('room:leave', () => {
    if (socket.currentRoomId) {
      handlePlayerLeave(socket, socket.currentRoomId, currentAuthUser);
    }
  });

  socket.on('disconnect', () => {
    if (currentAuthUser && ACTIVE_SESSIONS[currentAuthUser] === socket.id) {
      delete ACTIVE_SESSIONS[currentAuthUser];
    }
    if (socket.currentRoomId) {
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

function getRoomList() {
  return Object.values(ROOMS).map(r => ({
    code: r.code,
    name: r.name,
    host: r.host,
    players: r.players.length + (r.waitingQueue ? r.waitingQueue.length : 0),
    maxPlayers: r.maxPlayers,
    hasPassword: !!r.password,
    pot: r.pot,
    mode: r.mode,
    isGameRunning: r.isGameRunning
  }));
}

function broadcastLobbyRooms() {
  io.emit('lobby:rooms_update', getRoomList());
}

function joinRoomInternal(socket, roomCode, username) {
  const room = ROOMS[roomCode];
  const userDbInfo = USERS[username] || { chips: 5000, displayName: username, avatar: { hatStyle: 'cattleman', hatColor: '#4a2e18', skinTone: '#ffd1a4', sleeveColor: '#881337', badge: 'star' } };

  const playerObj = {
    username,
    displayName: userDbInfo.displayName,
    chips: userDbInfo.chips,
    hand: [],
    avatar: userDbInfo.avatar || { hatStyle: 'cattleman', hatColor: '#4a2e18', skinTone: '#ffd1a4', sleeveColor: '#881337', badge: 'star' },
    isWaiting: room.isGameRunning,
    lastBet: 0,
    isOffline: false,
    isBotTemporary: false
  };

  const totalCurrentPlayers = room.players.length + room.waitingQueue.length;

  if (totalCurrentPlayers < room.maxPlayers) {
    if (room.isGameRunning) {
      room.waitingQueue.push(playerObj);
      socket.emit('game:msg', 'คุณเข้าห้องกลางเกม! ต้องรอกองกลาง (Pot) หมดเหลือ 0 ก่อนจึงจะเข้าร่วมเล่นได้');
    } else {
      room.players.push(playerObj);
    }
  } else {
    if (!room.spectators.includes(username)) room.spectators.push(username);
    socket.emit('game:msg', 'ที่นั่งบนโต๊ะเต็มแล้ว! คุณได้เข้าร่วมในฐานะ ผู้ชม');
  }

  // โหมดบอท: ใส่บอทเฉพาะห้องนี้
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
    const realPlayers = room.players.filter(p => !p.isWaiting).length;
    if (realPlayers >= 2) {
      io.to(room.code).emit('game:need_start_click', 'โต๊ะพร้อมแล้ว! กดเริ่มเกมส์เพื่อเริ่มเล่น (หัก Ante 50)');
    } else {
      io.to(room.code).emit('game:need_start_click', 'กำลังรอผู้เล่นอย่างน้อย 2 คนเพื่อเริ่มเกม...');
    }
  }
}

// เริ่มรอบ: หัก Ante 50 ทุกคนเข้า POT ทันที
function startNewGameRound(room) {
  room.isGameRunning = true;
  room.cardsDealt = false;
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

  room.players.forEach(p => {
    p.hand = [room.deck.pop(), room.deck.pop(), room.deck.pop(), room.deck.pop()];
  });

  room.activeTurnIndex = room.dealerIndex;
  
  emitRoomState(room);
  io.to(room.code).emit('game:dealing_cards');

  const activeCount = room.players.filter(p => !p.isWaiting).length;
  const dealTime = (activeCount * 4 * 160) + 700;

  setTimeout(() => {
    room.cardsDealt = true;
    emitRoomState(room);
    startTurnTimer(room);
  }, dealTime);
}

function startTurnTimer(room) {
  clearTimeout(room.timer);
  const currentP = room.players[room.activeTurnIndex];
  if (!currentP) return;

  const currentDisplayName = currentP.displayName || currentP.username;
  
  io.to(room.code).emit('game:turn_start', {
    activeUsername: currentP.username,
    activeDisplayName: currentDisplayName,
    timeoutSec: 30
  });

  if (currentP.isBot) {
    setTimeout(() => {
      const maxBet = Math.min(currentP.chips, room.pot);
      const betAmt = Math.min(Math.max(10, Math.floor(Math.random() * (maxBet - 10 + 1)) + 10), maxBet);
      processPlayerBet(room, currentP, betAmt);
    }, 1800);
    return;
  }

  room.timer = setTimeout(() => {
    processPlayerBet(room, currentP, 10);
  }, 30000);
}

function processPlayerBet(room, player, amount) {
  const maxPossible = Math.min(player.chips, room.pot);
  let finalBet = parseInt(amount) || 10;
  if (finalBet < 10) finalBet = Math.min(10, player.chips);
  if (finalBet > maxPossible) finalBet = maxPossible;

  player.chips -= finalBet;
  player.lastBet = finalBet;
  if (USERS[player.username]) USERS[player.username].chips = player.chips;

  const communityCard = room.deck.pop() || createDeck().pop();
  let highestWinningCard = null;

  player.hand.forEach(c => {
    if (c.suit === communityCard.suit && c.value > communityCard.value) {
      if (!highestWinningCard || c.value > highestWinningCard.value) highestWinningCard = c;
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
  
  saveUsersDatabase();

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

  io.to(room.code).emit('game:showdown_result', {
    player: pName,
    communityCard,
    winningCard: highestWinningCard,
    isWin,
    betAmount: finalBet,
    potNow: room.pot,
    playerChipsNow: player.chips
  });

  emitRoomState(room);

  setTimeout(() => {
    checkNextTurnOrRoundEnd(room);
  }, 3500);
}

function checkNextTurnOrRoundEnd(room) {
  if (room.pot <= 0) {
    room.pot = 0;
    room.isGameRunning = false;
    room.cardsDealt = false;

    while (room.waitingQueue.length > 0 && room.players.length < room.maxPlayers) {
      const waitingP = room.waitingQueue.shift();
      waitingP.isWaiting = false;
      room.players.push(waitingP);
    }

    emitRoomState(room);
    io.to(room.code).emit('game:need_start_click', 'กองกลางหมดแล้ว (Pot Reset)! กดเริ่มเกมส์เพื่อเริ่มรอบใหม่ (หัก Ante 50)');
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
  if (!room) return true;
  
  const realHumans = 
    room.players.filter(p => !p.isBot).length +
    room.waitingQueue.filter(p => !p.isBot).length +
    room.spectators.length;

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
  room.spectators = room.spectators.filter(u => u !== username);

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
  room.cardsDealt = false;
  clearTimeout(room.timer);
  
  const pName = USERS[username] ? (USERS[username].displayName || username) : username;
  io.to(roomCode).emit('game:need_start_click', `ผู้เล่น ${pName} ออกจากห้อง กดเริ่มเกมส์เพื่อเริ่มใหม่`);
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
      avatar: p.avatar || { hatStyle: 'cattleman', hatColor: '#4a2e18', skinTone: '#ffd1a4', sleeveColor: '#881337', badge: 'star' },
      isBot: p.isBot,
      isWaiting: false,
      lastBet: p.lastBet || 0
    })),
    ...room.waitingQueue.map(p => ({
      username: p.username,
      displayName: p.displayName || p.username,
      chips: p.chips,
      cardCount: 0,
      hand: [],
      avatar: p.avatar || { hatStyle: 'cattleman', hatColor: '#4a2e18', skinTone: '#ffd1a4', sleeveColor: '#881337', badge: 'star' },
      isBot: p.isBot,
      isWaiting: true,
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
    cardsDealt: room.cardsDealt,
    roundHistory: room.roundHistory || []
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server online on port ${PORT}`);
});
