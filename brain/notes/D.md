# Task D: farm-drones.ts + farm-fx.ts

## Files
- `packages/client/src/farm-drones.ts` (new): `FarmDrones`, pure helpers.
- `packages/client/src/farm-fx.ts` (new): `FarmFx`, pure helpers.
- `packages/client/src/farm-drones.test.ts` (new): 9 tests of the pure helpers. NOT yet in the `test` script in `packages/client/package.json` (see Requests).

## Checks (run in packages/client)
- `node --experimental-strip-types --test src/farm-drones.test.ts`: tests 9, pass 9, fail 0.
- `pnpm exec eslint src/farm-drones.ts src/farm-fx.ts src/farm-drones.test.ts`: clean.
- `pnpm exec tsc --noEmit -p .`: no errors in the two new files (others not checked).
- Not run in a browser or WebGL; visual tuning (trail brightness, halo, hover) is by port from the mockup only.

## API (as in the contract, plus additions)
- `new FarmDrones(scene, model, fx?)`: optional shared `FarmFx`. Without it the drones create and drive their own; with it the host calls `fx.update(dt, time, focus, glow, scale)` and disposes it.
- Added: `setFocus(x, z)` (camera focus for fireflies, only used when drones own the fx; default = centroid of drones), `effects` getter (for harvest bursts), exported `DRONE_HOVER = 0.75` (hull centre height; stack carried-item markers above this, e.g. `DRONE_HOVER + 0.05 + level * 0.17`), `droneViewScale(tilePx)` (helper to compute the `viewScale` argument: 1 up close, grows so a drone stays about 12 px at Map zoom, max 40).
- `FarmFx.update(dt, time, focus, glow, scale)`; `burst(x, y, z, hex, n = 8)`.
- `setBots(bots, tickDelta = 1)`: fires a spark burst when a bot's `op` changes to till/plant/water/harvest/deposit/deliver/build/clear/compost/fertilize (harvest bigger). New drones start at their position (no fly-in, no burst). Jumps over 12 tiles snap. `tickDelta` > 1 speeds the catch-up easing by sqrt.
- `position(id)` returns the eased position (pass it to the carried-item placement and selection).
- `trails` flag hides/shows ribbons. Ribbon: 44 points, additive, colour per drone from a 6-colour cycle (`DRONE_COLORS`, same as the mockup), written in place into preallocated buffers.

## Behaviour kept from farm-view.ts
- Exponential easing (rate 12), selection ring (torus 0.37 at the drone's ground position, scaled with viewScale), carried items follow `position(id)`.
- Reduced motion (`prefers-reduced-motion`, read live): drones snap to targets, no bob, no lean, blades stop, trails hidden, fx bursts skipped, fireflies do not drift.
- GLB: when `model()` returns a model, every drone is rebuilt from it (shared geometry and materials, not disposed here; the loader owns them). The model is centred vertically on its bounding box so it hovers at `DRONE_HOVER` whatever its origin. No blade spin for the GLB (static mesh); halo, beam, shadow blob and trail still apply.

## Decisions
- Fireflies: 160 points in a 48 tile square (grows with sqrt of viewScale) wrapped around the focus, so they follow the camera over an unbounded farm at constant cost. Opacity from `glow`.
- Particle pool 500, fading by dimming the additive colour as life runs out.
- No allocation per frame (typed arrays, reused objects). Per drone cost is a handful of draw calls; trails are one mesh each.

## Open issues
- Per-drone trail rebuild runs every frame while visible (44 points x 2); fine for the handful of drones, revisit if a room view shows many.
- GLB bot rotor blades will not spin until task G's model exposes a named rotor node (could look for a node named `rotor`; GLB parts are currently flattened by `asset-loader`, so this needs an asset-loader change).
- Bot "busy" is derived from `op` only; the snapshot also has `busyUntil` but without the current tick it cannot be used here.

## Requests
- `packages/client/package.json` `test` script: add `src/farm-drones.test.ts` to the list.
- Integration (I): replace `botRing`/`botPositions` usage with `FarmDrones.position/setSelected`; keep the item_* carried markers using `position(id)` and `DRONE_HOVER`; call `drones.update(dt, time, light.glow, droneViewScale(tilePx))` each frame and `drones.setFocus(camera.target.x, camera.target.z)`.
