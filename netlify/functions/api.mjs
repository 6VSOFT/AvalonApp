// Production API on Netlify: the shared handler from src/api.js backed by Netlify Database
// (Postgres). Each room is one row; writes are UPDATE ... WHERE version = <version read>,
// which Postgres applies atomically, so concurrent votes or cards from different phones
// can never overwrite each other and reads are never stale.
import { getDatabase } from '@netlify/database';
import qrcode from 'qrcode';
import api from '../../src/api.js';

const db = getDatabase(); // once per instance, reused across requests

const dbStore = {
  async get(code) {
    const { rows } = await db.pool.query('SELECT data, version FROM rooms WHERE code = $1', [code]);
    return rows[0] ? { room: rows[0].data, etag: rows[0].version } : null;
  },
  async create(code, room) {
    const { rowCount } = await db.pool.query(
      'INSERT INTO rooms (code, data) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING', [code, room]);
    return rowCount === 1;
  },
  async put(code, room, version) {
    const { rowCount } = await db.pool.query(
      'UPDATE rooms SET data = $2, version = version + 1, updated_at = NOW() WHERE code = $1 AND version = $3',
      [code, room, version]);
    return rowCount === 1;
  },
  async getPresence(code) {
    const { rows } = await db.pool.query('SELECT player_id, seen_at FROM presence WHERE code = $1', [code]);
    return Object.fromEntries(rows.map(r => [r.player_id, Number(r.seen_at)]));
  },
  async touch(code, playerId) {
    await db.pool.query(
      `INSERT INTO presence (code, player_id, seen_at) VALUES ($1, $2, $3)
       ON CONFLICT (code, player_id) DO UPDATE SET seen_at = EXCLUDED.seen_at`,
      [code, playerId, Date.now()]);
  },
};

const handle = api.createApi(dbStore, qrcode);

export default async (req, context) => handle(req, context.ip);

export const config = {
  path: '/api/*',
  // Platform-level limit per client IP. A whole table on one Wi-Fi polls ~10 req/s, so keep headroom.
  rateLimit: { windowLimit: 1500, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
