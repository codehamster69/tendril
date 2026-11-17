# Task I: integration of the farm redesign (A-G)

## Files changed
- `packages/client/src/farm-view.ts`: rewritten as a thin orchestrator (FarmCamera, FarmLight, FarmIsland, FarmWorld, FarmDrones + shared FarmFx, FarmCarried, FarmMarket, HUD hook). Option `{ lite: true }` for room/replay: no market card, no HUD, no trails, no fireflies, shadows off. Public API kept (`update`, `setOverlay`, `focusFarm`, `selectBot`, `overlayMesh`, `dispose`) plus `setLens` (incl. price), `setLight`, `setZoomMode`, `follow`, `rotate`, `jumpTo`, `priceAvailable`, `setMarket`, `attachHud`, `groundAt`, `batches`. Dataset hooks kept (`data-camera-*`, `data-overlay`, `data-models-*`, `data-rendered-tiles`, `data-tile-colors`, `data-overlay-colors`, `data-model-instances`, `data-scene-ready`, `data-selected-bot`); new `data-lod`. Meadow plane, terrace walls, scenery props dropped.
- New `farm-carried.ts` (carried-item markers, instanced per item kind, stacked above `DRONE_HOVER`).
- `main.ts`: `view.setMarket(challenge.market, { opensInDays })`; `window.tendril.view` (dev/localhost only). `arena.ts`: `marketOpensIn(c)` (uses `daysUntilMarket`). `room-main.ts`, `replay-main.ts`: lite views. `inspectors.ts`: `tendril:hud` events removed, direct calls, `view.attachHud(hud)`.
- Fixes in other tasks' modules (allowed): `farm-fx.ts` `fireflies` flag; `farm-world.ts` `debugBatches` getter; `farm-minimap.ts` `MiniTile.tilled` accepts number; `assets/scripts/gen/models.mjs:169` unused arg (lint).
- Root `package.json` `assets:build`; client `package.json` test script lists farm-camera, farm-world, farm-drones, farm-minimap, farm-market tests; `playwright.config.ts`: `PW_CHROMIUM=<binary>` env passes executablePath and `--no-sandbox` (container only).
- e2e: new `farm-hud.spec.ts` (zoom lock within 0.05 tiles, Home button and Home key, price lens disabled then enabled, minimap click). `view.spec.ts` updated: drones are no longer an instance batch (bot checks use the loader model and `data-model-instances.bot_tender`), camera eases (fake-clock `runFor`), relocated land is re-framed while auto-framed (intended: A re-fits on bounds change), tests assign new `tiles` arrays (world skips an identical array reference), bot focus eases.
- Market: stall at tile (1,0) beside the barn, popups from snapshot diffs (ripe crop next to a drone gone or reset: yield x price x multiplier; coin gain while a drone is at the barn), `setPopupsHidden(lod===2)`. Harvest popups were NOT visually verified (needs a running harvest with a market-active daily).
- CHANGELOG Unreleased entry. Shots in `brain/notes/farm-redesign-shots/` (`live-30s.png`, `large-farm-fit.png`, `large-farm-close.png`, script `shoot.mjs`).

## Checks (real output)
- `pnpm lint`: exit 0 (no output beyond the eslint banner).
- `pnpm typecheck`: all workspaces, 0 errors.
- `pnpm test`: rating 42, sim 96, server 615, lang 47 (1 skipped), client `# pass 60 # fail 0` (includes the five new files).
- `pnpm build`: `built in 27.51s`. `pnpm assets:check`: `Validated 57 GLBs, sidecars and thumbnails; 13160 triangles`.
- e2e (Chromium via `PW_CHROMIUM=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome PW_PORT=... PW_OUT=dist-i pnpm exec playwright test`): view, instruments, app, firstrun, replay, room, farm-hud: 33 passed, 1 skipped (room screenshot), 1 failed (view GLB race), fixed by rebuilding batches synchronously when GLBs arrive; re-run: view.spec 11 passed; GLB + rules v3 2 passed; farm-hud 4 passed. Not re-run in one final combined pass after that one-line fix (the other specs do not touch the changed path).
- Manual look: 1400x900 @2x screenshots saved. Live farm after 30 s (expander at 8x, still 1 plot), a 4096-tile (64-plot) farm pushed into the view: Map LOD at fit (4 px/tile) and Close LOD (58 px/tile), no page errors.

## Observations / open issues
- Stage chrome (H/E): at 1400x900 the stage is only ~280 px tall and the HUD (three rows) plus the `#tile-inspector` hint and market card cover about 40 percent of it; the auto-fit frames the whole stage, so the top of a large farm is under the HUD. Suggest: collapse HUD rows into one, move the tile hint to the caption, make the stage taller. The market card also shows "base" in sandbox/live modes (contract says so; consider hiding when no market).
- Trails at 8x speed draw long criss-crossing lines over the farm; tune brightness or shorten at high speed (D).
- Harvest popups and price lens on a real market day unverified in a browser; HUD `lodLabel` badge now shows stride (fixed: was showing the cell count).
- `FarmWorld.setSnapshot` ignores a snapshot whose `tiles` array is the same reference (mutated in place); the sim always sends new arrays.
- Camera: Home animates (no snap); e2e must wait for settle.

## Requests for brain docs (coordinator merges)
- STATUS: farm view redesign integrated; known items: playwright needs `PW_CHROMIUM` in cloud containers; stage/HUD overlap above.
- MAP: `farm-view.ts` orchestrates `farm-camera/light/scenery(FarmIsland)/world/drones/fx/carried/market/hud/minimap`; `farm-market-format.ts`; assets generated by `assets/scripts/gen` (`pnpm assets:build`).
- DECISIONS: lite option for embedded views; left-drag pans; golden default; price lens only with a market; shadows off in lite.
- JOURNAL: 2026-11-14 integration, e2e updated for eased camera and drones-not-instanced.
