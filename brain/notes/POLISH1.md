# POLISH1: camera follows growth, healthier examples

## Files changed
- packages/client/src/farm-view.ts: auto re-frame when plot count rises and camera untouched (600 ms smoothstep, keeps view angle); first framing instant; `focusFarm()` re-frames and re-arms; adds `data-camera-position` on the canvas (next to existing `data-camera-target`).
- packages/client/e2e/view.spec.ts: old "expansion does not pan" test updated (expansion now re-frames); 2 new app tests (all plot corners project inside canvas; manual drag then purchase leaves camera put).
- packages/client/e2e/screenshot.png: regenerated (sandbox, expander, 60 s at 64x).
- packages/lang/examples/expander.sprout, starter.sprout rewritten (no golden hashes exist, none regenerated).
- packages/lang/test/example-health.ts (helper, `measureExample`), example-health.test.ts (report with `HEALTH=1`, plus health assertions).

## Camera
User-moved detection: camera pose is compared with the pose recorded after the last automatic framing (no extra events); OrbitControls `start` cancels an ease in progress. Deviation: main.ts is outside my scope, so tests project corners from canvas data attributes (position, target, fov 42, aspect) rather than a new `window.tendril` field.

## Examples (seed 7, no research/fixtures)
| example | ticks | netWorth before | after | plots/bots after | N/fatigue before | N/fatigue after |
|---|---|---|---|---|---|---|
| expander | 50k | 45,230 | 519,457 | 14/25 | 0/99 | 32/0 |
| expander | 100k | 70,031 | 1,004,613 | 18/30 | 0/99 | 32/0 |
| expander | 200k | 119,501 | 1,941,565 | 23/37 | 0/99 | 31/0 |
| starter | 200k | 27,884 | 38,150 | 1/1 | 1/98 | 91/38 |
Ripe-unharvested at 200k: expander 222 -> 954 (of ~1470 tiles; land grows faster than one row of bots can walk it), starter 47 -> 58. Other examples (daily, orders) unchanged; compost/orchard need research and earn 0 without fixtures.
Expander 200k/100k = 1.93 (> 1.8). Soil health is the win; the ripe backlog is the remaining weakness (plots are a single row, long walks).

## Verification
lint, typecheck, build exit 0. lang 12 passed/1 skipped; sim 48; e2e 29 passed, 0 failed, 1 skipped (shot). `pnpm test` exits 1 only from packages/server test/attack.test.ts (2 failures, coordinator's in-progress file); server otherwise 377 passed.
