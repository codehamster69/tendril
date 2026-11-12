-- Arena: one challenge table for daily, season and duel runs, stored entries, and the follow graph.
-- Idempotent like 001. Timestamps are Unix epoch milliseconds. daily_entries is kept as a read-only archive;
-- its rows are copied into challenges/entries once at start-up (see moveLegacyDaily in src/arena.ts).

CREATE TABLE IF NOT EXISTS challenges (
  id            TEXT PRIMARY KEY,                -- d-YYYY-MM-DD | s-YYYY-Www | x-<8 random chars>
  kind          TEXT NOT NULL CHECK (kind IN ('daily', 'season', 'duel')),
  number        INTEGER,                          -- daily/season counter from the launch epoch (<= 0 before it); NULL for duels
  seed          INTEGER NOT NULL,
  ticks         INTEGER NOT NULL,
  par           INTEGER,                          -- NULL: no par, so no Speed medal
  opens_at      INTEGER NOT NULL,
  closes_at     INTEGER,                          -- NULL: never closes (duels)
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  rules_version INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS challenges_kind_open ON challenges (kind, opens_at DESC);

CREATE TABLE IF NOT EXISTS entries (
  id              TEXT PRIMARY KEY,
  challenge_id    TEXT NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  net_worth       INTEGER NOT NULL,
  par_tick        INTEGER,                        -- first tick at or above par, NULL if never reached
  tokens          INTEGER,                        -- Sprout token count; NULL until the source check exists (C3)
  actions         TEXT,                           -- JSON action log; NULL only for rows moved from daily_entries
  actions_count   INTEGER NOT NULL,
  log_hash        TEXT NOT NULL,                  -- SHA-256 hex of the canonical log (legacy rows: 'legacy:<date>:<user>')
  mosaic          TEXT,                           -- 64 characters; NULL only for moved legacy rows
  source          TEXT,
  source_public   INTEGER NOT NULL DEFAULT 0 CHECK (source_public IN (0, 1)),
  source_verified INTEGER NOT NULL DEFAULT 0 CHECK (source_verified IN (0, 1)),
  author_kind     TEXT NOT NULL DEFAULT 'human' CHECK (author_kind IN ('human', 'model')),
  model           TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_by_user ON entries (challenge_id, user_id);
-- Copying someone's log is refused with 409; an empty log carries no information and is exempt.
CREATE UNIQUE INDEX IF NOT EXISTS entries_log_once ON entries (challenge_id, log_hash) WHERE actions_count > 0;
CREATE INDEX IF NOT EXISTS entries_wealth ON entries (challenge_id, net_worth DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS entries_speed ON entries (challenge_id, par_tick ASC) WHERE par_tick IS NOT NULL;
CREATE INDEX IF NOT EXISTS entries_brevity ON entries (challenge_id, tokens ASC) WHERE tokens IS NOT NULL;
CREATE INDEX IF NOT EXISTS entries_by_day ON entries (created_at);

CREATE TABLE IF NOT EXISTS follows (
  follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS follows_followee ON follows (followee_id);

-- Marks one-off data moves done (the TypeScript step that copies daily_entries).
CREATE TABLE IF NOT EXISTS arena_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
