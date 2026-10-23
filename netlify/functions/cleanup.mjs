// Blobs never expire on their own: delete rooms (and their presence stamps)
// that have not changed for 12 hours. Runs hourly at minute 0, UTC.
import { getStore } from '@netlify/blobs';

const ROOM_TTL_MS = 12 * 60 * 60 * 1000;

export default async () => {
  const rooms = getStore({ name: 'rooms', consistency: 'strong' });
  const presence = getStore({ name: 'presence', consistency: 'strong' });
  const { blobs } = await rooms.list();
  let deleted = 0;
  for (const { key } of blobs) {
    const room = await rooms.get(key, { type: 'json' });
    if (!room || Date.now() - room.updatedAt > ROOM_TTL_MS) {
      await rooms.delete(key);
      await presence.delete(key);
      deleted++;
    }
  }
  console.log(`cleanup: ${deleted} of ${blobs.length} rooms deleted`);
};

export const config = { schedule: '0 * * * *' };
