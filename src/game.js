'use strict';
// Avalon 6-player rules engine. All state mutation goes through applyAction(),
// which validates every action against the current phase and the acting player.
// Node runs this synchronously on a single thread, so each action is atomic.

const crypto = require('crypto');

const PLAYER_COUNT = 6;
const MISSION_SIZES = [2, 3, 4, 3, 4];
const APPROVALS_NEEDED = 4;
const MAX_REJECTS = 5;
const WINS_NEEDED = 3;
const NAME_MAX = 12;

const ROLES = {
  merlin: { name: '梅林 Merlin', team: 'good', desc: '你知道谁是坏人，但不能暴露自己。好人三次任务成功后，刺客会尝试刺杀你。' },
  servant: { name: '亚瑟的忠臣 Loyal Servant', team: 'good', desc: '你没有特殊能力。通过讨论与投票找出坏人，只能提交成功牌。' },
  assassin: { name: '刺客 Assassin', team: 'evil', desc: '你认识你的同伴。可以提交成功或失败牌。若好人完成三次任务，由你刺杀梅林。' },
  minion: { name: '莫德雷德爪牙 Minion of Mordred', team: 'evil', desc: '你认识你的同伴。可以提交成功或失败牌，帮助任务失败。' },
};
const ROLE_DECK = ['merlin', 'servant', 'servant', 'servant', 'assassin', 'minion'];
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

class GameError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const fail = (code, msg) => { throw new GameError(code, msg); };

function randInt(n) { return crypto.randomInt(n); }
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function newId(bytes = 16) { return crypto.randomBytes(bytes).toString('hex'); }

function generateCode(existing) {
  for (;;) {
    let c = '';
    for (let i = 0; i < 5; i++) c += CODE_ALPHABET[randInt(CODE_ALPHABET.length)];
    if (!existing.has(c)) return c;
  }
}
function isValidCode(code) {
  return typeof code === 'string' && /^[A-HJ-NP-Z2-9]{5}$/.test(code);
}

function cleanName(name) {
  if (typeof name !== 'string') fail('bad_name', '请输入昵称');
  const n = name.replace(/[\u0000-\u001f<>]/g, '').trim();
  if (!n) fail('bad_name', '请输入昵称');
  if ([...n].length > NAME_MAX) fail('bad_name', `昵称最多 ${NAME_MAX} 个字符`);
  return n;
}

function createRoom(code, hostName) {
  const room = {
    code,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    version: 0,
    gameNo: 0,
    status: 'lobby', // lobby | playing | ended
    hostId: null,
    players: [],
    game: null,
  };
  const host = addPlayer(room, hostName);
  room.hostId = host.id;
  return { room, player: host };
}

function addPlayer(room, rawName) {
  const name = cleanName(rawName);
  if (room.status !== 'lobby') fail('started', '游戏已开始，无法加入');
  if (room.players.length >= PLAYER_COUNT) fail('full', '房间已满（6/6）');
  if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) fail('name_taken', '昵称已被使用，请换一个');
  const player = { id: 'p' + newId(6), token: newId(24), name, ready: false };
  room.players.push(player);
  touch(room);
  return player;
}

function touch(room) { room.version++; room.updatedAt = Date.now(); }

function findByToken(room, token) {
  if (typeof token !== 'string') return null;
  return room.players.find(p => p.token === token) || null;
}

function startGame(room) {
  const roles = shuffle(ROLE_DECK);
  const order = shuffle(room.players.map(p => p.id)); // random seating for leader rotation
  room.gameNo++;
  room.status = 'playing';
  room.game = {
    phase: 'reveal', // reveal | team | vote | mission | assassin | ended
    seats: order,
    roles: Object.fromEntries(order.map((id, i) => [id, roles[i]])),
    acks: [],
    leaderIdx: randInt(PLAYER_COUNT),
    round: 0, // 0-based
    successes: 0,
    fails: 0,
    rejects: 0,
    team: [],
    votes: {},
    cards: {},
    history: MISSION_SIZES.map((size, i) => ({ round: i + 1, size, attempts: [], result: null })),
    assassination: null,
    winner: null,
    reason: null,
  };
}

function endGame(room, winner, reason) {
  const g = room.game;
  g.phase = 'ended';
  g.winner = winner;
  g.reason = reason;
  room.status = 'ended';
}

