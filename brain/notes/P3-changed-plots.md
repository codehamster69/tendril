# P3: send only changed farm plots

Files changed: `packages/sim/src/snapshot.ts` (additions: `viewPlot`, `viewBot`, `viewScalars`) and `index.ts` (exports); client `sim-protocol.ts` (ViewUpdate, VIEW_VERSION=1, events), new `view-codec.ts` (worker `ViewEncoder`, main `ViewStore`), `sim-worker.ts`, `real-sim.ts`, `sim-types.ts`, `game-loop.ts` (emits `tendril:events`), `farm-world.ts` (`setSnapshot` takes only changed tiles when given a view snapshot), `farm-view.ts` (three `snapshot.tiles.length` reads became `world.tileCount`, nothing else), new `view-codec.test.ts`, `package.json` (test list).

Decisions
- Worker keeps the last-sent Int32Array per plot and per bot and sends only those that differ. Typed arrays are transferred. Tile ints per tile: tilled, crop, stage, moisture, nitrogen, fatigue, building, honey (all of SnapshotTile, so the old shape is rebuilt exactly).
- Update sequence `seq`/`base`: a delta that does not follow the last one, or another VIEW_VERSION, makes RealSim ask the worker for `fullView`. Full views also go out on init and reset.
- Rate limit: unchanged mechanism. The worker answers each command with one update and the game loop requests at most one step per frame, so at 16x it simulates a longer step and sends only the final state.
- Events (harvest, sale, order filled, script error) come from the action log and errors of the step. `RealSim.drainEvents()`; game-loop emits `tendril:events` with `[kind, tick, bot, a, b]`. Harvest carries no item yet (the log has none).
- Old panels still get a full `Snapshot` shape (`ViewStore.latest()`): tile objects of unchanged tiles are shared, only changed tiles are new objects. `delta.since(version)` lets FarmWorld catch up across skipped snapshots, or rebuild when the history is too short.
- Per-bot current line and state are not in the view: they already travel as `debug` in the state message.

Verification: sim 96 tests, client 66 node tests (incl. 5 new), typecheck, lint, build pass. Playwright (app, integration, view, farm-hud, 32 tests, real worker) pass. The other e2e specs were not run.

Open: `saved: serialize(world)` still travels in every state message and grows with the farm (141 KB per message at 100 plots). It is the next lag suspect and is persistence, so it was left alone. `inspectors.ts` still walks every tile on each snapshot event.
