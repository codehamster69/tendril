-- C3: "farm rests". Total ms this farm's clock has paused while its player was away longer than the 6 hour cap.
-- started_at never moves; the farm's target tick is (now - started_at - rested_ms) / 100. Only ever grows.
-- NOTE: ADD COLUMN is not re-runnable. A crash between this script and its schema_version stamp needs a manual stamp.
ALTER TABLE farms ADD COLUMN rested_ms INTEGER NOT NULL DEFAULT 0;