function leaderId(g) { return g.seats[g.leaderIdx]; }
function nextLeader(g) { g.leaderIdx = (g.leaderIdx + 1) % PLAYER_COUNT; }

function applyAction(room, player, action) {
  if (!player) fail('auth', '无效的玩家会话');
  if (!action || typeof action.type !== 'string') fail('bad_action', '无效操作');
  const g = room.game;
  const need = (cond, code, msg) => { if (!cond) fail(code, msg); };
  const needPhase = (ph) => need(room.status === 'playing' && g && g.phase === ph, 'bad_phase', '当前阶段不能执行此操作');

  switch (action.type) {
    case 'ready': {
      need(room.status === 'lobby', 'bad_phase', '游戏已开始');
      player.ready = !!action.value;
      break;
    }
    case 'leave': {
      need(room.status === 'lobby', 'bad_phase', '游戏进行中不能离开房间');
      room.players = room.players.filter(p => p.id !== player.id);
      if (room.hostId === player.id) room.hostId = room.players[0] ? room.players[0].id : null;
      break;
    }
    case 'start': {
      need(room.status === 'lobby', 'bad_phase', '游戏已开始');
      need(room.hostId === player.id, 'forbidden', '只有房间创建者可以开始游戏');
      need(room.players.length === PLAYER_COUNT, 'not_full', '需要 6 名玩家才能开始');
      need(room.players.every(p => p.ready), 'not_ready', '还有玩家未准备');
      startGame(room);
      break;
    }
    case 'ack': {
      needPhase('reveal');
      need(!g.acks.includes(player.id), 'duplicate', '你已确认身份');
      g.acks.push(player.id);
      if (g.acks.length === PLAYER_COUNT) g.phase = 'team';
      break;
    }
    case 'propose': {
      needPhase('team');
      need(leaderId(g) === player.id, 'forbidden', '只有当前队长可以提名队伍');
      const team = action.team;
      const size = MISSION_SIZES[g.round];
      need(Array.isArray(team), 'bad_team', '无效的队伍');
      const uniq = [...new Set(team)];
      need(uniq.length === team.length && uniq.every(id => g.seats.includes(id)), 'bad_team', '队伍包含无效玩家');
      need(uniq.length === size, 'bad_team', `本轮必须选择 ${size} 人`);
      g.team = g.seats.filter(id => uniq.includes(id));
      g.votes = {};
      g.phase = 'vote';
      break;
    }
    case 'vote': {
      needPhase('vote');
      need(!(player.id in g.votes), 'duplicate', '你已经投过票');
      need(typeof action.approve === 'boolean', 'bad_vote', '无效的投票');
      g.votes[player.id] = action.approve;
      if (Object.keys(g.votes).length === PLAYER_COUNT) resolveVote(room);
      break;
    }
    case 'mission': {
      needPhase('mission');
      need(g.team.includes(player.id), 'forbidden', '你不在本轮任务队伍中');
      need(!(player.id in g.cards), 'duplicate', '你已经提交过任务牌');
      need(action.card === 'success' || action.card === 'fail', 'bad_card', '无效的任务牌');
      if (action.card === 'fail') need(ROLES[g.roles[player.id]].team === 'evil', 'forbidden', '好人只能提交成功牌');
      g.cards[player.id] = action.card;
      if (Object.keys(g.cards).length === g.team.length) resolveMission(room);
      break;
    }
    case 'assassinate': {
      needPhase('assassin');
      need(g.roles[player.id] === 'assassin', 'forbidden', '只有刺客可以执行刺杀');
      need(typeof action.target === 'string' && g.seats.includes(action.target), 'bad_target', '无效的目标');
      need(action.target !== player.id, 'bad_target', '刺客不能选择自己');
      const hit = g.roles[action.target] === 'merlin';
      g.assassination = { target: action.target, hit };
      if (hit) endGame(room, 'evil', '刺客成功刺杀梅林');
      else endGame(room, 'good', '好人完成三次任务，且刺客未能找出梅林');
      break;
    }
    case 'restart': {
      need(room.status === 'ended', 'bad_phase', '游戏尚未结束');
      need(room.hostId === player.id, 'forbidden', '只有房间创建者可以重新开始');
      room.status = 'lobby';
      room.game = null;
      room.players.forEach(p => { p.ready = false; });
      break;
    }
    default:
      fail('bad_action', '未知操作');
  }
  touch(room);
}

