-- Tendril server schema (libSQL / SQLite). Idempotent: safe to run repeatedly.
-- Timestamps are Unix epoch milliseconds. Token-like values are stored as SHA-256 hex only.

CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  github_id    INTEGER UNIQUE,
  login        TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url   TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash         TEXT PRIMARY KEY,
  desktop_nonce_hash TEXT,
  return_path        TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_states_expiry ON oauth_states (expires_at);

-- Desktop nonce -> session handoff. No token is stored: the callback marks the nonce 'ready' for a user and the
-- single successful poll deletes the row and mints the session, so the database never holds a usable token.
CREATE TABLE IF NOT EXISTS desktop_logins (
  nonce_hash TEXT PRIMARY KEY,
  status     TEXT NOT NULL CHECK (status IN ('pending', 'ready')),
  user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS desktop_logins_expiry ON desktop_logins (expires_at);

CREATE TABLE IF NOT EXISTS farms (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  seed            INTEGER NOT NULL,
  started_at      INTEGER NOT NULL,
  tick            INTEGER NOT NULL,
  checkpoint      TEXT NOT NULL,
  checkpoint_hash TEXT NOT NULL,
  rules_version   INTEGER NOT NULL,
  coins           INTEGER NOT NULL,
  net_worth       INTEGER NOT NULL,
  verified_at     INTEGER -- NULL until the first chunk is accepted; only verified farms are ranked/public
);
-- Leaderboard order: net_worth DESC, verified_at ASC, id ASC (ranked farms only).
CREATE INDEX IF NOT EXISTS farms_ranked ON farms (net_worth DESC, verified_at ASC, id ASC) WHERE verified_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS chunks (
  farm_id    TEXT NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  from_tick  INTEGER NOT NULL,
  to_tick    INTEGER NOT NULL,
  actions    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (farm_id, from_tick)
) WITHOUT ROWID; -- the primary key is the replay paging index

-- Net-worth samples taken at verification time, for the 24h growth board.
CREATE TABLE IF NOT EXISTS worth_history (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  farm_id   TEXT NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  net_worth INTEGER NOT NULL,
  at_ms     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS worth_history_farm_time ON worth_history (farm_id, at_ms, id);

-- Rate limiting. kind: 'chunk' (10/hour) or 'daily' (20/UTC day). Rejected submissions count too.
CREATE TABLE IF NOT EXISTS submission_attempts (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind    TEXT NOT NULL,
  at_ms   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS submission_attempts_user ON submission_attempts (user_id, kind, at_ms);

CREATE TABLE IF NOT EXISTS daily_entries (
  date        TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  net_worth   INTEGER NOT NULL,
  achieved_at INTEGER NOT NULL,
  PRIMARY KEY (date, user_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS daily_entries_rank ON daily_entries (date, net_worth DESC, achieved_at ASC, user_id ASC);
