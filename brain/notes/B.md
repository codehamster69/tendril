# Task B: farm-light.ts + farm-scenery.ts

## Files
- `packages/client/src/farm-light.ts` (new): `FarmLight`, `LightPreset`, `Weather`.
- `packages/client/src/farm-scenery.ts`: kept `tileBounds`, `sceneryPlacements`, `Bounds`, `Placement` unchanged; added `FarmIsland`.

## Checks (real output)
- `pnpm exec eslint src/farm-light.ts src/farm-scenery.ts`: clean (exit 0).
- `tsc --noEmit` filtered to these files: no errors.
- `pnpm --filter @tendril/client test`: pass 13, fail 0 (no existing test imports farm-scenery).
- Rendered with Playwright/swiftshader through an esbuild bundle (scratchpad, not in repo): golden, noon, night, rain looked right on a stand-in tile mesh.

## Decisions
- r187: `PCFSoftShadowMap` was removed, so `PCFShadowMap` is used. Intensities = mockup values x `SUN_K` 2.6 / `HEMI_K` 2.4; noon, night, golden values and hemisphere ground colours retuned by screenshot (noon was blown out, night and the keel were black).
- `FarmLight` takes an optional third arg `{ shadows?: boolean }` (small replay/room views: shadows off, no shadow-map cost). `shadowsOn` also turns false past distance 140 (back on under 120). Weather tints the preset target; reduced motion snaps preset/weather changes. Sky is a 2x256 canvas gradient with sRGB colour space. Fog near/far scale with distance and open up smoothly between distance 40 and 90.
- `FarmIsland`: slab = bounding rectangle. Layers: grass cap (top y -0.04), soil lip, two strata, two-piece faceted keel, merged teal tendrils (single mesh), four additive frontier bars (y 0.06, thickness `max(0.09, d*0.003)`). Keel height capped 48, tendril reach 28, tendril count 40, so cost is constant for any farm size.
- Non-rectangular land: the cap is meadow everywhere. Dark "bed" plates (one InstancedMesh) go under owned tiles so gaps read as a grid; built only when the rectangle is <= 16,384 cells (scan limit), otherwise skipped (gaps show meadow green, invisible at that scale). Rebuilt only when bounds or the owned set change. Call `update` on snapshot change, not per frame; `pulse(time)` and `setDistance(d)` are cheap per-frame calls.
- Tile tops are at y 0 and the cap top at -0.04, so tiles in farm-world must keep the 0.94 box with bottom at -0.3 as in the mockup.
- Trees/rocks: not part of the island (they would float outside a floating slab). `sceneryPlacements` still returns them plus terrace walls; the integration should ignore `tile_terrace_wall` and may drop the props.

## Open issues
- Frontier is drawn on the bounding rectangle only.
- Sun shadow window is capped at 36 units; beyond that shadows are off anyway at distance 140.

## Requests
- Integration (I): remove meadow plane + terrace wall batches from `farm-view.ts`; construct `new FarmLight(scene, renderer, { shadows: false })` for small views; call `light.update(dt, focus, camera distance)` each frame, `island.update(bounds, owned)` on snapshot change, `island.setDistance(d)` and `island.pulse(time)` per frame; `light.glow` feeds drones/fx.
