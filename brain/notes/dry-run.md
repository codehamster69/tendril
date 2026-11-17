# Dry run (Endless farms)

Approved by Rohan 2026-11-17. A client-only "Dry run" button on live farms (ranked and local).

## What it does
- Transport bar button `#tp-dryrun` (live mode only, not on stress farms) opens a card (`#dry-run`).
- Copies the real farm's last durable checkpoint (`RealSim.durableWorld()`), then in its own worker
  (`dry-run-worker.ts`) plays the code running now (`GameLoop.runningSource`) and the editor text on two
  identical copies for 1,000 / 3,000 / 10,000 ticks (max 20,000).
- Card shows: coins and net worth per 1,000 ticks, plots at the end, share of bot time spent walking, crashed bots
  (with the first error line), plus a one-line verdict.
- Apply code calls `loop.run()` (normal compile + every bot restarts) and is disabled when the editor text changed
  since the dry run, the new code does not compile, or it is already running.
- Nothing is persisted or sent to the server; no sim rule changes. The real farm keeps ticking during the run.

## Files
- `packages/client/src/dry-run-core.ts` (DOM-free runner + rows/verdict), `dry-run-worker.ts`, `dry-run.ts` (UI), `dry-run.css`.
- `real-sim.ts`: `durableWorld()`. `game-loop.ts`: `runningSource`. `main.ts`: mount after the stage.
- Tests: `src/dry-run.test.ts` (needs `--experimental-transform-types`, since it imports the Sprout interpreter),
  `e2e/dry-run.spec.ts`.

## Notes
- Walking share = move ops x 2 ticks / (bots x ticks). Bots bought mid-slice count from that slice's start.
- Both runs restart the program from the top (as Apply does), so "code now" is a fair forecast, not a replay of the
  live run's exact position.
- 10,000 ticks x 2 on a young farm took ~4.5 s in headless Chromium.
