-- F1: self-generating challenges. setup_v says how the challenge's starting conditions are derived from its seed:
-- 0 = the plain farm (every challenge created before modifiers, so old entries replay exactly as before),
-- 1 = the seed-drawn modifiers of SIM_SPEC.md "Challenge modifiers". New rows are written with 1 by the server.
-- NOTE: ADD COLUMN is not re-runnable. A crash between this script and its schema_version stamp needs a manual stamp.
ALTER TABLE challenges ADD COLUMN setup_v INTEGER NOT NULL DEFAULT 0;
