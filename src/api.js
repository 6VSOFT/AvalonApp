'use strict';
// HTTP API shared by the local Node server and the Netlify Function. It speaks
// web-standard Request/Response and is stateless: rooms live in a pluggable store
// (in memory locally, Netlify Blobs in production). Every write is a
// compare-and-set on the room's etag, so concurrent requests can never double
// count a vote or card: the loser re-reads the room and re-validates its action.

const game = require('./game');

const MAX_BODY = 4 * 1024;
const MAX_WRITE_ATTEMPTS = 6;
const ONLINE_MS = 25 * 1000; // a player counts as online if they polled this recently
const PRESENCE_REFRESH_MS = 8 * 1000; // how often a poll refreshes the player's presence stamp
const STATUS = { auth: 401, forbidden: 403, not_found: 404, duplicate: 409, full: 409, started: 409, name_taken: 409, busy: 503, rate: 429 };

// Everything the create-room and rules screens need, from the engine's own tables.
const OPTIONS = {
  sizes: Object.keys(game.BOARDS).map(Number),
  boards: game.BOARDS,
  presets: game.PRESETS,
  roles: Object.fromEntries(Object.entries(game.ROLES).map(([k, v]) => [k, { name: v.name, short: v.short, team: v.team, ability: v.ability, tip: v.tip }])),
  rejectRules: game.REJECT_RULES,
  defaults: game.DEFAULT_CONFIG,
};

// Rooms saved by older versions may have no config or a preset that no longer exists.
function migrate(r) {
  if (!r.config) r.config = { ...game.DEFAULT_CONFIG };
  if (!game.presetFor(r.config)) r.config.preset = game.PRESETS[r.config.size][0].id;
  const g = r.game;
  if (g && !g.size) {
    Object.assign(g, { size: 6, rejectRule: 'evil_wins', preset: 'basic', forced: false });
    g.history.forEach(h => { h.failsNeeded = 1; });
  }
  return r;
}

// Best-effort limiter. Per process/instance only; the Netlify Function also has a platform rate limit.
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.start > windowMs) {
    if (buckets.size > 5000) buckets.clear();
    b = { start: now, count: 0 };
    buckets.set(key, b);
  }
  return ++b.count > max;
}

const json = (status, obj) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});
const fail = (code, msg) => { throw new game.GameError(code, msg); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function readBody(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) fail('too_large', '请求过大');
  try { return text ? JSON.parse(text) : {}; } catch { return fail('bad_json', '请求格式错误'); }
}

function onlineSet(presence) {
  const now = Date.now();
  return new Set(Object.entries(presence || {}).filter(([, t]) => now - t < ONLINE_MS).map(([id]) => id));
}

/**
 * @param store {get(code), create(code, room), put(code, room, etag), getPresence(code), touch(code, playerId)}
 *   get → {room, etag} | null; create/put → boolean (false when the key exists / the etag is stale).
 * @param qrcode the `qrcode` module. The Netlify Function passes its own ES import, because the
 *   bundler does not resolve a require() made from this CommonJS file.
 */
