# Task A: farm-camera

Files: `packages/client/src/farm-camera.ts`, `packages/client/src/farm-camera.test.ts` (new). Nothing else touched.

## Checks (real output)
- `pnpm exec eslint src/farm-camera.ts src/farm-camera.test.ts` (in packages/client): no output, exit 0.
- `pnpm exec tsc --noEmit -p .`: no errors in farm-camera files.
- `node --experimental-strip-types --test src/farm-camera.test.ts`: tests 12, suites 2, pass 12, fail 0.

## Implementation
API as in the contract. Pure exports: `defaultPose, placeCamera, groundPoint, applyLocked, easeFactor, fitDistance, autoPitch, wrapAngle, MIN_DIST, MIN_PITCH, MAX_PITCH`.
- Anchor lock, easing (rate 11, follow rate 5), grab-pan with momentum, right/middle/Ctrl/Alt orbit (pitch 0.5..1.3), pinch + midpoint pan, auto-tilt 0.6..1.12, tap (<4 px, <500 ms) calls `onTap`.
- No bounds: default pose 10,14,16 looking at 3.5,0,3.5, max distance 60, no target clamp.
- Bounds (tile edges, as `tileBounds` returns): target clamped to bounds plus margin max(3, 15% of extent); max distance max(30, 1.3 * fit); min 3; far grows with extent.
- `autoFramed()` is true from construction until the user pans, zooms, rotates, orbits, focuses or follows. While true, `setBounds` re-fits (snap on the first bounds) and an aspect change re-fits. So FarmView does not have to call `fit()` when land is bought: call `setBounds` only. `fit()` re-arms it.
- Reduced motion read from `matchMedia` inside `update` (snap).
- `visibleQuad`: corner rays, fallback to a half-height ray for horizon, reach clamped from the eye (default max(4*dist, 60)), y = 0.
- `onChange` fires from `update`/drag only when position, target, yaw or pitch moved more than 1e-4 (also once at construction).

## Decisions
- Keys are on `window`, ignored in input/textarea/select/contenteditable and with Ctrl/Meta/Alt. WASD pans. Plain arrows are NOT bound because the canvas uses them for tile navigation (`farm-view.ts` keyDown); Shift+arrows pan. Q/E rotate, +/- zoom about screen centre. Home and F are left to the HUD (task E), which calls `fit()` and `follow()`.
- Rotate is anchored at screen centre (lock at ndc 0,0); while following it rotates about the drone.
- Sets `touch-action: none` on the dom element and restores it on dispose.
- Source files avoid parameter properties/enums so `node --experimental-strip-types` can run the test.

## Open issues
- None known. Not tested in a real browser (integration task).

## Requests
- `packages/client/package.json` "test" script lists test files explicitly; add `src/farm-camera.test.ts` (and the other new tests) there. `pnpm test -- <file>` only appends the file to the fixed list after `--`, which node treats as a positional, so it does not run it alone. Run directly: `node --experimental-strip-types --test src/farm-camera.test.ts`.
- Integration: FarmView should replace the OrbitControls `change` listener with `camera.onChange`, read `farmCamera.target` / `camera.position` for `data-camera-*`, pass its tile-pick function as `onTap` (and drop its own pointerdown/up click handling), call `update(dt)` each frame before render, and call `setBounds(tileBounds(...))` on snapshots.
- e2e (view.spec.ts ~213-244, 402, 432): drag/target assertions may need review; `data-camera-target` semantic is the same (ground target).
