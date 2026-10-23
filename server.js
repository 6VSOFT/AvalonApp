'use strict';
// HTTP + Server-Sent Events server. The server is the single source of truth:
// clients send intents, the server validates them in src/game.js and pushes each
// player a personalised view. Secret data never leaves the server unfiltered.

const http = require('http');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const game = require('./src/game');

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'rooms.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BODY = 4 * 1024;

const rooms = new Map(); // code -> room
const streams = new Map(); // code -> Set<{res, playerId}>

// ---------- persistence (so a server restart does not lose roles or submissions) ----------
function load() {
  try {
    const list = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const r of list) if (Date.now() - r.updatedAt < ROOM_TTL_MS) rooms.set(r.code, migrate(r));
  } catch { /* no saved state */ }
}
// Rooms saved by the fixed 6-player version have no config.
function migrate(r) {
  if (!r.config) r.config = { size: 6, preset: 'basic', rejectRule: 'evil_wins' };
  const g = r.game;
  if (g && !g.size) {
    Object.assign(g, { size: 6, rejectRule: 'evil_wins', preset: 'basic', forced: false });
    g.history.forEach(h => { h.failsNeeded = 1; });
  }
  return r;
}

// Everything the create-room screen needs to preview setups, from the engine's own tables.
const OPTIONS = {
  sizes: Object.keys(game.BOARDS).map(Number),
  boards: game.BOARDS,
  presets: game.PRESETS,
  roles: Object.fromEntries(Object.entries(game.ROLES).map(([k, v]) => [k, { name: v.name, team: v.team }])),
  rejectRules: game.REJECT_RULES,
  defaults: game.DEFAULT_CONFIG,
};
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...rooms.values()]));
    fs.renameSync(tmp, DATA_FILE);
  }, 200);
}
setInterval(() => {
  for (const [code, r] of rooms) {
    if (Date.now() - r.updatedAt > ROOM_TTL_MS && !(streams.get(code) || new Set()).size) rooms.delete(code);
  }
}, 10 * 60 * 1000).unref();

// ---------- rate limiting ----------
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.start > windowMs) { b = { start: now, count: 0 }; buckets.set(key, b); }
  return ++b.count > max;
}
setInterval(() => buckets.clear(), 5 * 60 * 1000).unref();

// ---------- realtime ----------
function onlineSet(code) {
  return new Set([...(streams.get(code) || [])].map(s => s.playerId));
}
function broadcast(room) {
  const set = streams.get(room.code);
  if (!set) return;
  const online = onlineSet(room.code);
  for (const s of set) {
    const p = room.players.find(x => x.id === s.playerId);
    if (!p) { s.res.write(`event: kicked\ndata: {}\n\n`); s.res.end(); set.delete(s); continue; }
    s.res.write(`event: state\ndata: ${JSON.stringify(game.viewFor(room, p, online))}\n\n`);
  }
}
setInterval(() => {
  for (const set of streams.values()) for (const s of set) s.res.write(': ping\n\n');
}, 20000).unref();

