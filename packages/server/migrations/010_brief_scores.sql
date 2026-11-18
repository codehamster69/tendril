-- K4: daily briefs. Per-entry scores over the visible farm and the hidden farms (K3 fills them).
--   score          visible-farm score; NULL on old rows (read as net_worth)
--   final_score    sum over visible + hidden farms, NULL until the hidden checks are done
--   final_par_tick sum of par ticks over all farms, NULL if par was not reached on every farm
--   hidden_done    1 once the hidden-farm checks of this entry finished
-- NOTE: ADD COLUMN is not re-runnable. A crash between this script and its schema_version stamp needs a manual stamp.
ALTER TABLE entries ADD COLUMN score INTEGER;
ALTER TABLE entries ADD COLUMN final_score INTEGER;
ALTER TABLE entries ADD COLUMN final_par_tick INTEGER;
ALTER TABLE entries ADD COLUMN hidden_done INTEGER NOT NULL DEFAULT 0;
