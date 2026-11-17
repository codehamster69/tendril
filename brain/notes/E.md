# Task E: farm HUD and minimap

## Files
- `packages/client/src/farm-hud.ts`, `farm-hud.css` (imported from farm-hud.ts), `farm-minimap.ts`, `farm-minimap.test.ts` (new).
- `packages/client/src/inspectors.ts`: lens select and "Frame farm" button removed; HUD mounted into `#farm-inspector`; `mountInspectors` now returns the `FarmHud`.

## Checks
- `pnpm exec eslint` on the four files: clean.
- `node --experimental-strip-types --test src/farm-minimap.test.ts`: 6 pass, 0 fail.
- `tsc --noEmit`: no errors in these files.

## Decisions
- Hooks kept: `#farm-inspector`, `#soil-overlay` (select, values none/moisture/nitrogen/fatigue/price), `#btn-focus-farm` (now the Home button), `#tile-inspector`, `#tile-announce`.
- Pure logic (`frameMap`, `worldToMap`, `mapToWorld`, `tileDraw`, `tileColor`, `lodLabel`) lives in farm-minimap.ts so node can test it.
- Minimap frames built bounds + viewport quad + home, so land never disappears; tiles drawn at least 2.5 px, sampled sparser when scale is small. Work follows chunks touched. Redraw timer 8 Hz, only when dirty, skipped when the tab is hidden. Keyboard: arrows nudge camera.
- Home and F are handled on the stage keydown (ignored while typing). Q/E are NOT handled by the HUD, to avoid double turns with the camera rig (task A); the buttons call `api.rotate`.
- Light preset persisted in `localStorage['tendril.light']`, zoom mode in `tendril.zoomMode`, both in try/catch. HUD calls `api.setLight` on mount with the saved/default 'golden'.
- Price lens option is disabled with a tooltip unless `priceAvailable()` is true; falls back to Natural if the market goes away.
- Until FarmView gains the new methods, inspectors.ts falls back to: `view.focusFarm()` for Home, `view.setOverlay` for the four soil lenses, and a `tendril:hud` window event `{action, value}` for follow, rotate, lens, light, zoomMode, jumpTo.

## Requests
- Integration (I): implement in FarmView (or pass real handlers) `follow()`, `rotate(n)`, `jumpTo(x,z)`, `setLens(l)`, `priceAvailable()`; subscribe to `tendril:hud` for light/zoomMode; call `hud.update({following, lod, tilePx, cells})` per frame (cheap) and `hud.minimap.update({...})` (it throttles itself). Use the returned HUD from `mountInspectors`.
- Integration: Q/E and WASD belong to FarmCamera; make sure it listens on the canvas or stage.
- `packages/client/package.json` `test` script: add `src/farm-minimap.test.ts`.
- H: `#stage-tools` rules in style.css (`#stage-tools > * > *` background) still apply to HUD children; stage needs room bottom-right for `#farm-minimap` (absolute, right 12, bottom 44, above `.farm-caption`).
- e2e `instruments.spec.ts` still valid unchanged (same ids).

## Open issues
- Not seen in a browser; no screenshot taken (renderer tasks run in parallel). Spot-check phone width layout.
