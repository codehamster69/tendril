# F1 ground and sky (client only, 2026-11-26)

Branch `claude/project-thread-a54gog`. No sim, rules or replay change; golden hashes untouched.

## Files changed
- `packages/client/src/farm-ground.ts` (new): soil bed tile (two cos-profile furrow ridges per tile row, troughs on the tile edges so neighbours meet at one height, skirt so a run end has no hole), meadow slab, curved blade clump, clod cluster, world-space noise patch for soil and meadow (colour, soil lift, straw patches), `soilTint` (dry pale, wet dark).
- `farm-world.ts`: `tile_soil` and `tile_grass` batches now draw the new geometry (keys unchanged, so e2e lookups still work). Close zoom adds clods (tilled) and 2 to 4 grass clumps per untilled tile in patches, Field zoom adds 1 clump. The old furrow and tuft helper models and the `merge()` helper are gone. Map-zoom cell colours follow the new meadow green. Lens plates and guides sit above the furrow crests.
- `farm-overlay.ts`: new `grid` overlay. Tile outlines now show only in the Grid lens (they were always on at Close zoom). The Moisture lens already existed.
- `farm-hud.ts`, `farm-view.ts`, `lens.ts`: Grid lens in the select, accepted by `setLens`, key `6`; legend hides the colour bar for it.
- `farm-light.ts`: the canvas gradient background is gone. A sky dome follows the camera and is shaded by view direction in three stops (below horizon, horizon, zenith) taken from `renders/farm_scene_v2.py` TIMES (noon = hero, golden = evening, night; dawn is new in the same family). Fog takes the horizon colour. Golden and dawn suns are lower for longer shadows. Weather tint still applies to all three stops.
- `farm-scenery.ts` (`FarmIsland`): dark bed boxes removed, frontier is a plain thin line (no additive blending, no pulse), keel emissive and the tendril glow and pulse removed, tendrils are root brown for now (F2 replaces them). `pulse()` removed.
- `farm-ground.test.ts` (new, added to the `test` script).

## Checks
- `pnpm lint`: clean. `pnpm typecheck` (client): clean. `pnpm test` (client): 159 pass, 0 fail (render-budget included).
- e2e (Playwright, Chromium, swiftshader, CI=1): view, farm-hud, instruments, day-dial, app, integration, farm-recovers, farm-rests: 39 passed. The one failure along the way (view.spec "overlays use the full percentage range") was my meadow having no moisture tint; meadow now darkens up to 18 percent when wet.
- Real browser screenshots in `/mnt/project-files/workbench/F1/`: morning, noon, evening, night, rain, Moisture and Grid lenses, 1-plot and 6-plot farms, close zoom, desktop 1280x800 and phone 390x844 (noon, night, 6-plot).

## Decisions
- Beds are instanced per tile with identical edge height rather than merged per run: no run detection to rebuild, cost still follows the screen window, and the seam is invisible.
- Noise is computed from world position in the shader, so nothing is baked per tile and no grid shows. No per-tile colour jitter on meadow for the same reason.
- Rim meadow with blades is F2 (the 1.5 tile wild rim is built there); F1 covers untilled owned tiles.
- Night stars and clouds are not part of F1.
## Not done / for a person
- Nothing blocked. Sky colours are pre tone-map values like the Blender target, so they read a little flatter than the lit ground; tune in `PRESETS` if Rohan wants more contrast.
