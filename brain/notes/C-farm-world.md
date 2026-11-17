# Task C: farm-world (view-window renderer)

(File is `C-farm-world.md` because `brain/notes/C.md` already holds the 2026-11-11 client-integration note.)

## Files
- `packages/client/src/farm-world.ts` (new): `FarmWorld`, plus pure `lodFor`, `fitWindow`, `viewWindow`, `lensColor`.
- `packages/client/src/farm-world.test.ts` (new, node:test).
- `packages/client/src/farm-overlay.ts`: `update(tiles, overlay, guideLines = true)`, new `overlayColor()`, `MAX_OVERLAY` (20,000 cap), real `dispose()`, `.ts` import suffixes, no parameter property (node strip-types).

## Behaviour
- Store: Map of 32x32 chunks (`"cx,cy"`) holding `Map<"x,y", SnapshotTile>`. `setSnapshot` is one comparison per tile, unchanged tiles keep identity, only changed tiles bump `version`; a sweep runs only when the stored count differs from the snapshot length.
- `refresh` window = screen quad bounding box cut to the land that exists, then `fitWindow` doubles stride until cells <= 14,000. Only stored chunks are visited (grid walk or store walk, whichever is smaller). Stride > 1 or Map LOD: one coloured cell per block (best tile: ripe > growing > tilled > any); a dense farm with > 56,000 tiles under a merged window samples the cell centre instead of reading every tile.
- LOD 0 Close (>= 28 px): tile models, furrows (one instance per tilled tile), tufts, crop models, buildings, honey, barn at (0,0). LOD 1 Field: same without furrows/tufts, overlay guides stay. LOD 2 Map: cells only.
- Crop sway: cloned crop materials, `onBeforeCompile` vertex shader from `instanceMatrix`; uniforms `uTime` (set each `refresh`) and `uSway`. Off by default under `prefers-reduced-motion` (also removes pulses).
- Price lens: active when `priceMultipliers` is non-null (caller keeps `overlay: 'none'`). Ripe crops get a coloured pad (blue 0.5, pale 1, orange 2) and everything else is dimmed 0.55 via instance colours; at Map the cell colour does it.
- Soil lens: existing `OverlayLayer`, owned by the world, fed only the visible tiles; at Map/merged cells the lens colour is applied to the cell itself. `world.overlayMesh` replaces `FarmView.overlayMesh`.
- `refresh` is cheap when nothing changed (signature of data version, window, lod, lens, overlay, 8 Hz pulse bucket, model identity), so the caller can call it every frame; it must still be called every frame for crop sway time.
- No mesh exceeds 20,000 instances (tested).

## Checks (real output)
- `pnpm exec eslint farm-world.ts farm-world.test.ts farm-overlay.ts`: no output (clean).
- `node --experimental-strip-types --test src/farm-world.test.ts`: tests 11, suites 6, pass 11, fail 0 (includes 100,000 x 100,000 sparse farm with 1,000 tiles: Map LOD, stride > 1, cells <= 14,000, total and per-mesh instances <= 20,000; and a 400x400 dense farm).
- `pnpm --filter @tendril/client typecheck`: no errors in my files.
- Headless Chromium (swiftshader) render of an 8x8 farm with fallback models: 29 draw calls, `gl.getError() == 0`, no console errors (sway shader compiles); screenshot looked right.

## Decisions
- `models(name)` must return a stable object per name (fallback cache); the world rebuilds a batch when the returned object changes (GLB arrived), detected on the next `refresh`.
- Extra public API beyond the contract: `bounds`, `tileCount`, `overlayMesh`, `invalidate()`, `debug` ({ tileColors, overlayColors, modelInstances } for the `data-*` attributes e2e reads).
- Test command not added to package.json `test` script (integration owns it): `src/farm-world.test.ts` imports with `.ts` suffixes so it runs under `--experimental-strip-types`.

## Open issues
- No floating origin: positions are plain float32 world coordinates (fine to roughly 1e5 tiles, jitter beyond; spec 4b suggests a chunk-aligned rebase, which also needs the camera, island and drones to agree).
- Merged cells over land that is only partly owned still draw the full block.
- Sway does not move shadows (depth pass uses the stock material).
- Barn is only drawn at stride 1 and LOD < 2.

## Requests
- Integration: replace per-tile loops in `FarmView.update` with `world.setSnapshot` + `world.refresh` every frame (`tilePx` = pixels per tile at the camera target, `quad` from `FarmCamera.visibleQuad`); pass `priceMultipliers` only when the price lens is chosen; use `world.debug` for `data-tile-colors`, `data-overlay-colors`, `data-model-instances`; call `world.invalidate()` is not needed on `tendril:models` (detected automatically); add `src/farm-world.test.ts` to the client `test` script.
