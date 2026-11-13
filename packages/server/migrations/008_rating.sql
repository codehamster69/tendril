-- R2: ratings (packages/rating). Idempotent like the others, except ADD COLUMN.
-- NOTE: ADD COLUMN is not re-runnable. A crash between this script and its schema_version stamp needs a manual stamp.
-- GitHub account creation date (epoch ms), stored at sign-in. NULL for dev logins, the model runner and accounts that have
-- not signed in since this migration: those are unrated until they sign in again.
ALTER TABLE users ADD COLUMN github_created_at INTEGER;

-- One row per player: the whole rating state in `data` (per discipline: rating, events, peak, history), so a rated contest
-- costs one write per participant. The r_/n_/l_ columns mirror the data (rating, events, closes_at of the last rated
-- contest) for overall, speed and brevity, so the ladder and ranks read an index instead of parsing JSON.
CREATE TABLE IF NOT EXISTS rating_profiles (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  r_overall INTEGER, n_overall INTEGER, l_overall INTEGER,
  r_speed   INTEGER, n_speed   INTEGER, l_speed   INTEGER,
  r_brevity INTEGER, n_brevity INTEGER, l_brevity INTEGER
);
-- Ladder = established players (5+ events, PLACEMENT_EVENTS) by rating.
CREATE INDEX IF NOT EXISTS rating_board_overall ON rating_profiles (r_overall DESC, user_id ASC) WHERE n_overall >= 5;
CREATE INDEX IF NOT EXISTS rating_board_speed   ON rating_profiles (r_speed DESC, user_id ASC) WHERE n_speed >= 5;
CREATE INDEX IF NOT EXISTS rating_board_brevity ON rating_profiles (r_brevity DESC, user_id ASC) WHERE n_brevity >= 5;

-- One row per rated (or deliberately unrated) contest and discipline: audit trail and the resume marker of the lazy rater.
CREATE TABLE IF NOT EXISTS rating_contests (
  challenge_id TEXT NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  discipline   TEXT NOT NULL CHECK (discipline IN ('overall', 'speed', 'brevity')),
  algo_version INTEGER NOT NULL,
  field_size   INTEGER NOT NULL,   -- players in the engine's field (stored even when the contest was left unrated for being under 8)
  rated_at     INTEGER NOT NULL,
  summary      TEXT NOT NULL,      -- JSON: counts, exclusions, the duplicate-source user ids (needed by recompute), writes
  PRIMARY KEY (challenge_id, discipline)
) WITHOUT ROWID;
