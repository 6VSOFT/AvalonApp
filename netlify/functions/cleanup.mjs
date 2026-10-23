// Delete rooms (and their presence rows) that have not changed for 12 hours.
// Runs hourly at minute 0, UTC.
import { getDatabase } from '@netlify/database';

const db = getDatabase();

export default async () => {
  const { rowCount } = await db.pool.query("DELETE FROM rooms WHERE updated_at < NOW() - INTERVAL '12 hours'");
  await db.pool.query('DELETE FROM presence WHERE code NOT IN (SELECT code FROM rooms)');
  console.log(`cleanup: ${rowCount} rooms deleted`);
};

export const config = { schedule: '0 * * * *' };
