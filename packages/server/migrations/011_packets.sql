-- H8: seed packets. A packet is a published Sprout program with a note, an author and (for a remix) a parent.
-- Idempotent like the others: CREATE ... IF NOT EXISTS only, no ALTER.
CREATE TABLE IF NOT EXISTS packets (
  id          TEXT    PRIMARY KEY,
  user_id     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  note        TEXT    NOT NULL DEFAULT '',
  tags        TEXT    NOT NULL DEFAULT '',   -- comma separated, from a fixed list
  source      TEXT    NOT NULL,
  hash        TEXT    NOT NULL,              -- program-hash.ts: SHA-256 of the normalised program
  parent_id   TEXT    REFERENCES packets(id) ON DELETE SET NULL,
  origin      TEXT    NOT NULL DEFAULT 'endless',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS packets_new    ON packets (created_at DESC);
CREATE INDEX IF NOT EXISTS packets_user   ON packets (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS packets_parent ON packets (parent_id);
CREATE INDEX IF NOT EXISTS packets_hash   ON packets (hash);

-- One row per player per packet; planting again only refreshes last_at (the "this week" count reads it).
CREATE TABLE IF NOT EXISTS packet_plants (
  packet_id TEXT    NOT NULL REFERENCES packets(id) ON DELETE CASCADE,
  user_id   TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_at  INTEGER NOT NULL,
  last_at   INTEGER NOT NULL,
  PRIMARY KEY (packet_id, user_id)
);
CREATE INDEX IF NOT EXISTS packet_plants_week ON packet_plants (packet_id, last_at);

-- Same rules as reports on entries: counted only from accounts at least a week old with a verified entry.
CREATE TABLE IF NOT EXISTS packet_reports (
  packet_id   TEXT    NOT NULL REFERENCES packets(id) ON DELETE CASCADE,
  reporter_id TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  counted     INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (packet_id, reporter_id)
);

-- Program hash of every entry that carries a verified program. Lets a packet find its entries (best result) and lets
-- publishing refuse a program that is in play on an open daily or season. Filled when an entry is saved or its program attached.
CREATE TABLE IF NOT EXISTS entry_programs (
  entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  hash     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS entry_programs_hash ON entry_programs (hash);
