const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// --- ฐานข้อมูล Memory / Persistent Store ---
const USERS = {
  // บัญชีแอดมินมาตรฐาน
  "admin": {
    username: "admin",
    password: "admin052063",
    role: "admin",
    chips: 100000,
    bankSavings: 0,
    bankDebt: 0,
    isBanned: false,
    lastDailyClaim: 0
  }
};

const ROOMS = {}; // เก็บสถานะห้องสดทั้งหมด

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

// จัดการการเชื่อมต่อ Socket
io.on('connection', (socket) => {
  let currentAuthUser = null;
  let currentRoomId = null;

  // 1. ระบบ Authentication
  socket.on('auth:register', ({ username, password }, cb) => {
    if (!username || !password) return cb({ success: false, msg: 'กรุณากรอกข้อมูลให้ครบ' });
    if (USERS[username]) return cb({ success: false, msg: 'ชื่อผู้ใช้นี้มีอยู่ในระบบแล้ว' });
    USERS[username] = {
      username,
      password,
      role: 'player',
      chips: 1000,
      bankSavings: 0,
      bankDebt: 0,
      isBanned: false,
      lastDailyClaim: 0
    };
    cb({ success: true, user: sanitizeUser(USERS[username]) });
  });

  socket.on('auth:login', ({ username, password }, cb) => {
    const user = USERS[username];
    if (!user || user.password !== password) {
      return cb({ success: false, msg: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    }
    if (user.isBanned) {
      return cb({ success: false, msg: 'บัญชีนี้ถูกระงับการใช้งานโดยผู้ดูแล' });
    }
    currentAuthUser = username;
    cb({ success: true, user: sanitizeUser(user) });
  });

  // 2. รับเงินประจำวัน 2,000 เหรียญ
  socket.on('user:claim_daily', (_, cb) => {
    if (!currentAuthUser) return cb({ success: false });
    const user = USERS[currentAuthUser];
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    if (user.lastDailyClaim && (now - user.lastDailyClaim < oneDay)) {
      const waitMs = oneDay - (now - user.lastDailyClaim);
      return cb({ success: false, msg: 'ยังไม่ถึงเวลารับเหรียญประจำวัน', waitMs });
    }
    user.chips += 2000;
    user.lastDailyClaim = now;
    cb({ success: true, chips: user.chips });
  });

  // แอดมิน: เร่งเวลา 1 วันสำหรับทดสอบ
  socket.on('admin:skip_day', (_, cb) => {
    if (!currentAuthUser || USERS[currentAuthUser].role !== 'admin') {
      return cb({ success: false, msg: 'ปฏิเสธสิทธิ์' });
    }
    const user = USERS[currentAuthUser];
    user.lastDailyClaim = 0; // รีเซ็ตให้กดรับได้ทันที
    // คำนวณดอกเบี้ยธนาคาร
    for (const u of Object.values(USERS)) {
      if (u.bankSavings > 0) u.bankSavings = Math.floor(u.bankSavings * 1.05);
      if (u.bankDebt > 0) u.bankDebt = Math.floor(u.bankDebt * 1.05);
    }
    cb({ success: true, user: sanitizeUser(user) });
  });

  // แอดมิน: จัดการผู้เล่น
  socket.on('admin:get_players', (_, cb) => {
    if (!currentAuthUser || USERS[currentAuthUser].role !== 'admin') return cb({ success: false });
    const list = Object.values(USERS).map(sanitizeUser);
    cb({ success: true, list });
  });

  socket.on('admin:mod_user', ({ targetUser, addChips, clearDebt, toggleBan }, cb) => {
    if (!currentAuthUser || USERS[currentAuthUser].role !== 'admin') return cb({ success: false });
    const u = USERS[targetUser];
    if (!u) return cb({ success: false, msg: 'ไม่พบบัญชี' });
    if (addChips) u.chips += Number(addChips);
    if (clearDebt) u.bankDebt = 0;
    if (toggleBan !== undefined) u.isBanned = toggleBan;
    cb({ success: true, user: sanitizeUser(u) });
  });

  // 3. ระบบธนาคาร (กู้-ฝาก ดอกเบี้ย 5%)
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
    cb({ success: true, user: sanitizeUser(u) });
  });

  // 4. ระบบห้องและกระดานเกม (FiwTeeTak Table Engine)
  socket.on('room:create', ({ roomName, maxPlayers, password, mode }, cb) => {
    if (!currentAuthUser) return cb({ success: false });
    const roomCode = Math.floor(100000 + Math.random() * 900000).toString();
    const newRoom = {
      code: roomCode,
      name: roomName || `Saloon #${roomCode}`,
      host: currentAuthUser,
      maxPlayers: parseInt(maxPlayers) || 6,
      password: password || null,
      mode: mode || 'human', // 'human' or 'bot'
      pot: 0,
      round: 1,
      deck: [],
      players: [],
      waitingQueue: [],
      activeTurnIndex: 0,
      dealerIndex: 0,
      isGameRunning: false,
      communityCardHistory: [],
      winningHistory: [],
      timer: null
    };

    ROOMS[roomCode] = newRoom;
    joinRoomInternal(socket, roomCode, currentAuthUser);
    cb({ success: true, roomCode });
    broadcastLobbyRooms();
  });

  socket.on('room:join', ({ roomCode, password }, cb) => {
    if (!currentAuthUser) return cb({ success: false });
    const room = ROOMS[roomCode];
    if (!room) return cb({ success: false, msg: 'ไม่พบห้องนี้' });
    if (room.password && room.password !== password) return cb({ success: false, msg: 'รหัสผ่านห้องไม่ถูกต้อง' });
    if (room.players.length + room.waitingQueue.length >= room.maxPlayers) {
      return cb({ success: false, msg: 'ห้องเต็มแล้ว' });
    }

    joinRoomInternal(socket, roomCode, currentAuthUser);
    cb({ success: true });
    broadcastLobbyRooms();
  });

  // กติกากดเริ่มเกมส์
  socket.on('game:start_click', () => {
    if (!currentRoomId) return;
    const room = ROOMS[currentRoomId];
    if (!room) return;

    // ดึงคนที่รออยู่ (ที่เข้ามาตอนกลางเกม) เข้าเล่นได้เมื่อกองกลางเป็น 0
    if (room.pot === 0 && room.waitingQueue.length > 0) {
      while (room.waitingQueue.length > 0 && room.players.length < room.maxPlayers) {
        room.players.push(room.waitingQueue.shift());
      }
    }

    if (room.players.length < 2 && room.mode === 'human') {
      return socket.emit('game:msg', 'ต้องมีผู้เล่นอย่างน้อย 2 คนเพื่อเริ่มเล่น');
    }

    startNewGameRound(room);
  });

  // รับการวางเดิมพัน (ไม่มีปุ่มผ่าน, ตรวจสอบ Min-Max ตามเงื่อนไขเป๊ะๆ)
  socket.on('game:bet', ({ amount }) => {
    if (!currentRoomId) return;
    const room = ROOMS[currentRoomId];
    if (!room || !room.isGameRunning) return;

    const player = room.players[room.activeTurnIndex];
    if (!player || player.username !== currentAuthUser) return;

    clearTimeout(room.timer);
    processPlayerBet(room, player, amount);
  });

  // แชทในห้อง
  socket.on('room:chat', (msg) => {
    if (!currentRoomId) return;
    io.to(currentRoomId).emit('room:new_chat', {
      sender: currentAuthUser,
      text: msg
    });
  });

  // ตัดการเชื่อมต่อ / ออกจากห้อง
  socket.on('disconnect', () => {
    if (currentRoomId) {
      handlePlayerLeave(socket, currentRoomId, currentAuthUser);
    }
  });
});

