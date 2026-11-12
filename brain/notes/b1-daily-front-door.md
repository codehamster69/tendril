# B1 · Daily front door in the game

Changed: `packages/client/src/{arena.ts,share.ts,api-client.ts,game-loop.ts,main.ts,progression.ts}`, `electron/navigation.{cjs,test.cjs}`, `e2e/arena.spec.ts`.

- `?mode=daily` plays `d-<UTC date>`; `?mode=challenge&id=<d|s|x>-...` plays any challenge. Both use sim mode `daily`; storage key suffix is the challenge id. Challenge info comes from `GET /api/challenges/:id`; daily falls back to a local copy offline.
- World is built as the server builds it: `createWorld({id: challenge.id, seed}, challengeSetup(kind, seed).setup)`.
- `arena.ts`: header (number, time left, score to beat), Run to end, result panel. `submitRun()` is the single submit call (F2 retry hook goes there). Signed out: local replay via `replayWithPar` gives net worth, par tick, mosaic. Signed in: auto-submits and shows percentile/rank.
- `share.ts`: emoji mosaic and the Copy result text. No tokens line until C3, no streak until B5. Days before launch have number <= 0 and show as "Practice farm" / the challenge id.
- `GameLoop.runToEnd()` = `step(remaining)`: one worker command, one render. 3,000 ticks finish in well under 5 s in e2e.
- Navigation guard allows `mode=challenge` only with a single `id` matching `^[dsx]-[A-Za-z0-9-]{1,40}$`; `id` is refused with any other mode.
- Verified: lint, typecheck, navigation test, full Playwright suite (39 pass; `integration` live-clock test failed once under full-suite load and passes alone, also on main).
