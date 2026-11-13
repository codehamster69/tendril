# Directory brain / map

Update this after every workstream lands. Do not explore the whole repo: find the relevant file here.

## Root
- `package.json`: dev/dev:server, test/typecheck/lint/build, assets:copy, E2E/Electron/check gate; coordinator owns deps and lockfile.
- `eslint.config.mjs`: TypeScript ESLint recommended rules, browser/worker/node globals, generated outputs ignored.
- `scripts/copy-assets.mjs`: validates sidecar triangle budgets, generates manifest, copies GLBs to client/public/models.
- `scripts/validate-assets.mjs`: checks exact39GLBs, actual geometry triangle parity, sidecars, budgets and256pxthumbnail PNGs.
- `pnpm-workspace.yaml`: includes `packages/*`.
- `pnpm-lock.yaml`: coordinator only. Agents request dependency changes in their notes.
- `.gitignore`: node_modules, dist, release, generated public/models, .env*, test results.
- `AGENTS.md` and `CLAUDE.md`: entry instructions; point to this brain.
- `docs/PLAN.md`: original Fable design (copied, not edited).
- `docs/SIM_SPEC.md`: exact version-2 deterministic rules, API, Lua API and action-log format (173 lines).

## Simulation: packages/sim
- `src/index.ts`: safe server entry. Exports rules, types, createWorld/applyAction/tickWorld, queries, hash, replay, snapshot. No Lua.
- `src/local.ts`: local-only entry, re-exports index.ts plus Lua.
- `src/rules.ts`: RULES_VERSION, crop definitions, action costs, plot/bot price formulas.
- `src/types.ts`: World, Snapshot, LogEntry, Bot, Plot, Order, IllegalAction.
- `src/world.ts`: createWorld, tickWorld (orders only), applyAction (validates then mutates), queries. Most logic is here (222 lines).
- `src/tiles.ts`: typed-array layout, tile hashing, plot lookup and lazy soil/growth settling.
- `src/weather.ts`: xorshift32, generated weather segments, rain/frost interval counting, forecast.
- `src/hash.ts`: FNV-1a state hash; JSON serialize/deserialize.
- `src/replay.ts`: replayChunk. Mutates; discard the world if it throws.
- `src/snapshot.ts`: renderer snapshot. Settles copies, never mutates the hashed tile state.
- `src/lua.ts`: wasmoon engine and prelude. One Lua coroutine per bot. Actions yield, queries are free. All scripts run locally, never on the server (261 lines).
- `src/cli.ts`: CLI run and replay, prints hash/coins/netWorth/action count, optional JSON log.
- `examples/starter.lua`: single-bot carrot snake, harvest/deposit/sell.
- `examples/expander.lua`: restart-safe rotation and auto-expansion, multiple bots.
- `test/actions.test.ts`: all action results, tick costs, invalid args.
- `test/lazy.test.ts`: crop growth, soil, frost, rain, lazy settle equivalence.
- `test/replay.test.ts`: replay validity, chunking, illegal moves.
- `test/determinism.test.ts`, `queries.test.ts`: seed determinism, no query hash mutation.
- `test/economy.test.ts`, `orders.test.ts`: costs, net worth, contracts.
- `test/lua.test.ts`: API, examples, replay parity, errors, isolation, restart safety. Timing limit is flaky (D-008).
- `test/cli.test.ts`, `perf.test.ts`, `helpers.ts`: CLI, benchmarks, common test helpers.

## Client: packages/client
- `src/main.ts`: bootstrap. Picks the mode (live/Endless, sandbox, campaign, daily, `?mode=challenge&id=` for season and duels), mounts editor, view, loop, arena card, account, auto sync, Join duel and site links.
- `src/game-loop.ts`, `real-sim.ts`, `sim-worker.ts`, `sim-protocol.ts`: buttons and pacing, worker wrapper with reply watchdog, the Sprout worker.
- `src/autosync.ts`: Endless ranked farm sync (every 15 s, back-to-back while far behind).
- `src/arena.ts`: daily/season/duel card (run to end, submit, result, Hide/Show details, market panel). `duel.ts`: Challenge a friend and the duel panel. `join-duel.ts` + `duel-id.ts`: Join duel dialog and link parser.
- `src/replay-main.ts`, `replay-view.ts`, `clip.ts`: `replay.html` (replay, ghost race `?e=&vs=`, Export clip). `room-main.ts`, `room.ts`, `room-core.ts`: `room.html` (up to 16 farms on one clock).
- `src/account.ts`, `api-client.ts`: sign-in (web cookie, desktop token), `wireSiteLinks` opens site pages in the system browser on desktop.
- `src/progression.ts`: campaign, research, achievements (anything true at a challenge's first snapshot is not awarded).
- `electron/`: hardened main process; `navigation.cjs` allows app navigation, `isAllowedExternalURL` and `isAllowedSiteURL` for the system browser; `updater.cjs` self-update.
- `e2e/*.spec.ts`: Playwright (mocked API); `e2e/electron-smoke.mjs`: desktop smoke.

## Server: packages/server (workstream S)
- `package.json`: sim workspace dependency, PGlite/Vitest/TS dev deps.
- `tsconfig.json`: copied sim config (strict, `.ts` imports allowed).
- `src/index.ts`: createApp/initializeDb/Auth/FarmResponse/LeaderEntry exports.
- `src/app.ts`: Fetch Request/Response handlers, routes/security headers/loopback CORS.
- `src/auth.ts`: random opaque local tokens, SHA256 storage, injectable authentication.
- `src/db.ts`: idempotent migrations, transaction-local service role, safe bigint conversion.
- `src/validation.ts`: raw stream/request bounds, strict body/action shape, UUID/query validation.
- `src/game.ts`: locked clone replay, rate accounting, farm/checkpoint/scores/history/replay queries.
- `src/dev.ts`: persistent PGlite local HTTP runner127.0.0.1:8787; no hosted service.
- `migrations/001_game.{up,down}.sql`: real Postgres schema/roles/RLS/indexes; preserve platform roles/auth.uid on DOWN.
- `test/server.test.ts`: 59real-PGlite integration/security checks (coordinator repeated successfully).
- `brain/notes/S.md`: full implementation/assumptions/commands, pending zero-span fix; S-review.md review pending.

## Assets (workstreams AT, AC, AB)
- `assets/scripts/common.py`: tested Blender helpers and PALETTE. reset/mat/paint/cube/cyl/cone/sphere/rotate/build/finalize. Budget checks, sidecar JSON, GLB and thumbnail. Read this before any asset work.
- `assets/scripts/make_manifest.py`: plain Python merges sidecars into export/manifest.json.
- `assets/scripts/tiles_props.py`: AT owns (5 tiles + 5 props).
- `assets/scripts/crops.py`: AC owns (5 crops x 4 stages).
- `assets/scripts/bots_buildings.py`: AB owns (4 bots + 5 buildings).
- `assets/export/`: generated GLBs, sidecar JSON and manifest. Tracked source assets.
- `assets/thumbs/`: generated PNGs for visual review.
- `packages/client/public/models/`: copied from export before build (generated, ignored).

## Brain
- `README.md`: takeover reading order and rules.
- `STATUS.md`: in-flight ownership and verification state.
- `CONTRACTS.md`: module seams; authoritative alongside SIM_SPEC.
- `DECISIONS.md`: append-only decisions (D-001 onward).
- `JOURNAL.md`: append-only progress.
- `BACKLOG.md`: remaining campaign/tier5/leagues/hosted-auth milestones and proposed interfaces, not approved balance decisions.
- `notes/<workstream>.md`: each agent's own change/report/decision file; coordinator integrates.
