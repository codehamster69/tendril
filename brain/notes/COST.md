# COST: Endless sync and ranking on the free tiers

Follows F2 (`brain/notes/F2.md`). Limits as F2 recorded them: Turso Free 10M rows written and 500M rows read per month. All numbers below are estimates from the code, not measurements; "rows" are logical table rows (F2's convention). Indexes add roughly one more per indexed column that changes.

## What changed

Endless sync (`packages/server/src/game.ts`, migration `004_cost_cuts.sql`):
- The farm row now carries the chunk attempt counter (fixed hour window, conditional UPDATE so races cannot exceed it), the not-yet-flushed action log, and the cached rank and 24h growth. `submission_attempts` is no longer used for chunks.
- The log is flushed into `chunks` when the buffer is 10 min old or 256 KB, so a sync is not an insert. Replay serves the buffer as the last chunk. A flushed chunk may span several syncs; replaying it is the same as replaying them one by one.
- A `worth_history` sample is written every 30 min (was every sync). The 24h growth baseline is still "latest sample at or before now-24h".
- Rank and growth are refreshed every 5 min. Rank is exact up to 500 (the query reads at most 500 rows from `farms_ranked`) and null beyond. Before: every sync counted all farms ahead, which is O(rank) reads per sync and the dominant read cost for deep farms.
- Growth board: new index `farms_growth`; both boards now read `LIMIT n` rows from an index. Before: every call scanned every farm and ran two lookups per farm.
- The server returns `nextSyncMs`: 15 s for rank 1-25, 60 s up to 500, 180 s beyond, x2 in lean mode, x4 in tight. The client follows it. The visible top of the board stays within about 15 s of live; the long tail is minutes behind.
- The budget guard projects writes from the farms that synced in the last 5 min and their tier, reading a hex-prefix slice of `farms` once the table is large.

Arena (`packages/server/src/arena.ts`):
- A player's rank is computed over the entries at or ahead of their own key (index range), not the whole challenge. Work is proportional to the rank, not the field. Totals come from per-challenge counters (`n_wealth`, `n_speed`, `n_brevity`).
- Boards above 300 players read about 3 x limit entries for the top rows, the viewer's own range for their row, a counter for the total, and a stored histogram refreshed every 5 min (computed once for a closed challenge). Smaller boards, friends and author filters use the old full computation, so their results are unchanged. A differential test checks the big path against the full one on 420 players with ties and shared logs.

## Before and after (per always-on player, Endless)

| | Before | After |
|---|---|---|
| Sync rate | every 15 s | 15 s (top 25), 60 s (to 500), 180 s (beyond) |
| Rows written per sync | 4 (farm, chunk, sample, attempt) | 1, plus 0.1 amortised (flush, sample) |
| Rows written per month, top 25 | 690k | about 190k |
| Rows written per month, rank 26-500 | 690k | about 47k |
| Rows written per month, rank 500+ | 690k | about 16k |
| Rows read per sync | up to rank (all farms ahead) | 0 (5 min refresh reads at most 500) |

Always-on players that fit in 8M writes a month (the guard's budget): before about 11. After: the top 25 cost 4.8M if all are always-on, which is the worst case and unlikely; with 25 always-on at the top plus N always-on below rank 500, N = (8M - 4.8M) / 16k = about 200. At a realistic 2 hours online a day (8% duty) the same budget carries roughly 2,500 players beyond the top 500, and in lean or tight mode the hints stretch automatically. Compared with 140 such players before, that is about 18x.

Reads for Endless: the board calls read N rows from an index (cached 30 s at the edge). The 5-minute rank refresh reads at most 500 rows: 8,640 refreshes a month x 500 = 4.3M reads per always-on deep player at worst, so 100 always-on deep players use under 100M.

## Arena reads

| | Before | After |
|---|---|---|
| Submit (rank) | window CTE over every entry, about 3N rows | index range up to the player's key, about rank rows (average N/2) |
| Board GET (open, big) | 3 full passes, about 15N rows per uncached call | about 3 x limit + rank rows, histogram once per 5 min |
| `players` in challenge info | scan | counter |

For P daily players with 3 submissions each, the submit cost was about 270 P^2 rows a month (F2) and is now roughly 22 P^2, so the 400M read allowance lasts to about 4,000 daily players instead of 1,200 on submits alone, and the board no longer scales with views. This is still quadratic in the field. When a daily field passes roughly 4,000 players, the next step is a maintained bucket-count table per challenge medal (rank = sum of better buckets plus an exact count inside the player's own bucket), which makes rank O(buckets). I did not build it now: it needs write-time bookkeeping in `submitEntry` and a backfill, and nothing in the first weeks will need it.

## Behaviour changes to know about
- `rank` in the chunk response can be null (client shows "outside the top 500"). Desktop 0.1.x prints it as "rank null" and keeps syncing every 15 s (about 1.1 rows per sync, still 3.6x cheaper than before).
- The growth board lags up to 5 min. The net worth board is as live as the last sync.
- Malformed chunk bodies (bad JSON, extra keys, oversize) no longer use an attempt, because they are refused before any database work. A chunk that reaches verification and fails still counts, and costs one write.
- Requests for another player's farm id answer 403 without counting against anyone.
- Migration 004 uses `ALTER TABLE ADD COLUMN`, which is not re-runnable: a crash between the script and its `schema_version` stamp needs a manual stamp.
- `LEGACY_GRACE_MS` and the F2 retention rules are untouched.
