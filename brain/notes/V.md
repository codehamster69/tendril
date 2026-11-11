# Workstream V — renderer and asset loading

## Owned changes only
- `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/client/src/farm-view.ts`
- `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/client/src/asset-loader.ts` (new)
- `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/client/e2e/view.spec.ts` (new)
- `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/brain/notes/V.md` (this note)

No C files, packages, configurations, dependencies, shared brain documents, asset exports, or original Developer checkout were edited. No installs, commits, publication, or delegation.

## Behavior and decisions
- Preserved `new FarmView(canvas)`, `update(Snapshot)`, and `dispose()`. Added `setOverlay('none'|'moisture'|'nitrogen'|'fatigue')`, `focusFarm()`, and zero-based `selectBot(id)` (matching Lua/Snapshot bot IDs).
- Load `models/manifest.json` and relative GLBs through `import.meta.env.BASE_URL`. Four concurrent requests maximum, incremental replacement, no polling/retries. Missing manifest/files (404/410/204 or Vite HTML fallback) retain placeholders without application console logging. Unexpected HTTP/network/manifest/model parsing errors remain visible in canvas `data-models-status` and `data-models-errors`, plus bubbling `tendril:models` status events. Browser-generated network diagnostics for an actual 404 cannot be suppressed by this loader.
- Canvas `data-models-loaded` counts successfully parsed installed assets, not placeholders. `data-models-assets` lists their IDs. Ready/partial/fallback/error distinguish complete versus missing/invalid assets. All 39 exported models parsed successfully, including the actual production app's copied public assets.
- Preserve source material palettes/groups. Bake GLTF node transforms into cloned geometry; merge compatible primitives with original material group mappings; one InstancedMesh per combined compatible asset mesh, not per tile/bot. Capacities grow geometrically against actual asset usage. Dispose fallback resources when replaced.
- glTF is already Y-up and bottom-centred: no additional axis rotation, recentering, or manifest-size rescaling. Crop IDs 1..4 map to carrot/wheat/clover/pumpkin; stages 0..3 use sixteen separate exported model IDs without scaling a single mature model.
- Moisture modulation uses clamped `moisture / 100`. Soil overlays use full percentage ranges and a dedicated instanced color layer; diagnostics report colors actually assigned to instance attributes. Added subtle instanced tile guides, soft daylight, sparse outside-field trees/rocks, and a below-plane stone perimeter. AT's terrace wall is a full unit riser; narrowed its visual depth to 0.08 and placed it entirely outside tile edges. No simulation or owned tile elevations changed.
- Camera frames initially or explicitly, never on ordinary updates. Tile-coordinate bounds support expansion, negative plots, and same-count relocation. Explicit focus clears residual OrbitControls damping. Tile selection raycasts the playable plane, ignores unowned holes/scenery/drags, and dispatches bubbling `CustomEvent('tendril:tile', {detail:{x,y,scan:{...tileSnapshot}}})` from the canvas.
- Disposal covers RAF/listeners/observer/controls, instance buffers, geometry/material/texture/ImageBitmap resources, light shadows, renderer/context, and aborted fetches. A parse completing after disposal releases its resources without callbacks or resurrection. Disposal is idempotent.

## Actual checks
Working directory for commands: `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/client`.

- `pnpm exec vite build --outDir dist-V --emptyOutDir`: passed. Subsequent Playwright commands also rebuilt this isolated output successfully. Existing Wasmoon warning: browser build externalizes Node `module`; no renderer runtime failure observed.
- `pnpm exec tsc --noEmit`: final pass. Initial V error TS18046 on three geometry attribute accesses was fixed with an explicit BufferGeometry type; not concealed.
- `pnpm exec eslint /Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/client/src/farm-view.ts /Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/client/src/asset-loader.ts /Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/client/e2e/view.spec.ts`: final pass.
- `git diff --check`: passed.
- `PW_PORT=4181 PW_OUT=dist-V pnpm exec playwright test e2e/view.spec.ts --workers=1 --retries=0 --trace=off --output=/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/client/test-results-V`: six original tests passed after correcting an exact floating-point camera assertion (initial failure was 3.5000000000000004 versus 3.5). This was a test fix, not a retry-based timing pass.
- `V_ASSETS=1 PW_PORT=4181 PW_OUT=dist-V pnpm exec playwright test e2e/view.spec.ts --workers=1 --retries=0 --trace=off --output=/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/client/test-results-V`: eight tests passed after lifecycle/legibility refinements.
- Final broader command: `V_ASSETS=1 PW_PORT=4181 PW_OUT=dist-V pnpm exec playwright test e2e/view.spec.ts e2e/instruments.spec.ts --workers=1 --retries=0 --trace=off --output=/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/client/test-results-V`: **8 V tests passed; 2 C-owned instrument tests failed**. Both fail because `#farm-inspector` is absent (sandbox/live). The production app successfully loaded all 39 models in that same final run.
- Inspected screenshots of the exported crop-stage sandbox and actual initial app. Softened lighting and added tile guides after the first review. Generated `dist-V` and `test-results-V` artifacts were removed after inspection; tests regenerate them, including optional screenshots.

## Handoff / remaining verification
- Waiting on C/coordinator instrument integration: `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/client/src/inspectors.ts` implements compatible overlay/farm-focus/bot-focus/tile-event callers, but `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/client/src/main.ts` did not import or invoke `mountInspectors` at the final check. Do not claim the soil-lens/crew UI is accepted until C wires it and the two failing tests pass. No C file was changed to bypass this blocker.
- Default V browser tests use in-memory Vite builds and routed valid binary GLTFs, so they remain deterministic without generated assets. `V_ASSETS=1` additionally requires all 39 exports/manifest and coordinator `assets:copy`; it verifies both exported files and real production BASE_URL loading. No fixtures or config files are written by the harness.
- Test Engineer: independently accept overlays via C's UI, positive/negative tile scans, pan stability after stepping/expansion, frame/focus controls, bot movement, missing/corrupt asset statuses, resize/reduced-motion behavior, and late-load disposal. Browser tests cover actual palette groups, stage IDs, instance colors, negative relocation, and disposal events; they are not a GPU heap soak test.
- Coordinator's full unit/lint/build/E2E/Electron gate and independent review remain required. Electron smoke and large-farm performance/long-duration memory acceptance were not run by V.
