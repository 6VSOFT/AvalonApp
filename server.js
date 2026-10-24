'use strict';
// Local / single-instance server: serves public/ and hands /api/* to the shared
// API in src/api.js with an in-memory store persisted to a JSON file. Production
// runs the same API as a Netlify Function (netlify/functions/api.mjs).

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createApi, memoryStore, migrate } = require('./src/api');

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'rooms.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;

function loadRooms() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).filter(r => Date.now() - r.updatedAt < ROOM_TTL_MS).map(migrate);
  } catch { return []; }
}

// Wraps the memory store so every successful write is saved (debounced) to DATA_FILE.
function persistentStore(initial) {
  const store = memoryStore(initial);
  let timer = null;
  const save = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(store.all()));
      fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
    }, 200);
  };
  for (const m of ['create', 'put']) {
    const orig = store[m];
    store[m] = async (...args) => { const ok = await orig(...args); if (ok) save(); return ok; };
  }
  setInterval(() => {
    for (const r of store.all()) if (Date.now() - r.updatedAt > ROOM_TTL_MS) store.delete(r.code);
  }, 10 * 60 * 1000).unref();
  return store;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
};
function serveStatic(res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel.startsWith('/r/')) rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // App code and role art must revalidate so a redeploy reaches phones at once; app icons can cache.
      'Cache-Control': rel.startsWith('/icons/') ? 'public, max-age=86400' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(buf);
  });
}

// Node IncomingMessage -> web Request -> shared API -> back to the Node response.
async function handleApi(api, req, res) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(`http://${req.headers.host || 'localhost'}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
  const response = await api(request, ip);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

function createServer(store = persistentStore(loadRooms())) {
  const api = createApi(store);
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
    if (pathname.startsWith('/api/')) {
      return handleApi(api, req, res).catch(e => { console.error(e); res.writeHead(500); res.end(); });
    }
    serveStatic(res, pathname);
  });
  server.store = store;
  return server;
}

if (require.main === module) {
  createServer().listen(PORT, () => console.log(`Avalon server on http://localhost:${PORT}`));
}

module.exports = { createServer };
