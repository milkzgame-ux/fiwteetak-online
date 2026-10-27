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

// ================= ระบบบันทึกและกู้คืนฐานข้อมูลไฟล์ JSON =================
const DB_FILE = path.join(__dirname, 'users_db.json');

// บัญชีเริ่มต้น (แอดมินมาตรฐาน)
const DEFAULT_USERS = {
  "admin": {
    username: "admin",
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

// ฟังก์ชันโหลดข้อมูลผู้ใช้จากไฟล์เมื่อ Server เริ่มรัน
function loadUsersDatabase() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      USERS = JSON.parse(data);
      console.log('✅ โหลดข้อมูลผู้เล่นเดิมจาก users_db.json สำเร็จ!');
    } else {
      USERS = { ...DEFAULT_USERS };
      saveUsersDatabase();
      console.log('สร้างไฟล์ฐานข้อมูลเริ่มต้น users_db.json เรียบร้อย');
    }
  } catch (err) {
    console.error('❌ ไม่สามารถอ่าน users_db.json ได้ รีเซ็ตใช้ค่าเริ่มต้น:', err);
    USERS = { ...DEFAULT_USERS };
  }

  // ป้องกันกรณีลืมหรือไม่มีบัญชีแอดมิน ให้คงอยู่เสมอ
  if (!USERS["admin"]) {
    USERS["admin"] = { ...DEFAULT_USERS["admin"] };
    saveUsersDatabase();
  }
}

// ฟังก์ชันบันทึกข้อมูลลงไฟล์ทุกครั้งที่มีการเปลี่ยนแปลง
function saveUsersDatabase() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(USERS, null, 2), 'utf8');
  } catch (err) {
    console.error('❌ บันทึกฐานข้อมูล users_db.json ล้มเหลว:', err);
  }
}

// โหลดข้อมูลเข้าสู่ระบบทันทีตอนเปิดเซิร์ฟเวอร์
loadUsersDatabase();

// ================= ตัวแปรเกมชั่วคราว =================
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
  return deck.sort(() => Math.random() - 0.5);
}

const BOT_PRESETS = [
  { name: 'Wyatt', hat: 'cattleman', hatColor: '#2b1d0c', skin: '#ffd1a4', sleeve: '#1e3a8a', badge: 'star' },
  { name: 'Jesse', hat: 'sombrero', hatColor: '#8b0000', skin: '#e0ac69', sleeve: '#14532d', badge: 'feather' },
  { name: 'Belle', hat: 'gambler', hatColor: '#1c1917', skin: '#fcd0a1', sleeve: '#581c87', badge: 'cards' },
  { name: 'Doc', hat: 'derby', hatColor: '#3d2817', skin: '#ffd1a4', sleeve: '#78350f', badge: 'cross' },
  { name: 'Billy', hat: 'cattleman', hatColor: '#713f12', skin: '#c68642', sleeve: '#047857', badge: 'star' },
  { name: 'Annie', hat: 'sombrero', hatColor: '#b45309', skin: '#fde047', sleeve: '#b91c1c', badge: 'feather' }
];

