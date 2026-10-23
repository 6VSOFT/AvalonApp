'use strict';
// Avalon rules engine (5–10 players). All state mutation goes through applyAction(),
// which validates every action against the current phase and the acting player.
// Node runs this synchronously on a single thread, so each action is atomic.

const crypto = require('crypto');

const MIN_PLAYERS = 5;
const MAX_PLAYERS = 10;
const MAX_REJECTS = 5;
const WINS_NEEDED = 3;
const NAME_MAX = 12;

// Official board per player count. Round 4 needs two fail cards with 7+ players.
const BOARDS = {
  5: { good: 3, evil: 2, missions: [2, 3, 2, 3, 3] },
  6: { good: 4, evil: 2, missions: [2, 3, 4, 3, 4] },
  7: { good: 4, evil: 3, missions: [2, 3, 3, 4, 4] },
  8: { good: 5, evil: 3, missions: [3, 4, 4, 5, 5] },
  9: { good: 6, evil: 3, missions: [3, 4, 4, 5, 5] },
  10: { good: 6, evil: 4, missions: [3, 4, 4, 5, 5] },
};
const failsNeeded = (size, round) => (size >= 7 && round === 3 ? 2 : 1);

// `short` labels the preview chips; `ability` and `tip` are the public role guide.
const ROLES = {
  merlin: { name: '梅林 Merlin', short: '梅林', ability: '看见红方，但看不见莫德雷德', tip: '谨慎引导好人完成任务，但避免暴露身份被刺杀', team: 'good', desc: '你知道坏人是谁（莫德雷德除外），但不能暴露自己。好人三次任务成功后，刺客会尝试刺杀你。' },
  percival: { name: '派西维尔 Percival', short: '派西维尔', ability: '看到梅林与莫甘娜两名候选', tip: '通过发言和投票辨别真正的梅林，帮助蓝方阵营', team: 'good', desc: '你会看到梅林和莫甘娜，但无法分辨谁是真梅林。你的任务是保护梅林。' },
  servant: { name: '亚瑟的忠臣 Loyal Servant', short: '忠臣', ability: '无特殊视野', tip: '通过讨论、投票和任务结果找出红方', team: 'good', desc: '你没有特殊能力。通过讨论与投票找出坏人，只能提交成功牌。' },
  assassin: { name: '刺客 Assassin', short: '刺客', ability: '在蓝方达成 3 次成功后刺杀梅林', tip: '帮助红方让任务失败，或在最后刺中梅林', team: 'evil', desc: '你认识你的同伴。可以提交成功或失败牌。若好人完成三次任务，由你刺杀梅林。' },
  morgana: { name: '莫甘娜 Morgana', short: '莫甘娜', ability: '伪装成梅林出现在派西维尔的视野中', tip: '模仿梅林的发言，误导派西维尔和蓝方', team: 'evil', desc: '你在派西维尔眼中看起来像梅林。认识你的同伴，可以提交成功或失败牌。' },
  mordred: { name: '莫德雷德 Mordred', short: '莫德雷德', ability: '对梅林隐藏身份', tip: '大胆带队，梅林看不见你', team: 'evil', desc: '梅林看不到你。你认识你的同伴，可以提交成功或失败牌。' },
  oberon: { name: '奥伯伦 Oberon', short: '奥伯伦', ability: '与其他红方互不相认，但梅林能看见你', tip: '独立行动扰乱局势', team: 'evil', desc: '你不认识其他坏人，他们也不认识你，但梅林能看到你。可以提交成功或失败牌。' },
  minion: { name: '莫德雷德爪牙 Minion', short: '爪牙', ability: '无特殊能力，认识其他红方', tip: '配合其他红方，让任务失败', team: 'evil', desc: '你认识你的同伴。可以提交成功或失败牌，帮助任务失败。' },
};

