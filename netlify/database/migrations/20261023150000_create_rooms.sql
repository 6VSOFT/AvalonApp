-- One row per room. `data` is the whole room as JSON (players, secret roles, game state);
-- it is only ever read by the API function, never sent to clients as-is.
-- `version` drives optimistic concurrency: every write is
-- UPDATE ... WHERE version = <version read>, so a stale write changes 0 rows.
CREATE TABLE rooms (
  code TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX rooms_updated_at_idx ON rooms (updated_at);

-- Last time each player polled, for the "online" dots. Advisory only.
CREATE TABLE presence (
  code TEXT NOT NULL,
  player_id TEXT NOT NULL,
  seen_at BIGINT NOT NULL,
  PRIMARY KEY (code, player_id)
);