// ---------- helpers ----------
function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function errorOut(res, e) {
  if (e instanceof game.GameError) {
    const status = { auth: 401, forbidden: 403, not_found: 404, duplicate: 409, full: 409, started: 409, name_taken: 409 }[e.code] || 400;
    return send(res, status, { error: e.code, message: e.message });
  }
  console.error(e);
  send(res, 500, { error: 'server', message: '服务器错误' });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > MAX_BODY) { reject(new game.GameError('too_large', '请求过大')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new game.GameError('bad_json', '请求格式错误')); }
    });
    req.on('error', reject);
  });
}
function getRoom(code) {
  if (!game.isValidCode(code)) throw new game.GameError('not_found', '房间代码无效');
  const room = rooms.get(code);
  if (!room) throw new game.GameError('not_found', '房间不存在');
  return room;
}
function auth(room, req, url) {
  const token = req.headers['x-player-token'] || url.searchParams.get('token');
  const p = game.findByToken(room, token);
  if (!p) throw new game.GameError('auth', '你不是该房间的玩家');
  return p;
}
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
};
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel.startsWith('/r/')) rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'not_found' });
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // App code must revalidate so a redeploy never leaves phones running stale JS; icons can cache.
      'Cache-Control': ext === '.png' || ext === '.svg' ? 'public, max-age=86400' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(buf);
  });
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  const ip = clientIp(req);

  if (url.pathname === '/healthz') return send(res, 200, { ok: true });
  if (parts[0] !== 'api') return serveStatic(req, res, url.pathname);
  if (req.method === 'POST' && limited('post:' + ip, 60, 10000)) return send(res, 429, { error: 'rate', message: '操作过于频繁，请稍后再试' });

  try {
    if (req.method === 'GET' && url.pathname === '/api/options') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(JSON.stringify(OPTIONS));
    }
    // POST /api/rooms  {name, config}
    if (req.method === 'POST' && parts.length === 2 && parts[1] === 'rooms') {
      if (limited('create:' + ip, 10, 60000)) return send(res, 429, { error: 'rate', message: '创建房间过于频繁' });
      const body = await readBody(req);
      const { room, player } = game.createRoom(game.generateCode(rooms), body.name, body.config);
      rooms.set(room.code, room);
      save();
      return send(res, 200, { code: room.code, token: player.token, playerId: player.id });
    }
    if (parts[1] !== 'rooms' || !parts[2]) return send(res, 404, { error: 'not_found' });
    const code = String(parts[2]).toUpperCase();

    // GET /api/rooms/:code  -> public lobby info for the join screen
    if (req.method === 'GET' && parts.length === 3) {
      if (limited('peek:' + ip, 60, 60000)) return send(res, 429, { error: 'rate', message: '请求过于频繁' });
      const room = getRoom(code);
      return send(res, 200, { code, status: room.status, count: room.players.length, size: room.config.size });
    }
    // POST /api/rooms/:code/join  {name}
    if (req.method === 'POST' && parts[3] === 'join') {
      if (limited('join:' + ip, 20, 60000)) return send(res, 429, { error: 'rate', message: '加入过于频繁' });
      const room = getRoom(code);
      const body = await readBody(req);
      const player = game.addPlayer(room, body.name);
      save();
      broadcast(room);
      return send(res, 200, { code, token: player.token, playerId: player.id });
    }
    // POST /api/rooms/:code/action  {type, ...}
    if (req.method === 'POST' && parts[3] === 'action') {
      const room = getRoom(code);
      const player = auth(room, req, url);
      if (limited('act:' + player.id, 20, 5000)) return send(res, 429, { error: 'rate', message: '操作过于频繁' });
      const body = await readBody(req);
      game.applyAction(room, player, body);
      save();
      broadcast(room);
      if (body.type === 'leave') return send(res, 200, { ok: true });
      return send(res, 200, { ok: true, state: game.viewFor(room, player, onlineSet(code)) });
    }
    // GET /api/rooms/:code/state
    if (req.method === 'GET' && parts[3] === 'state') {
      const room = getRoom(code);
      const player = auth(room, req, url);
      return send(res, 200, game.viewFor(room, player, onlineSet(code)));
    }
    // GET /api/rooms/:code/events  (SSE)
    if (req.method === 'GET' && parts[3] === 'events') {
      const room = getRoom(code);
      const player = auth(room, req, url);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      if (!streams.has(code)) streams.set(code, new Set());
      const entry = { res, playerId: player.id };
      streams.get(code).add(entry);
      broadcast(room); // pushes this client's initial state and updates everyone's online status
      req.on('close', () => {
        streams.get(code)?.delete(entry);
        const r = rooms.get(code);
        if (r) broadcast(r);
      });
      return;
    }
    // GET /api/rooms/:code/qr.svg
    if (req.method === 'GET' && parts[3] === 'qr.svg') {
      getRoom(code);
      const origin = url.searchParams.get('origin');
      const base = origin && /^https?:\/\/[^\s/]+$/.test(origin) ? origin : `http://${req.headers.host}`;
      const svg = await QRCode.toString(`${base}/r/${code}`, { type: 'svg', margin: 1, color: { dark: '#0b1530', light: '#ffffff' } });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' });
      return res.end(svg);
    }
    send(res, 404, { error: 'not_found' });
  } catch (e) {
    errorOut(res, e);
  }
}

function createServer() {
  return http.createServer((req, res) => { handle(req, res); });
}

if (require.main === module) {
  load();
  createServer().listen(PORT, () => console.log(`Avalon server on http://localhost:${PORT}`));
}

module.exports = { createServer, rooms };