const rep = (role, n) => Array(n).fill(role);
// Role presets per player count; the first one is the default.
// Role order is the order the preview chips are shown in.
const PRESETS = {
  5: [
    { id: 'standard', name: '标准局', roles: ['merlin', 'percival', 'servant', 'morgana', 'assassin'] },
    { id: 'no_percival', name: '无派西维尔局', roles: ['merlin', ...rep('servant', 2), 'morgana', 'assassin'] },
  ],
  6: [
    { id: 'standard', name: '标准局', roles: ['merlin', 'percival', ...rep('servant', 2), 'morgana', 'assassin'] },
    { id: 'mordred', name: '莫德雷德局', roles: ['merlin', 'percival', ...rep('servant', 2), 'mordred', 'assassin'] },
  ],
  7: [
    { id: 'standard', name: '标准局', roles: ['merlin', 'percival', ...rep('servant', 2), 'morgana', 'oberon', 'assassin'] },
    { id: 'mordred', name: '莫德雷德局', roles: ['merlin', 'percival', ...rep('servant', 2), 'mordred', 'morgana', 'assassin'] },
  ],
  8: [
    { id: 'standard', name: '标准局', roles: ['merlin', 'percival', ...rep('servant', 3), 'morgana', 'assassin', 'minion'] },
    { id: 'oberon', name: '奥伯伦局', roles: ['merlin', 'percival', ...rep('servant', 3), 'morgana', 'assassin', 'oberon'] },
  ],
  9: [
    { id: 'standard', name: '标准局', roles: ['merlin', 'percival', ...rep('servant', 4), 'mordred', 'morgana', 'assassin'] },
    { id: 'oberon', name: '奥伯伦局', roles: ['merlin', 'percival', ...rep('servant', 4), 'morgana', 'assassin', 'oberon'] },
  ],
  10: [
    { id: 'standard', name: '标准局', roles: ['merlin', 'percival', ...rep('servant', 4), 'mordred', 'morgana', 'oberon', 'assassin'] },
    { id: 'minion', name: '爪牙局', roles: ['merlin', 'percival', ...rep('servant', 4), 'morgana', 'assassin', 'oberon', 'minion'] },
  ],
};
const REJECT_RULES = {
  evil_wins: '坏人直接获胜',
  forced: '进入强制轮',
};
const DEFAULT_CONFIG = { size: 6, preset: 'standard', rejectRule: 'forced' };
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

function presetFor(config) {
  return (PRESETS[config.size] || []).find(p => p.id === config.preset) || null;
}
// Validates a (possibly partial) config from a client, filling gaps from `base`.
function cleanConfig(input, base = DEFAULT_CONFIG) {
  const given = input && typeof input === 'object' ? input : {};
  const c = { ...base, ...given };
  const size = Number(c.size);
  if (!Number.isInteger(size) || !BOARDS[size]) fail('bad_config', `人数必须在 ${MIN_PLAYERS}–${MAX_PLAYERS} 之间`);
  let preset = c.preset;
  if (!PRESETS[size].some(p => p.id === preset)) {
    if (given.preset !== undefined) fail('bad_config', '无效的角色预设');
    preset = PRESETS[size][0].id; // size changed and the old preset doesn't exist for it
  }
  if (!REJECT_RULES[c.rejectRule]) fail('bad_config', '无效的流局规则');
  return { size, preset, rejectRule: c.rejectRule };
}

function createRoom(code, hostName, config) {
  const room = {
    code,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    version: 0,
    gameNo: 0,
    status: 'lobby', // lobby | playing | ended
    hostId: null,
    config: cleanConfig(config),
    players: [], // each has a seat 0..size-1; the lobby list is the seating order
    swaps: {}, // pending seat-swap requests: requester id -> target id
    game: null,
  };
  const host = addPlayer(room, hostName);
  room.hostId = host.id;
  return { room, player: host };
}

function addPlayer(room, rawName) {
  const name = cleanName(rawName);
  if (room.status !== 'lobby') fail('started', '游戏已开始，无法加入');
  if (room.players.length >= room.config.size) fail('full', `房间已满（${room.config.size}/${room.config.size}）`);
  if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) fail('name_taken', '昵称已被使用，请换一个');
  const player = { id: 'p' + newId(6), token: newId(24), name, ready: false, seat: freeSeat(room) };
  room.players.push(player);
  touch(room);
  return player;
}

