# Performance baseline (task P5)

Written 2026-11-16 on the PR #68 head (`d52f77c`). Purpose: make speed measurable before anyone tunes it.

## Open the meter

- Press **F3** in the game, or open any page with `?perf=1`. F3 again closes it. Off by default; when closed it removes its hooks, so it costs one null check per hook site.
- It shows fps, average and worst frame time over the last 2 seconds, draw calls and triangles (three.js `renderer.info`), device pixel ratio and canvas size, size of the last worker update and the update rate per second, and the time the farm view spent applying a snapshot. **Copy** puts the numbers on the clipboard as text.
- Update size is the JSON size of the worker's state message. The real structured-clone cost is not directly measurable, so treat it as a close proxy.

## Stress farm

- `?stress=1` is 100 plots and 32 bots, `?stress=small` is 16 plots and 8 bots. Combine: `?perf=1&stress=1`.
- Fixed seed (20261116), fixed Sprout program (`src/stress-farm.ts`), forced to the sandbox mode in its own keyspace (`sprout.v1.sandbox.stress.*`). It is never synced and never submitted anywhere. It rebuilds the same farm from scratch on every load (3000 ticks of warm-up for the full farm, 800 for the small one), then runs.
- Headless check of the build-up (node, no browser): full farm ends with 100 plots and 32 bots at tick 3000, hash `83d77bef`; small farm ends with 16 plots and 8 bots at tick 1000, hash `f8eaa378`.

## Size budget

`packages/client/perf-budget.json` holds the budget; `pnpm --filter @tendril/client size` (run in CI after the build) fails if the gzip size of the first-load scripts (entry, modulepreload chunks, sim worker) goes over it. `node scripts/check-size.mjs --update` rewrites it. It is set to today's size. **Tasks P1 and P2 must lower it to 409600 bytes (400 KB).**

## Baseline table

Cloud runs use software rendering (SwiftShader, no graphics chip), so frame rate there is meaningless. Fill the fps rows on the Mac (`pnpm dev`, then `/?perf=1&stress=1`, let it run 30 s, press Copy).

| Metric | Before (PR #68) | After P-tasks |
|---|---|---|
| First-load scripts, gzip | 1271 KB (1301610 B) | |
| Of which Monaco editor chunks | about 1007 KB | |
| Worker update, small stress farm | 137 KB | |
| Worker update, full stress farm | 864 KB | |
| Update rate, full stress farm | about 430 KB/s (headless run) | |
| Apply time, full stress farm | 6.0 ms (software GL box) | |
| Draw calls, small / full stress farm | 98 / 232 | |
| Triangles, small / full stress farm | 40,214 / 184,764 | |
| fps and frame time, small stress farm | Mac: _to fill in_ | |
| fps and frame time, full stress farm | Mac: _to fill in_ | |
| fps while idle on a normal farm | Mac: _to fill in_ | |
