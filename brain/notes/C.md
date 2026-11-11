# C — client integration (2026-11-11)

Root: `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8`. Original project untouched; no commits/pushes/delegation.

## Changes
- `packages/client/src/main.ts`, `game-loop.ts`: RealSim bootstrap, async init, current-farm Lua recompilation, durable pause (including cancellation of a pending Run), confirmed live reset, separate sandbox, exact 100-tick step, examples, localhost/dev `window.tendril`, and `tendril:snapshot` events. Public loop seams remain available; pause returns a Promise for settled state.
- `src/real-sim.ts`, `sim-worker.ts`, `sim-protocol.ts`, `store.ts`, `clock.ts`: FIFO commands include the actual strict-durability IndexedDB transaction. Every completed worker command saves checkpoint, metadata, source, hash and all pending logs atomically. No 200-chunk eviction; idle intervals are retained too. `flush(): Promise<void>` waits through in-flight work and durable commit. Explicit reset replaces keys atomically instead of deleting first. Save failures retain in-memory actions, stop stepping and permit Pause/save retry. Damaged clocks are reported rather than silently replaced.
- `src/editor.ts`, `index.html`, `src/style.css`: greenhouse palette, restrained Georgia title, farm-first responsive workbench and soil/market cassettes; Lua completion, per-mode persisted drafts, storage warnings and correct line markers. Existing WIP retained; `sim-types.ts` needed no changes.
- `e2e/app.spec.ts`, new `e2e/integration.spec.ts`: real Lua harvest/sale/replay parity, snapshots, errors, restart, >200 logs, failed-save recovery, compile/pause race, damaged-save recovery, clock gating and reset. Fresh contexts; sandbox except the clock test; no camera pixel golden.
- Authorized local ignore only: `.git/info/exclude` now ignores `/packages/client/dist-C/`.

## Decisions / seam refinements
Worker commands/responses carry `id`; state has explicit `fromTick`, `fromHash`, end `hash`, and mandatory serialized `saved`; reset also carries emitted `wasmUrl` for recovery before successful init. SimError optionally carries `kind: lua|storage|worker`. RealSim adds copied `logChunks()`, `hash`, `durableTick`, `persistenceError`; removes unused clock-mutating `setStartedAt`. Both loop and RealSim gate live ticks at 10 TPS. Speed only changes bounded catch-up pacing; local live is explicitly unverified, never ranked. Engine import remains local.ts in the worker.

## Actual checks
- `pnpm --filter @tendril/client typecheck`: initial exit 2, six concurrent errors in asset-loader.ts/inspectors.ts; subsequent and final runs exit 0.
- `pnpm --filter @tendril/client build`: both runs exit 0; 39 models copied and glue WASM emitted. Vite warns that wasmoon's Node `module` import is externalized; browser error test passes.
- `PW_PORT=4177 PW_OUT=dist-C pnpm --filter @tendril/client test:e2e`: first exit 1, 10 passed/4 failed/1 skipped. Fixed C's premature paused status and unstable Monaco targeting. Final exit 1: **21 passed, 2 failed, 1 skipped; all 14 C tests pass** (36.6s), without retries. Both remaining failures are concurrent `e2e/instruments.spec.ts`: `#farm-inspector` missing, sandbox and live. Tests were not removed or hidden.
- Explicit-file ESLint over all C TypeScript/tests: initial one preserve-caught-error failure; added Error cause; final exit 0. `git diff --check` clean. Port 4177 has no remaining listener.

## Handoff / open issues
Coordinator must resolve mounting of inspector/reference modules in the C-owned bootstrap/layout before the full gate can pass; those modules/tests are outside this assignment. Investigation questions: which owner should wire them, and what approved placement avoids duplicating the soil/market cassettes? No guessed integration added.

Independent acceptance: run sandbox Lua, step to a sale, edit/run without reset, pause during compilation, reload saved state, and verify live reset cancellation. Use one active window per mode: cross-tab ownership is not implemented. Retained unsubmitted history can eventually exhaust storage; the app stops with a visible failure rather than dropping logs. Backend submission/acknowledgement is deferred. Last in-flight work at abrupt close may fall back to the last complete checkpoint. CSS respects reduced motion; renderer motion belongs to farm-view's owner.

Reviewed Playwright screenshots:
- `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/client/test-results/app-greenhouse-loads-a-real-farm-and-a-nonblank-canvas/greenhouse.png`
- `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/client/test-results/app-mobile-layout-stays-us-8644a-rd-focus-and-reduced-motion/greenhouse-mobile.png`
