// Production API on Netlify: the shared handler from src/api.js backed by Netlify Blobs.
// Each room is one JSON blob; writes use onlyIfMatch (compare-and-set on the etag),
// so concurrent votes or cards from different phones can never overwrite each other.
import { getStore } from '@netlify/blobs';
import api from '../../src/api.js';

const rooms = () => getStore({ name: 'rooms', consistency: 'strong' });
const presence = () => getStore({ name: 'presence', consistency: 'strong' });

const blobStore = {
  async get(code) {
    const r = await rooms().getWithMetadata(code, { type: 'json' });
    return r && r.data ? { room: r.data, etag: r.etag } : null;
  },
  async create(code, room) {
    const { modified } = await rooms().setJSON(code, room, { onlyIfNew: true });
    return modified;
  },
  async put(code, room, etag) {
    const { modified } = await rooms().setJSON(code, room, { onlyIfMatch: etag });
    return modified;
  },
  async getPresence(code) {
    return (await presence().get(code, { type: 'json' })) || {};
  },
  // Presence is advisory (the online dot), so a lost update here is harmless: last write wins.
  async touch(code, playerId) {
    const store = presence();
    const map = (await store.get(code, { type: 'json' })) || {};
    map[playerId] = Date.now();
    await store.setJSON(code, map);
  },
};

const handle = api.createApi(blobStore);

export default async (req, context) => handle(req, context.ip);

export const config = {
  path: '/api/*',
  // Platform-level limit per client IP. A whole table on one Wi-Fi polls ~10 req/s, so keep headroom.
  rateLimit: { windowLimit: 1500, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