io.on('connection', (socket) => {
  let currentAuthUser = null;
  let currentRoomId = null;

  // 1. ระบบสมัครสมาชิก
  socket.on('auth:register', ({ username, password }, cb) => {
    if (!username || !password) return cb({ success: false, msg: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
    if (USERS[username]) return cb({ success: false, msg: 'ชื่อผู้ใช้นี้มีอยู่ในระบบแล้ว' });
    
    USERS[username] = {
      username,
      password,
      role: 'player',
      chips: 2000,
      bankSavings: 0,
      bankDebt: 0,
      isBanned: false,
      lastDailyClaim: 0,
      avatar: { hatStyle: 'cattleman', hatColor: '#4a2e18', skinTone: '#ffd1a4', sleeveColor: '#881337', badge: 'star' }
    };
    
    saveUsersDatabase(); // บันทึกลงไฟล์ทันที
    cb({ success: true, user: sanitizeUser(USERS[username]) });
  });

  // 2. ระบบเข้าสู่ระบบ (พร้อมเด้งเครื่องที่เข้าซ้อน)
  socket.on('auth:login', ({ username, password }, cb) => {
    const user = USERS[username];
    if (!user || user.password !== password) return cb({ success: false, msg: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    if (user.isBanned) return cb({ success: false, msg: 'บัญชีนี้ถูกระงับการใช้งาน' });

    if (ACTIVE_SESSIONS[username] && ACTIVE_SESSIONS[username] !== socket.id) {
      const oldSocket = io.sockets.sockets.get(ACTIVE_SESSIONS[username]);
      if (oldSocket) {
        oldSocket.emit('auth:force_logout', { msg: 'มีการเข้าสู่ระบบซ้อนจากอุปกรณ์อื่น' });
        if (oldSocket.currentRoomId) handlePlayerLeave(oldSocket, oldSocket.currentRoomId, username);
        oldSocket.disconnect(true);
      }
    }

    ACTIVE_SESSIONS[username] = socket.id;
    currentAuthUser = username;
    cb({ success: true, user: sanitizeUser(user) });
  });

  // อัปเดตอวาตาร์
  socket.on('user:update_avatar', ({ avatar }, cb) => {
    if (!currentAuthUser) return cb({ success: false });
    USERS[currentAuthUser].avatar = avatar;
    saveUsersDatabase(); // บันทึกชุดแต่งกาย

    if (currentRoomId && ROOMS[currentRoomId]) {
      const p = ROOMS[currentRoomId].players.find(x => x.username === currentAuthUser);
      if (p) p.avatar = avatar;
      emitRoomState(ROOMS[currentRoomId]);
    }
    cb({ success: true, avatar });
  });

  // แชทกลางล็อบบี้
  socket.on('chat:global_send', ({ text }) => {
    if (!currentAuthUser || !text.trim()) return;
    io.emit('chat:global_broadcast', {
      sender: currentAuthUser,
      text: text.trim().substring(0, 80),
      time: new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
    });
  });

  // แชทในโต๊ะเกม
  socket.on('chat:room_send', ({ text }) => {
    if (!currentRoomId || !currentAuthUser || !text.trim()) return;
    io.to(currentRoomId).emit('chat:room_broadcast', {
      sender: currentAuthUser,
      text: text.trim().substring(0, 50)
    });
  });

  // รับโบนัสรายวัน 2,000
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
    saveUsersDatabase(); // บันทึกยอดเงินใหม่
    cb({ success: true, chips: user.chips });
  });

  // แอดมิน: เร่งเวลา
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

  // แอดมิน: จัดการผู้เล่น
  socket.on('admin:get_players', (_, cb) => {
    if (!currentAuthUser || USERS[currentAuthUser].role !== 'admin') return cb({ success: false });
    cb({ success: true, list: Object.values(USERS).map(sanitizeUser) });
  });

  socket.on('admin:mod_user', ({ targetUser, addChips, clearDebt, toggleBan }, cb) => {
    if (!currentAuthUser || USERS[currentAuthUser].role !== 'admin') return cb({ success: false });
    const u = USERS[targetUser];
    if (!u) return cb({ success: false, msg: 'ไม่พบบัญชี' });
    if (addChips) u.chips += Number(addChips);
    if (clearDebt) u.bankDebt = 0;
    if (toggleBan !== undefined) u.isBanned = toggleBan;
    saveUsersDatabase();
    cb({ success: true, user: sanitizeUser(u) });
  });

  // ธนาคาร
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

  // สร้างห้อง
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
      communityCardHistory: [],
      winningHistory: [],
      timer: null
    };

    ROOMS[roomCode] = newRoom;
    currentRoomId = roomCode;
    socket.currentRoomId = roomCode;
    joinRoomInternal(socket, roomCode, currentAuthUser);
    cb({ success: true, roomCode });
    broadcastLobbyRooms();
  });

  // เข้าร่วมห้อง
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

  // ลุกจากโต๊ะ
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

  // นั่งลงเล่น
  socket.on('game:sit_down', () => {
    if (!currentRoomId || !ROOMS[currentRoomId]) return;
    const room = ROOMS[currentRoomId];
    if (room.players.length + room.waitingQueue.length >= room.maxPlayers) return;

    room.spectators = room.spectators.filter(u => u !== currentAuthUser);
    const pObj = {
      username: currentAuthUser,
      chips: USERS[currentAuthUser].chips,
      hand: [],
      avatar: USERS[currentAuthUser].avatar,
      isWaiting: room.isGameRunning
    };

    if (room.isGameRunning) {
      room.waitingQueue.push(pObj);
      socket.emit('game:msg', 'คุณกำลังรอรอบถัดไป (จะเข้าเล่นได้เมื่อ Pot กองกลางหมดเหลือ 0)');
    } else {
      room.players.push(pObj);
    }

    emitRoomState(room);
  });

  // เริ่มเกมส์
  socket.on('game:start_click', () => {
    if (!currentRoomId || !ROOMS[currentRoomId]) return;
    const room = ROOMS[currentRoomId];

    if (room.pot === 0 && room.waitingQueue.length > 0) {
      while (room.waitingQueue.length > 0 && room.players.length < room.maxPlayers) {
        room.players.push(room.waitingQueue.shift());
      }
    }
    startNewGameRound(room);
  });

  // วางเดิมพัน
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
    if (socket.currentRoomId) handlePlayerLeave(socket, socket.currentRoomId, currentAuthUser);
  });
});