function resolveVote(room) {
  const g = room.game;
  const approve = Object.values(g.votes).filter(v => v).length;
  const passed = approve >= APPROVALS_NEEDED;
  g.history[g.round].attempts.push({
    leader: leaderId(g),
    team: g.team.slice(),
    approve,
    reject: PLAYER_COUNT - approve,
    passed,
  });
  g.votes = {};
  if (passed) {
    g.cards = {};
    g.phase = 'mission';
    return;
  }
  g.rejects++;
  g.team = [];
  if (g.rejects >= MAX_REJECTS) return endGame(room, 'evil', '连续 5 次组队被否决');
  nextLeader(g);
  g.phase = 'team';
}

function resolveMission(room) {
  const g = room.game;
  const failCount = Object.values(g.cards).filter(c => c === 'fail').length;
  const success = failCount === 0;
  g.history[g.round].result = {
    team: g.team.slice(),
    successCards: g.team.length - failCount,
    failCards: failCount,
    success,
  };
  g.cards = {};
  g.team = [];
  g.rejects = 0;
  if (success) g.successes++; else g.fails++;
  if (g.fails >= WINS_NEEDED) return endGame(room, 'evil', '坏人造成三次任务失败');
  if (g.successes >= WINS_NEEDED) { g.phase = 'assassin'; return; }
  g.round++;
  nextLeader(g);
  g.phase = 'team';
}

// The only function that produces data for clients. It never includes other
// players' tokens, roles, votes or mission cards except where the rules allow.
function viewFor(room, player, online = new Set()) {
  const g = room.game;
  const name = id => (room.players.find(p => p.id === id) || {}).name || '?';
  const order = g ? g.seats : room.players.map(p => p.id);
  const view = {
    code: room.code,
    version: room.version,
    gameNo: room.gameNo,
    status: room.status,
    hostId: room.hostId,
    me: { id: player.id, name: player.name, isHost: room.hostId === player.id },
    players: order.map(id => {
      const p = room.players.find(x => x.id === id);
      return { id, name: p.name, ready: p.ready, online: online.has(id) };
    }),
    missionSizes: MISSION_SIZES,
  };
  if (!g) return view;

  const role = g.roles[player.id];
  const info = ROLES[role];
  let knows = [];
  if (role === 'merlin') knows = g.seats.filter(id => ROLES[g.roles[id]].team === 'evil');
  else if (info.team === 'evil') knows = g.seats.filter(id => id !== player.id && ROLES[g.roles[id]].team === 'evil');
  view.secret = {
    role,
    roleName: info.name,
    team: info.team,
    desc: info.desc,
    knows: knows.map(id => ({ id, name: name(id) })),
    knowsLabel: role === 'merlin' ? '你看到的坏人' : info.team === 'evil' ? '你的坏人同伴' : null,
  };

  Object.assign(view, {
    phase: g.phase,
    round: g.round + 1,
    teamSize: MISSION_SIZES[g.round],
    leaderId: leaderId(g),
    successes: g.successes,
    fails: g.fails,
    rejects: g.rejects,
    team: g.team.slice(),
    history: g.history,
    acked: g.acks.slice(),
  });
  if (g.phase === 'vote') {
    view.votedIds = Object.keys(g.votes);
    if (player.id in g.votes) view.myVote = g.votes[player.id];
  }
  if (g.phase === 'mission') {
    view.submittedCount = Object.keys(g.cards).length;
    view.mySubmitted = player.id in g.cards;
  }
  if (g.phase === 'ended') {
    view.winner = g.winner;
    view.reason = g.reason;
    view.assassination = g.assassination;
    view.reveal = g.seats.map(id => ({ id, name: name(id), role: g.roles[id], roleName: ROLES[g.roles[id]].name, team: ROLES[g.roles[id]].team }));
  } else if (g.assassination) {
    view.assassination = g.assassination;
  }
  return view;
}

module.exports = {
  PLAYER_COUNT, MISSION_SIZES, ROLES, ROLE_DECK, GameError,
  createRoom, addPlayer, applyAction, viewFor, findByToken, generateCode, isValidCode, cleanName,
};