function freeSeat(room) {
  const taken = new Set(room.players.map(p => p.seat));
  for (let s = 0; ; s++) if (!taken.has(s)) return s;
}
// After the table shrinks, anyone sitting beyond it moves to the lowest free seat.
function compactSeats(room) {
  for (const p of room.players.filter(x => x.seat >= room.config.size).sort((a, b) => a.seat - b.seat)) {
    p.seat = -1;
    p.seat = freeSeat({ players: room.players.filter(x => x.seat >= 0) });
  }
}
function clearSwaps(room, playerId) {
  room.swaps = room.swaps || {};
  for (const [from, to] of Object.entries(room.swaps)) if (from === playerId || to === playerId) delete room.swaps[from];
}
const bySeat = players => players.slice().sort((a, b) => a.seat - b.seat);

// A short public message every client shows once (e.g. why the game just ended).
function setNotice(room, text) { room.notice = { id: newId(4), text }; }

function touch(room) { room.version++; room.updatedAt = Date.now(); }

function findByToken(room, token) {
  if (typeof token !== 'string') return null;
  return room.players.find(p => p.token === token) || null;
}

function startGame(room) {
  const { size, rejectRule } = room.config;
  const roles = shuffle(presetFor(room.config).roles);
  const order = bySeat(room.players).map(p => p.id); // lobby seating = table order for leader rotation
  const missions = BOARDS[size].missions;
  room.gameNo++;
  room.status = 'playing';
  room.game = {
    phase: 'reveal', // reveal | team | vote | mission | assassin | ended
    size,
    rejectRule,
    preset: room.config.preset,
    seats: order,
    roles: Object.fromEntries(order.map((id, i) => [id, roles[i]])),
    acks: [],
    leaderIdx: randInt(size),
    round: 0, // 0-based
    successes: 0,
    fails: 0,
    rejects: 0,
    forced: false, // true when the next proposal skips the vote (5-rejection forced round)
    team: [],
    votes: {},
    cards: {},
    history: missions.map((sz, i) => ({ round: i + 1, size: sz, failsNeeded: failsNeeded(size, i), attempts: [], result: null })),
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
function nextLeader(g) { g.leaderIdx = (g.leaderIdx + 1) % g.size; }
const approvalsNeeded = size => Math.floor(size / 2) + 1;
const teamOf = role => ROLES[role].team;

function applyAction(room, player, action) {
  if (!player) fail('auth', '无效的玩家会话');
  if (!action || typeof action.type !== 'string') fail('bad_action', '无效操作');
  if (room.status === 'closed') fail('closed', '房主已解散房间');
  const g = room.game;
  const need = (cond, code, msg) => { if (!cond) fail(code, msg); };
  const needPhase = (ph) => need(room.status === 'playing' && g && g.phase === ph, 'bad_phase', '当前阶段不能执行此操作');

  switch (action.type) {
    case 'ready': {
      need(room.status === 'lobby', 'bad_phase', '游戏已开始');
      player.ready = !!action.value;
      break;
    }
    case 'config': {
      need(room.status === 'lobby', 'bad_phase', '游戏开始后不能修改配置');
      need(room.hostId === player.id, 'forbidden', '只有房主可以修改配置');
      const next = cleanConfig(action.config, room.config);
      need(next.size >= room.players.length, 'bad_config', `已有 ${room.players.length} 名玩家，人数不能少于此数`);
      room.config = next;
      compactSeats(room);
      room.players.forEach(p => { p.ready = false; }); // everyone re-confirms the new setup
      break;
    }
    case 'seat': {
      // Sit in an empty seat at once, or ask the player in that seat to swap.
      need(room.status === 'lobby', 'bad_phase', '游戏开始后不能换座位');
      const seat = action.seat;
      need(Number.isInteger(seat) && seat >= 0 && seat < room.config.size, 'bad_seat', '无效的座位');
      need(seat !== player.seat, 'bad_seat', '你已经坐在这里');
      const other = room.players.find(p => p.seat === seat);
      if (!other) {
        clearSwaps(room, player.id);
        player.seat = seat;
      } else {
        room.swaps = room.swaps || {};
        room.swaps[player.id] = other.id;
      }
      break;
    }
    case 'swap_cancel': {
      need(room.status === 'lobby', 'bad_phase', '游戏开始后不能换座位');
      need(room.swaps && room.swaps[player.id], 'not_found', '没有待处理的换座请求');
      delete room.swaps[player.id];
      break;
    }
    case 'swap_answer': {
      need(room.status === 'lobby', 'bad_phase', '游戏开始后不能换座位');
      const from = room.players.find(p => p.id === action.from);
      need(from && room.swaps && room.swaps[from.id] === player.id, 'not_found', '这个换座请求已失效');
      if (action.accept === true) {
        [from.seat, player.seat] = [player.seat, from.seat];
        clearSwaps(room, from.id);
        clearSwaps(room, player.id);
      } else {
        delete room.swaps[from.id];
      }
      break;
    }
    case 'leave': {
      // A game cannot go on without a player, so leaving during (or after) a game ends it
      // for everyone and the room goes back to the lobby.
      const inGame = room.status !== 'lobby';
      room.players = room.players.filter(p => p.id !== player.id);
      clearSwaps(room, player.id);
      if (room.hostId === player.id) room.hostId = room.players.length ? bySeat(room.players)[0].id : null;
      if (inGame) {
        room.status = 'lobby';
        room.game = null;
        room.players.forEach(p => { p.ready = false; });
      }
      setNotice(room, inGame && g.phase !== 'ended' ? `${player.name} 离开了房间，本局已结束` : `${player.name} 离开了房间`);
      break;
    }
    case 'dissolve': {
      need(room.hostId === player.id, 'forbidden', '只有房主可以解散房间');
      room.status = 'closed';
      room.game = null;
      break;
    }
    case 'start': {
      const size = room.config.size;
      need(room.status === 'lobby', 'bad_phase', '游戏已开始');
      need(room.hostId === player.id, 'forbidden', '只有房间创建者可以开始游戏');
      need(room.players.length === size, 'not_full', `需要 ${size} 名玩家才能开始`);
      need(room.players.every(p => p.ready), 'not_ready', '还有玩家未准备');
      startGame(room);
      break;
    }
    case 'ack': {
      needPhase('reveal');
      need(!g.acks.includes(player.id), 'duplicate', '你已确认身份');
      g.acks.push(player.id);
      if (g.acks.length === g.size) g.phase = 'team';
      break;
    }
    case 'propose': {
      needPhase('team');
      need(leaderId(g) === player.id, 'forbidden', '只有当前队长可以提名队伍');
      const team = action.team;
      const size = g.history[g.round].size;
      need(Array.isArray(team), 'bad_team', '无效的队伍');
      const uniq = [...new Set(team)];
      need(uniq.length === team.length && uniq.every(id => g.seats.includes(id)), 'bad_team', '队伍包含无效玩家');
      need(uniq.length === size, 'bad_team', `本轮必须选择 ${size} 人`);
      g.team = g.seats.filter(id => uniq.includes(id));
      g.votes = {};
      if (g.forced) {
        // Forced round: the team goes straight to the mission without a vote.
        g.history[g.round].attempts.push({ leader: leaderId(g), team: g.team.slice(), approve: 0, reject: 0, passed: true, forced: true });
        g.forced = false;
        g.cards = {};
        g.phase = 'mission';
      } else {
        g.phase = 'vote';
      }
      break;
    }
    case 'vote': {
      needPhase('vote');
      need(!(player.id in g.votes), 'duplicate', '你已经投过票');
      need(typeof action.approve === 'boolean', 'bad_vote', '无效的投票');
      g.votes[player.id] = action.approve;
      if (Object.keys(g.votes).length === g.size) resolveVote(room);
      break;
    }
    case 'mission': {
      needPhase('mission');
      need(g.team.includes(player.id), 'forbidden', '你不在本轮任务队伍中');
      need(!(player.id in g.cards), 'duplicate', '你已经提交过任务牌');
      need(action.card === 'success' || action.card === 'fail', 'bad_card', '无效的任务牌');
      if (action.card === 'fail') need(teamOf(g.roles[player.id]) === 'evil', 'forbidden', '好人只能提交成功牌');
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
  const passed = approve >= approvalsNeeded(g.size);
  // Once everyone has voted the votes are public (standard Avalon), so record who voted what, in seat order.
  g.history[g.round].attempts.push({
    leader: leaderId(g),
    team: g.team.slice(),
    approve,
    reject: g.size - approve,
    approvers: g.seats.filter(id => g.votes[id] === true),
    rejecters: g.seats.filter(id => g.votes[id] === false),
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
  if (g.rejects >= MAX_REJECTS) {
    if (g.rejectRule === 'evil_wins') return endGame(room, 'evil', '连续 5 次组队被否决');
    g.forced = true;
  }
  nextLeader(g);
  g.phase = 'team';
}

function resolveMission(room) {
  const g = room.game;
  const h = g.history[g.round];
  const failCount = Object.values(g.cards).filter(c => c === 'fail').length;
  const success = failCount < h.failsNeeded;
  h.result = {
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

// Who a role sees at night, following the standard Avalon rules.
function nightInfo(g, me) {
  const role = g.roles[me];
  const others = g.seats.filter(id => id !== me);
  if (role === 'merlin') {
    return { label: '你看到的坏人', ids: others.filter(id => teamOf(g.roles[id]) === 'evil' && g.roles[id] !== 'mordred'),
      note: Object.values(g.roles).includes('mordred') ? '莫德雷德隐藏在坏人中，你看不到他。' : null };
  }
  if (role === 'percival') {
    const hasMorgana = Object.values(g.roles).includes('morgana');
    return { label: hasMorgana ? '其中一人是梅林，另一人是莫甘娜（无法分辨）' : '梅林', ids: others.filter(id => ['merlin', 'morgana'].includes(g.roles[id])), note: null };
  }
  if (teamOf(role) === 'evil' && role !== 'oberon') {
    return { label: '你的坏人同伴（不含你自己）', ids: others.filter(id => teamOf(g.roles[id]) === 'evil' && g.roles[id] !== 'oberon'),
      note: Object.values(g.roles).includes('oberon') ? '奥伯伦也是坏人，但你不知道他是谁。' : null };
  }
  return { label: null, ids: [], note: null };
}

function configView(config) {
  const preset = presetFor(config);
  return {
    ...config,
    presetName: preset.name,
    rejectRuleName: REJECT_RULES[config.rejectRule],
    roles: preset.roles,
    good: BOARDS[config.size].good,
    evil: BOARDS[config.size].evil,
    presets: PRESETS[config.size].map(p => ({ id: p.id, name: p.name })),
  };
}

// The only function that produces data for clients. It never includes other
// players' tokens, roles, votes or mission cards except where the rules allow.
function viewFor(room, player, online = new Set()) {
  const g = room.game;
  const name = id => (room.players.find(p => p.id === id) || {}).name || '?';
  const order = g ? g.seats : bySeat(room.players).map(p => p.id);
  const view = {
    code: room.code,
    version: room.version,
    gameNo: room.gameNo,
    status: room.status,
    hostId: room.hostId,
    config: configView(room.config),
    notice: room.notice || null,
    swaps: room.status === 'lobby' ? Object.entries(room.swaps || {}).map(([from, to]) => ({ from, to })) : [],
    me: { id: player.id, name: player.name, isHost: room.hostId === player.id },
    players: order.map(id => {
      const p = room.players.find(x => x.id === id);
      return { id, name: p.name, ready: p.ready, online: online.has(id), seat: p.seat };
    }),
  };
  if (!g) return view;

  const role = g.roles[player.id];
  const info = ROLES[role];
  const night = nightInfo(g, player.id);
  view.secret = {
    role,
    roleName: info.name,
    team: info.team,
    desc: info.desc,
    knows: night.ids.map(id => ({ id, name: name(id) })),
    knowsLabel: night.label,
    note: night.note,
  };

  Object.assign(view, {
    size: g.size,
    rejectRule: g.rejectRule,
    approvalsNeeded: approvalsNeeded(g.size),
    phase: g.phase,
    round: g.round + 1,
    teamSize: g.history[g.round].size,
    failsNeeded: g.history[g.round].failsNeeded,
    leaderId: leaderId(g),
    successes: g.successes,
    fails: g.fails,
    rejects: g.rejects,
    forced: g.forced,
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
    view.reveal = g.seats.map(id => ({ id, name: name(id), role: g.roles[id], roleName: ROLES[g.roles[id]].name, team: teamOf(g.roles[id]) }));
  }
  return view;
}

module.exports = {
  MIN_PLAYERS, MAX_PLAYERS, BOARDS, PRESETS, ROLES, REJECT_RULES, DEFAULT_CONFIG, GameError,
  createRoom, addPlayer, applyAction, viewFor, findByToken, generateCode, isValidCode, cleanName, cleanConfig, configView, presetFor,
};