function sanitizeUser(u) {
  return {
    username: u.username,
    role: u.role,
    chips: u.chips,
    bankSavings: u.bankSavings,
    bankDebt: u.bankDebt,
    lastDailyClaim: u.lastDailyClaim
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
  socket.currentRoomId = roomCode;

  const playerObj = {
    username,
    chips: USERS[username].chips,
    hand: [],
    avatar: { hatStyle: 'cattleman', hatColor: '#4a2e18' },
    isWaiting: room.isGameRunning // เข้ากลางเกมต้องรอ Pot = 0
  };

  if (room.isGameRunning) {
    room.waitingQueue.push(playerObj);
  } else {
    room.players.push(playerObj);
  }

  // หากเป็นโหมดบอทและห้องยังว่าง ให้เติมบอท
  if (room.mode === 'bot' && room.players.length < room.maxPlayers) {
    const botNames = ['Wyatt', 'Jesse', 'Belle', 'Doc', 'Billy'];
    while (room.players.length < room.maxPlayers) {
      const bName = botNames[room.players.length % botNames.length] + `_${Math.floor(Math.random()*90+10)}`;
      room.players.push({
        username: bName,
        chips: 2000,
        hand: [],
        avatar: { hatStyle: 'sombrero', hatColor: '#8b0000' },
        isBot: true,
        isWaiting: false
      });
    }
  }

  emitRoomState(room);
}

function startNewGameRound(room) {
  room.isGameRunning = true;
  room.deck = createDeck();

  // 1. เก็บ Ante 50 เหรียญในรอบแรก หรือเมื่อกองกลางหมด (Pot = 0)
  if (room.pot === 0) {
    room.players.forEach(p => {
      const ante = Math.min(50, p.chips);
      p.chips -= ante;
      room.pot += ante;
      if (USERS[p.username]) USERS[p.username].chips = p.chips;
    });
  }

  // 2. แจกไพ่ 4 ใบให้ผู้เล่นในรอบ
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

  // แจ้งเริ่มนับถอยหลัง 20 วินาที
  io.to(room.code).emit('game:turn_start', {
    activeUsername: currentP.username,
    timeoutSec: 20
  });

  // บอทเล่นอัตโนมัติ
  if (currentP.isBot) {
    setTimeout(() => {
      const maxBet = Math.min(currentP.chips, room.pot);
      const betAmt = Math.min(Math.max(10, Math.floor(Math.random() * (maxBet - 10 + 1)) + 10), maxBet);
      processPlayerBet(room, currentP, betAmt);
    }, 1500);
    return;
  }

  // ผู้เล่นคน: หากไม่กดใน 20 วินาที บังคับเดิมพันขั้นต่ำ 10 เหรียญทันที
  room.timer = setTimeout(() => {
    processPlayerBet(room, currentP, 10);
  }, 20000);
}

function processPlayerBet(room, player, amount) {
  // บังคับกติกา Min-Max:
  // ต่ำสุด = 10, สูงสุด = เท่าที่ Pot มี หรือเท่าที่ผู้เล่นมี (ห้ามเกิน Pot)
  const maxPossible = Math.min(player.chips, room.pot);
  let finalBet = parseInt(amount) || 10;
  if (finalBet < 10) finalBet = 10;
  if (finalBet > maxPossible) finalBet = maxPossible;

  player.chips -= finalBet;
  if (USERS[player.username]) USERS[player.username].chips = player.chips;

  // เปิดไพ่กองกลาง 1 ใบ
  const communityCard = room.deck.pop() || createDeck().pop();
  room.communityCardHistory.unshift({
    card: communityCard,
    by: player.username,
    round: room.round
  });

  // ตรวจสอบไพ่ชนะ: ดอกเดียวกัน และ แต้มสูงกว่า (A ใหญ่สุด)
  // คัดเลือกเฉพาะใบที่แต้มเยอะที่สุด
  let highestWinningCard = null;
  player.hand.forEach(c => {
    if (c.suit === communityCard.suit && c.value > communityCard.value) {
      if (!highestWinningCard || c.value > highestWinningCard.value) {
        highestWinningCard = c;
      }
    }
  });

  const isWin = highestWinningCard !== null;
  let wonAmount = 0;

  if (isWin) {
    wonAmount = finalBet * 2; // ได้เงินเดิมพันตัวเองคืน + ดึงออกจาก Pot อีกเท่าตัว
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
    // แพ้: เงินเดิมพันเข้า Pot
    room.pot += finalBet;
  }

  // ส่งผลให้ทุกคนบนโต๊ะเห็น พร้อมแอนิเมชันเปิดไพ่ใบใหญ่สุดใบเดียวขึ้นกรอบทอง
  io.to(room.code).emit('game:showdown_result', {
    player: player.username,
    communityCard,
    winningCard: highestWinningCard,
    isWin,
    betAmount: finalBet,
    potNow: room.pot
  });

  // รอแสดงผล 3.5 วินาทีแล้วไปตาถัดไป
  setTimeout(() => {
    checkNextTurnOrRoundEnd(room);
  }, 3500);
}

function checkNextTurnOrRoundEnd(room) {
  // หาก Pot หมด (0) ทันที ให้จบรอบเพื่อเตรียมเก็บ Ante ใหม่
  if (room.pot <= 0) {
    room.pot = 0;
    room.isGameRunning = false;
    emitRoomState(room);
    io.to(room.code).emit('game:need_start_click', 'กองกลางหมดแล้ว! ผู้เล่นใหม่เข้าร่วมได้แล้ว กดเริ่มเกมส์เพื่อเริ่มรอบใหม่');
    return;
  }

  room.activeTurnIndex++;

  // เมื่อทุกคนเล่นครบ 1 รอบ
  if (room.activeTurnIndex >= room.players.length) {
    // ตรวจสอบเงื่อนไข 80% Pot Split (เมื่อ Pot >= ผู้เล่น x 400)
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

      io.to(room.code).emit('game:pot_split_jackpot', {
        amountDistributed: perPlayer * activeCount,
        perPlayer,
        remainingPot: room.pot
      });
    }

    // ผู้เล่นเหรียญหมด บังคับลุกออกจากโต๊ะ
    room.players = room.players.filter(p => p.chips > 0);

    // เลื่อนคนเริ่มคนแรก (Dealer) ตามเข็มนาฬิกา
    room.dealerIndex = (room.dealerIndex + 1) % Math.max(1, room.players.length);
    room.activeTurnIndex = room.dealerIndex;
    room.round++;

    // จบรอบแล้วเริ่มแจกไพ่รอบใหม่
    startNewGameRound(room);
  } else {
    // ตาของผู้เล่นคนถัดไป
    startTurnTimer(room);
    emitRoomState(room);
  }
}