function createApi(store, qrcode = require('qrcode')) {
  async function loadRoom(code) {
    if (!game.isValidCode(code)) fail('not_found', '房间代码无效');
    const r = await store.get(code);
    if (!r) fail('not_found', '房间不存在');
    migrate(r.room);
    return r;
  }

  // The store may serve a slightly outdated copy right after another instance wrote.
  // Writing the unchanged room back with its etag succeeds only if that copy is current.
  const isCurrent = (code, room, etag) => store.put(code, room, etag);
  const backoff = attempt => sleep(15 + Math.random() * 60 * (attempt + 1));

  // Read-modify-write with optimistic concurrency. `mutate` runs on a fresh copy on every attempt.
  // A successful write proves the action was validated against current state; a rejection is
  // only reported once the room it was checked against is confirmed current.
  async function withRoom(code, mutate) {
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const { room, etag } = await loadRoom(code);
      const pristine = JSON.stringify(room);
      let result;
      try {
        result = mutate(room);
      } catch (e) {
        if (!(e instanceof game.GameError) || e.code === 'rate' || await isCurrent(code, JSON.parse(pristine), etag)) throw e;
        await backoff(attempt);
        continue;
      }
      if (await store.put(code, room, etag)) return { room, result };
      await backoff(attempt);
    }
    return fail('busy', '服务器繁忙，请重试');
  }

  // Loads the room for a read-only request that must not act on an outdated copy (e.g. before
  // telling a just-joined player they are not in the room).
  async function loadRoomFor(code, check) {
    for (let attempt = 0; ; attempt++) {
      const r = await loadRoom(code);
      if (check(r.room) || attempt === MAX_WRITE_ATTEMPTS - 1 || await isCurrent(code, r.room, r.etag)) return r;
      await backoff(attempt);
    }
  }

  function auth(room, req, url) {
    const p = game.findByToken(room, req.headers.get('x-player-token') || url.searchParams.get('token'));
    if (!p) fail('auth', '你不是该房间的玩家');
    return p;
  }

  async function route(req, ip) {
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'api') return json(404, { error: 'not_found' });
    if (req.method === 'POST' && limited('post:' + ip, 60, 10000)) fail('rate', '操作过于频繁，请稍后再试');

    if (req.method === 'GET' && url.pathname === '/api/options') return json(200, OPTIONS);

    // POST /api/rooms  {name, config}
    if (req.method === 'POST' && parts.length === 2 && parts[1] === 'rooms') {
      if (limited('create:' + ip, 10, 60000)) fail('rate', '创建房间过于频繁');
      const body = await readBody(req);
      for (let i = 0; i < 10; i++) {
        const { room, player } = game.createRoom(game.generateCode(new Set()), body.name, body.config);
        if (await store.create(room.code, room)) return json(200, { code: room.code, token: player.token, playerId: player.id });
      }
      return fail('busy', '服务器繁忙，请重试');
    }
    if (parts[1] !== 'rooms' || !parts[2]) return json(404, { error: 'not_found' });
    const code = String(parts[2]).toUpperCase();

    // GET /api/rooms/:code  -> public lobby info for the join screen
    if (req.method === 'GET' && parts.length === 3) {
      if (limited('peek:' + ip, 60, 60000)) fail('rate', '请求过于频繁');
      const { room } = await loadRoom(code);
      return json(200, { code, status: room.status, count: room.players.length, size: room.config.size });
    }
    // POST /api/rooms/:code/join  {name}
    if (req.method === 'POST' && parts[3] === 'join') {
      if (limited('join:' + ip, 20, 60000)) fail('rate', '加入过于频繁');
      const body = await readBody(req);
      const { result: player } = await withRoom(code, room => game.addPlayer(room, body.name));
      await store.touch(code, player.id);
      return json(200, { code, token: player.token, playerId: player.id });
    }
    // POST /api/rooms/:code/action  {type, ...}
    if (req.method === 'POST' && parts[3] === 'action') {
      const body = await readBody(req);
      let playerId;
      const { room } = await withRoom(code, r => {
        const player = auth(r, req, url);
        playerId = player.id;
        if (limited('act:' + player.id, 20, 5000)) fail('rate', '操作过于频繁');
        game.applyAction(r, player, body);
      });
      if (body.type === 'leave') return json(200, { ok: true });
      const me = room.players.find(p => p.id === playerId);
      return json(200, { ok: true, state: game.viewFor(room, me, onlineSet(await store.getPresence(code))) });
    }
    // GET /api/rooms/:code/state  -> this player's view; polling it also marks the player online
    if (req.method === 'GET' && parts[3] === 'state') {
      const token = req.headers.get('x-player-token') || url.searchParams.get('token');
      const [{ room }, presence] = await Promise.all([
        loadRoomFor(code, r => game.findByToken(r, token)), store.getPresence(code),
      ]);
      const player = auth(room, req, url);
      if (!(Date.now() - (presence[player.id] || 0) < PRESENCE_REFRESH_MS)) {
        presence[player.id] = Date.now();
        await store.touch(code, player.id);
      }
      return json(200, game.viewFor(room, player, onlineSet(presence)));
    }
    // GET /api/rooms/:code/qr.svg
    if (req.method === 'GET' && parts[3] === 'qr.svg') {
      await loadRoom(code);
      const origin = url.searchParams.get('origin');
      const base = origin && /^https?:\/\/[^\s/]+$/.test(origin) ? origin : url.origin;
      const svg = await qrcode.toString(`${base}/r/${code}`, { type: 'svg', margin: 1, color: { dark: '#123367', light: '#ffffff' } });
      return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' } });
    }
    return json(404, { error: 'not_found' });
  }

  return async function handle(req, ip = '') {
    try {
      return await route(req, ip);
    } catch (e) {
      if (e instanceof game.GameError) return json(STATUS[e.code] || 400, { error: e.code, message: e.message });
      console.error(e);
      return json(500, { error: 'server', message: '服务器错误' });
    }
  };
}

// In-memory store for local development and tests. Etags are per-write counters,
// and every method is synchronous inside, so compare-and-set is atomic.
function memoryStore(initial = []) {
  const rooms = new Map(initial.map(r => [r.code, { data: JSON.stringify(r), etag: 1 }]));
  const presence = new Map();
  return {
    rooms,
    async get(code) {
      const e = rooms.get(code);
      return e ? { room: JSON.parse(e.data), etag: e.etag } : null;
    },
    async create(code, room) {
      if (rooms.has(code)) return false;
      rooms.set(code, { data: JSON.stringify(room), etag: 1 });
      return true;
    },
    async put(code, room, etag) {
      const e = rooms.get(code);
      if (!e || e.etag !== etag) return false;
      rooms.set(code, { data: JSON.stringify(room), etag: etag + 1 });
      return true;
    },
    async getPresence(code) { return { ...(presence.get(code) || {}) }; },
    async touch(code, playerId) { presence.set(code, { ...(presence.get(code) || {}), [playerId]: Date.now() }); },
    all() { return [...rooms.values()].map(e => JSON.parse(e.data)); },
    delete(code) { rooms.delete(code); presence.delete(code); },
  };
}

module.exports = { createApi, memoryStore, migrate, OPTIONS };
