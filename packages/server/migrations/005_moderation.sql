-- Automatic moderation (F3). Idempotent like the others.
-- Players are shown by GitHub login only: the free-text display name (editable on GitHub) is no longer kept.
UPDATE users SET display_name = login WHERE display_name <> login;

-- One report per account per published program. `counted` is decided when the report is filed (account older than
-- seven days with at least one verified entry) and never changes, so hiding is a plain count and never flips with time.
CREATE TABLE IF NOT EXISTS reports (
  entry_id    TEXT    NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  reporter_id TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  counted     INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (entry_id, reporter_id)
);
CREATE INDEX IF NOT EXISTS reports_counted ON reports (entry_id) WHERE counted = 1;