function handlePlayerLeave(socket, roomCode, username) {
  const room = ROOMS[roomCode];
  if (!room) return;

  room.players = room.players.filter(p => p.username !== username);
  room.waitingQueue = room.waitingQueue.filter(p => p.username !== username);

  if (room.players.length === 0 && room.waitingQueue.length === 0) {
    delete ROOMS[roomCode];
  } else {
    // โอนหัวห้องอัตโนมัติหากหัวห้องออก
    if (room.host === username) {
      room.host = room.players[0] ? room.players[0].username : room.waitingQueue[0].username;
    }
    // มีคนออก ต้องกดเริ่มเกมส์ใหม่
    room.isGameRunning = false;
    io.to(roomCode).emit('game:need_start_click', `ผู้เล่น ${username} ออกจากห้อง กดเริ่มเกมส์เพื่อเริ่มใหม่`);
    emitRoomState(room);
  }
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
      // ส่งไพ่ให้เฉพาะเจ้าของดู
      hand: p.hand,
      isBot: p.isBot
    })),
    waitingCount: room.waitingQueue.length,
    activeTurnIndex: room.activeTurnIndex,
    dealerIndex: room.dealerIndex,
    isGameRunning: room.isGameRunning,
    historyCards: room.communityCardHistory,
    winningHistory: room.winningHistory
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`FiwTeeTak Saloon Online Server running on port ${PORT}`);
});