const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const USERS = {
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

io.on('connection', (socket) => {
  let currentAuthUser = null;
  let currentRoomId = null;

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

  socket.on('admin:skip_day', (_, cb) => {
    if (!currentAuthUser || USERS[currentAuthUser].role !== 'admin') {
      return cb({ success: false, msg: 'ปฏิเสธสิทธิ์' });
    }
    const user = USERS[currentAuthUser];
    user.lastDailyClaim = 0;
    for (const u of Object.values(USERS)) {
      if (u.bankSavings > 0) u.bankSavings = Math.floor(u.bankSavings * 1.05);
      if (u.bankDebt > 0) u.bankDebt = Math.floor(u.bankDebt * 1.05);
    }
    cb({ success: true, user: sanitizeUser(user) });
  });

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

  // ระบบห้อง
  socket.on('room:create', ({ roomName, maxPlayers, password, mode }, cb) => {
    if (!currentAuthUser) return cb({ success: false });
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
      spectators: [], // ผู้ชม / คนที่ลุกจากโต๊ะ
      activeTurnIndex: 0,
      dealerIndex: 0,
      isGameRunning: false,
      communityCardHistory: [],
      winningHistory: [],
      timer: null
    };

    ROOMS[roomCode] = newRoom;
    currentRoomId = roomCode;
    joinRoomInternal(socket, roomCode, currentAuthUser);
    cb({ success: true, roomCode });
    broadcastLobbyRooms();
  });

  socket.on('room:join', ({ roomCode, password }, cb) => {
    if (!currentAuthUser) return cb({ success: false });
    const room = ROOMS[roomCode];
    if (!room) return cb({ success: false, msg: 'ไม่พบห้องนี้ หรือห้องถูกลบแล้ว' });
    if (room.password && room.password !== password) return cb({ success: false, msg: 'รหัสผ่านห้องไม่ถูกต้อง' });
    if (room.players.length + room.waitingQueue.length >= room.maxPlayers) {
      return cb({ success: false, msg: 'ที่นั่งบนโต๊ะเต็มแล้ว' });
    }

    currentRoomId = roomCode;
    joinRoomInternal(socket, roomCode, currentAuthUser);
    cb({ success: true });
    broadcastLobbyRooms();
  });

  // ระบบ "ลุกจากโต๊ะ"
  socket.on('game:stand_up', () => {
    if (!currentRoomId) return;
    const room = ROOMS[currentRoomId];
    if (!room) return;

    // หาว่าอยู่ใน players หรือ waitingQueue
    const pIdx = room.players.findIndex(p => p.username === currentAuthUser);
    if (pIdx !== -1) {
      room.players.splice(pIdx, 1);
      room.spectators.push(currentAuthUser);

      // ถ้าเป็นตาของคนที่ลุกพอดี ให้ข้ามไปตาถัดไป
      if (room.isGameRunning) {
        if (room.activeTurnIndex >= room.players.length) {
          room.activeTurnIndex = 0;
        }
        clearTimeout(room.timer);
        checkNextTurnOrRoundEnd(room);
      }
    } else {
      const wIdx = room.waitingQueue.findIndex(p => p.username === currentAuthUser);
      if (wIdx !== -1) {
        room.waitingQueue.splice(wIdx, 1);
        room.spectators.push(currentAuthUser);
      }
    }

    emitRoomState(room);
    checkAndCleanEmptyRoom(currentRoomId);
  });

  // ระบบ "นั่งลงเล่นที่โต๊ะ"
  socket.on('game:sit_down', () => {
    if (!currentRoomId) return;
    const room = ROOMS[currentRoomId];
    if (!room) return;

    if (room.players.length + room.waitingQueue.length >= room.maxPlayers) {
      return socket.emit('game:msg', 'โต๊ะเต็มแล้ว ไม่สามารถนั่งได้');
    }

    room.spectators = room.spectators.filter(u => u !== currentAuthUser);

    const playerObj = {
      username: currentAuthUser,
      chips: USERS[currentAuthUser].chips,
      hand: [],
      isWaiting: room.isGameRunning // ถ้าเกมกำลังเล่นอยู่ ต้องรอ Pot = 0 ก่อน
    };

    if (room.isGameRunning) {
      room.waitingQueue.push(playerObj);
    } else {
      room.players.push(playerObj);
    }

    emitRoomState(room);
  });

  socket.on('game:start_click', () => {
    if (!currentRoomId) return;
    const room = ROOMS[currentRoomId];
    if (!room) return;

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

  socket.on('game:bet', ({ amount }) => {
    if (!currentRoomId) return;
    const room = ROOMS[currentRoomId];
    if (!room || !room.isGameRunning) return;

    const player = room.players[room.activeTurnIndex];
    if (!player || player.username !== currentAuthUser) return;

    clearTimeout(room.timer);
    processPlayerBet(room, player, amount);
  });

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

  const playerObj = {
    username,
    chips: USERS[username].chips,
    hand: [],
    isWaiting: room.isGameRunning
  };

  if (room.isGameRunning) {
    room.waitingQueue.push(playerObj);
  } else {
    room.players.push(playerObj);
  }

  if (room.mode === 'bot' && room.players.length < room.maxPlayers) {
    const botNames = ['Wyatt', 'Jesse', 'Belle', 'Doc', 'Billy'];
    while (room.players.length < room.maxPlayers) {
      const bName = botNames[room.players.length % botNames.length] + `_${Math.floor(Math.random()*90+10)}`;
      room.players.push({
        username: bName,
        chips: 2000,
        hand: [],
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

  if (room.pot === 0) {
    room.players.forEach(p => {
      const ante = Math.min(50, p.chips);
      p.chips -= ante;
      room.pot += ante;
      if (USERS[p.username]) USERS[p.username].chips = p.chips;
    });
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
    }, 1500);
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

// ตรวจสอบและลบห้องทิ้งหากไม่มีผู้เล่นคนจริงเหลืออยู่เลย
function checkAndCleanEmptyRoom(roomCode) {
  const room = ROOMS[roomCode];
  if (!room) return;

  const realHumans = room.players.filter(p => !p.isBot).length + room.waitingQueue.filter(p => !p.isBot).length + room.spectators.length;
  if (realHumans === 0) {
    clearTimeout(room.timer);
    delete ROOMS[roomCode];
    broadcastLobbyRooms();
  }
}

function handlePlayerLeave(socket, roomCode, username) {
  const room = ROOMS[roomCode];
  if (!room) return;

  room.players = room.players.filter(p => p.username !== username);
  room.waitingQueue = room.waitingQueue.filter(p => p.username !== username);
  room.spectators = room.spectators.filter(u => u !== username);

  if (room.host === username) {
    const nextH = room.players[0] || room.waitingQueue[0];
    if (nextH) room.host = nextH.username;
  }

  checkAndCleanEmptyRoom(roomCode);

  if (ROOMS[roomCode]) {
    room.isGameRunning = false;
    io.to(roomCode).emit('game:need_start_click', `ผู้เล่น ${username} ออกจากห้อง กดเริ่มเกมส์เพื่อเริ่มรอบใหม่`);
    emitRoomState(room);
    broadcastLobbyRooms();
  }
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
      isBot: p.isBot
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
  console.log(`Server online on port ${PORT}`);
});
