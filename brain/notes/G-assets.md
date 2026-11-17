# Redesign task G: assets (island style)

(`brain/notes/G.md` already holds an older workstream's report, so this one is `G-assets.md`.)

## Files
- New: `assets/scripts/gen/{lib,models,tint,build,render}.mjs`. Pure Node, no Blender, no deps. Header of `build.mjs` documents usage. Run: `node assets/scripts/gen/build.mjs`, then `node assets/scripts/gen/render.mjs brain/notes/farm-redesign-shots/assets.png` (thumbnails + contact sheet, Chromium + three GLTFLoader), then `pnpm assets:check && pnpm assets:copy`.
- Regenerated `assets/export/*` (GLB + sidecar), `assets/thumbs/*.png` (re-rendered from the GLBs, 256 px, transparent), `packages/client/public/models/*` (copied), `packages/client/src/fallback-models.ts`.
- `scripts/validate-assets.mjs` and `scripts/copy-assets.mjs` unchanged. Old Python/Blender scripts left in place (no longer the source of truth for the redrawn models).
- Shot: `brain/notes/farm-redesign-shots/assets.png`.

## Check output
```
$ pnpm assets:check   -> Validated 57 GLBs, sidecars and thumbnails; 13160 triangles
$ pnpm assets:copy    -> Copied 57 models
$ eslint fallback-models.ts: clean; client typecheck: no errors in fallback-models.ts
```
Before this task `assets:check` already failed: the validator expected 29 models that were never exported (crop_apple_s0..3, item_honey, item_compost, tile_water, prop_greenhouse/windmill/silo/well/scarecrow/pond/flowers/bush/lamp/cart/hay). They are now all generated.

## What changed
- tile_grass/soil/wet/path/water: flat top 0.94 wide, 0.03 chamfer, 0.3 deep, soil body, a few flat decals (20-36 tris). No gap baked beyond the 0.94 width. Depth is 0.3 (was 0.2), matching the mockup box.
- crop_* x 6 x 4 stages (carrot, wheat, clover, pumpkin, berry, apple): the mockup clusters, stage drives size and parts (heads, blossoms, fruit). All <= 282/300 tris.
- bot_tender (+v1..v3): lantern drone, cream hull, emissive amber core in a gold cage, teal band, leaf blades (v3 has 5), v1 satchel, v2 headlamp and fins, v3 leaf crown. 570 to 834 tris.
- prop_barn (gabled, loft window, door braces, vine), prop_market (striped awning, sign board, produce), prop_beehive (skep), prop_compost (slatted bin), item_honey, item_compost, plus 11 new props.
- tree, rocks, fence, crate, signpost, water_tank, terrace_wall: geometry untouched, materials recoloured to the palette by `tint.mjs` (runs at the end of build, idempotent).

## Conventions and decisions
- Y up, origin on tile centre at ground, sidecar `size = [x, depth, height]` as before.
- Each model has one white matte material plus COLOR_0 vertex colours (linear), and an emissive `glow` material (lantern parts). A loader that swaps materials must set `vertexColors: true`; the stock GLTFLoader already does.
- The drone origin is the hull centre (blades +0.2, core -0.1, cage bottom -0.2), not the ground. The renderer adds its own hover height (mockup: 0.8). Blades are baked (no animation allowed by the validator).
- Fallbacks (`fallback-models.ts`) mirror the same shapes with flat-shaded matte parts; exports (`CROPS`, `ITEM_NAMES`, `BUILDING_MODELS`, `CROP_COLORS`, `matte`, `part`) unchanged. Only item_honey/item_compost have GLBs; other `item_*` use a fallback jar.

## Open issues
- Contact sheet fits each model to its own thumbnail, so relative scale is not shown there.
- Sign board on prop_market is a plain dark panel; FarmMarket should draw its canvas sign over it (board centre (0, 0.82, -0.14), 0.6 x 0.26, facing +z).

## Requests
- Task D (drones): use the hull-centre origin above; hide or ignore the baked blades if you spin your own (they cannot be separated from the GLB).
- Task C (world): tiles are 0.3 deep with top at y = 0 and need white-material vertex colours (or your own material with `vertexColors: true`); per-tile tint via instance colour multiplies on top.
- Root `package.json` could get `"assets:build": "node assets/scripts/gen/build.mjs"` (not mine to edit).
