-- Cost cuts for the free tiers (see brain/notes/COST.md).
-- Endless sync: the farm row carries its own attempt counter, the not-yet-flushed action log, and the last
-- rank/growth/sample times, so a verified chunk writes one row instead of four.
-- NOTE: ADD COLUMN is not re-runnable. A crash between this script and its schema_version stamp needs a manual stamp.
ALTER TABLE farms ADD COLUMN pending_from    INTEGER;                      -- first tick of the buffered log; NULL when nothing is buffered
ALTER TABLE farms ADD COLUMN pending_actions TEXT;                         -- JSON action log not yet flushed into `chunks`
ALTER TABLE farms ADD COLUMN pending_at      INTEGER;                      -- when the buffer was started
ALTER TABLE farms ADD COLUMN slow_at         INTEGER NOT NULL DEFAULT 0;   -- last rank/growth refresh
ALTER TABLE farms ADD COLUMN sampled_at      INTEGER NOT NULL DEFAULT 0;   -- last worth_history sample
ALTER TABLE farms ADD COLUMN rank            INTEGER;                      -- cached rank; NULL = outside the cap (or not yet computed)
ALTER TABLE farms ADD COLUMN growth          INTEGER NOT NULL DEFAULT 0;   -- cached 24h growth, refreshed with the rank
ALTER TABLE farms ADD COLUMN att_start       INTEGER NOT NULL DEFAULT 0;   -- chunk attempt window start (fixed hour)
ALTER TABLE farms ADD COLUMN att_n           INTEGER NOT NULL DEFAULT 0;

-- Existing farms: growth from the history at migration time, and treat the last sample as fresh.
UPDATE farms SET sampled_at = COALESCE((SELECT MAX(at_ms) FROM worth_history h WHERE h.farm_id = farms.id), 0),
  growth = net_worth - COALESCE(
    (SELECT h.net_worth FROM worth_history h WHERE h.farm_id = farms.id AND h.at_ms <= (CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 86400000) ORDER BY h.at_ms DESC, h.id DESC LIMIT 1),
    (SELECT h.net_worth FROM worth_history h WHERE h.farm_id = farms.id ORDER BY h.at_ms ASC, h.id ASC LIMIT 1),
    net_worth);

-- The 24h growth board reads this index (top N) instead of scanning every farm.
CREATE INDEX IF NOT EXISTS farms_growth ON farms (growth DESC, verified_at ASC, id ASC) WHERE verified_at IS NOT NULL;

-- Arena: players per medal, kept by submitEntry, so a board total never needs a scan.
ALTER TABLE challenges ADD COLUMN n_wealth  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE challenges ADD COLUMN n_speed   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE challenges ADD COLUMN n_brevity INTEGER NOT NULL DEFAULT 0;
UPDATE challenges SET
  n_wealth  = (SELECT COUNT(DISTINCT user_id) FROM entries e WHERE e.challenge_id = challenges.id),
  n_speed   = (SELECT COUNT(DISTINCT user_id) FROM entries e WHERE e.challenge_id = challenges.id AND e.par_tick IS NOT NULL),
  n_brevity = (SELECT COUNT(DISTINCT user_id) FROM entries e WHERE e.challenge_id = challenges.id AND e.tokens IS NOT NULL);