function sanitizeUser(u) {
  return {
    username: u.username,
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
    players: r.players.length + r.waitingQueue.length,
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
    chips: USERS[username].chips,
    hand: [],
    avatar: USERS[username].avatar || { hatStyle: 'cattleman', hatColor: '#4a2e18', skinTone: '#ffd1a4', sleeveColor: '#881337', badge: 'star' },
    isWaiting: room.isGameRunning,
    lastBet: 0
  };

  if (room.isGameRunning) {
    room.waitingQueue.push(playerObj);
    socket.emit('game:msg', 'คุณเข้าห้องกลางเกม! ต้องรอกองกลาง (Pot) หมดก่อนจึงจะเข้าร่วมเล่นและรับปันผลได้');
  } else {
    room.players.push(playerObj);
  }

  // เติมบอท
  if (room.mode === 'bot' && (room.players.length + room.waitingQueue.length) < room.maxPlayers) {
    let botIdx = 0;
    while ((room.players.length + room.waitingQueue.length) < room.maxPlayers) {
      const bData = BOT_PRESETS[botIdx % BOT_PRESETS.length];
      const bName = `${bData.name}_${Math.floor(Math.random()*90+10)}`;
      room.players.push({
        username: bName,
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
    io.to(room.code).emit('game:need_start_click', 'โต๊ะพร้อมแล้ว! กดเริ่มเกมส์เพื่อเริ่มเล่นรอบแรก (หัก Ante 50)');
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
    saveUsersDatabase(); // บันทึกชิปที่ถูกหัก Ante
  }

  room.players.forEach(p => {
    p.hand = [room.deck.pop(), room.deck.pop(), room.deck.pop(), room.deck.pop()];
  });

  room.activeTurnIndex = room.dealerIndex;
  emitRoomState(room);
  startTurnTimer(room);
}

function startTurnTimer(room) {
  clearTimeout(room.timer);
  const currentP = room.players[room.activeTurnIndex];
  if (!currentP) return;

  io.to(room.code).emit('game:turn_start', {
    activeUsername: currentP.username,
    timeoutSec: 20
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
  }, 20000);
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
  room.communityCardHistory.unshift({
    card: communityCard,
    by: player.username,
    round: room.round
  });

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

    room.winningHistory.unshift({
      winner: player.username,
      winningCard: highestWinningCard,
      communityCard: communityCard,
      amount: finalBet,
      round: room.round
    });
  } else {
    room.pot += finalBet;
  }

  saveUsersDatabase(); // บันทึกยอดเหรียญหลังการตัดสิน

  io.to(room.code).emit('game:showdown_result', {
    player: player.username,
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
  if (room.pot <= 0) {
    room.pot = 0;
    room.isGameRunning = false;
    emitRoomState(room);
    io.to(room.code).emit('game:need_start_click', 'กองกลางหมดแล้ว! ผู้เล่นใหม่เข้าร่วมได้แล้ว กดเริ่มเกมส์เพื่อเริ่มรอบใหม่');
    return;
  }

  room.activeTurnIndex++;

  if (room.activeTurnIndex >= room.players.length) {
    // กองกลางแตกปันผล 80%
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
      saveUsersDatabase(); // บันทึกเงินปันผล

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
    room.players.filter(p => !p.isBot).length +
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

  socket.leave(roomCode);
  socket.currentRoomId = null;

  if (checkAndCleanEmptyRoom(roomCode)) return;

  if (room.host === username) {
    const nextH = room.players.find(p => !p.isBot) || room.waitingQueue.find(p => !p.isBot);
    if (nextH) room.host = nextH.username;
  }

  room.isGameRunning = false;
  clearTimeout(room.timer);
  io.to(roomCode).emit('game:need_start_click', `ผู้เล่น ${username} ออกจากห้อง กดเริ่มเกมส์เพื่อเริ่มรอบใหม่`);
  emitRoomState(room);
  broadcastLobbyRooms();
}

function emitRoomState(room) {
  io.to(room.code).emit('game:state_sync', {
    code: room.code,
    name: room.name,
    host: room.host,
    pot: room.pot,
    round: room.round,
    players: room.players.map(p => ({
      username: p.username,
      chips: p.chips,
      cardCount: p.hand.length,
      hand: p.hand,
      avatar: p.avatar,
      isBot: p.isBot,
      lastBet: p.lastBet || 0
    })),
    waitingCount: room.waitingQueue.length,
    spectators: room.spectators,
    activeTurnIndex: room.activeTurnIndex,
    dealerIndex: room.dealerIndex,
    isGameRunning: room.isGameRunning,
    historyCards: room.communityCardHistory,
    winningHistory: room.winningHistory
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`FiwTeeTak Server with Persistent DB running on port ${PORT}`);
});
