-- E1b: the shared daily market (rules version 4, SIM_SPEC.md section 4).
-- challenges.market: the day's table as JSON { m, p, t, sh, n, from }. NULL on every rules v3 row (base prices).
-- entries.sold: units sold per item 1..7 as a JSON array of 7 integers, written at submit. NULL on older rows (ignored by the table).
-- NOTE: ADD COLUMN is not re-runnable. A crash between this script and its schema_version stamp needs a manual stamp.
ALTER TABLE challenges ADD COLUMN market TEXT;
ALTER TABLE entries ADD COLUMN sold TEXT;
