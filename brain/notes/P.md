# Workstream P — desktop packaging

## Files changed (P only)
- `packages/client/electron/main.cjs`
- `packages/client/electron/navigation.cjs`
- `packages/client/electron/navigation.test.cjs`
- `packages/client/electron-builder.yml`
- `packages/client/e2e/electron-smoke.mjs` (package-local `e2e/`, matching the existing client script)
- `.github/workflows/release.yml` (explicitly authorized new workflow)
- `brain/notes/P.md`

No package manifests, lockfile, client integration sources, shared brain/configuration files, or original `~/Developer/tendril` edited. No git operations, publishing, deployment, or remote workflow execution.

## Implementation decisions
- BrowserWindow explicitly uses `contextIsolation: true`, `nodeIntegration: false`, `nodeIntegrationInWorker: false`, `sandbox: true`, `webSecurity: true`, `webviewTag: false`, and `allowRunningInsecureContent: false`. `app.enableSandbox()` applies globally before startup.
- Development entry accepts HTTP localhost/127.0.0.1/[::1] only, without credentials. Invalid URLs fail closed. Packaged apps ignore `VITE_DEV_URL` entirely and use the local dist/index.html entry.
- Navigation/frame/redirect guards permit only the initial local document (or configured development document), harmless anchors, and the existing live/sandbox mode link. Unknown/duplicate mode values, arbitrary query changes, neighboring files/pages, credentials/origin changes and external schemes are denied. All new windows/webviews, permission requests/checks and downloads are denied. No shell/openExternal integration.
- `TENDRIL_ELECTRON_SMOKE=1` selects the existing `?mode=sandbox` seam, without a privileged renderer bridge. Under this flag only, an existing absolute isolated profile path can be supplied. Smoke always creates/cleans its own profile inside the working copy's client/release directory, closes Electron in finally, clears development/Node-mode environment variables, and keeps Playwright artifacts in that profile.
- Smoke explicitly passes `chromiumSandbox: true`: Playwright otherwise injects `--no-sandbox` on Linux. It asserts that no such switch is present, checks actual BrowserWindow preferences and absence of Node access / localhost-only window.tendril on the file entry. It waits for DOMContentLoaded, visible Monaco/canvas and enabled controls; uses real keyboard input and the Lua API's `log`, checks Lua output, advancing Run ticks, a durable paused state, exact +100 Step ticks and save status, a nonblank canvas screenshot, a real sim-worker, no renderer errors/failed asset requests, and blocked navigation/window opening.
- macOS smoke uses native ANGLE/Metal (forcing SwiftShader failed to create a WebGL context). Non-mac CI uses SwiftShader without disabling renderer/GPU sandboxing. `TENDRIL_ELECTRON_EXECUTABLE` optionally exercises the actual packaged executable, with an absolute path required.
- Vite already has `base: './'`. Inspection of the built bundle shows Vite emits the wasm URL as `new URL("glue-Dlydm7r2.wasm", import.meta.url).href`, so no client integration patch was needed. Real Lua initialization and execution passed from both ordinary file URLs and app.asar file URLs. This replaces the initial provisional request to manually resolve wasm URLs in C-owned RealSim.
- electron-builder: appId `com.tendril.game`, product `Tendril`, asar, output client/release; only dist + runtime electron files (plus mandatory generated package metadata), no node_modules/test payload. Bundled Vite dependencies need no native rebuild. Metadata author/description supplied through builder extraMetadata, not package.json.
- Unsigned macOS dmg+zip for x64/arm64, Windows NSIS x64, Linux AppImage+deb x64. NSIS is electron-builder's supported general Windows installer; MSI would require separate WiX/tooling and is not necessary for this task. mac identity is null, Windows sign/edit is disabled, code signing is not required. Users may see Gatekeeper/SmartScreen warnings. Apple arm64 retains a linker ad-hoc signature, not a developer identity; no notarization.
- CI uses manual workflow_dispatch and push tags v*, three native runners (macos-14/windows-latest/ubuntu-22.04), repository-pinned pnpm, frozen lockfile, Node 22.14.0, Playwright Chromium/system dependencies, root lint/typecheck/unit/build/E2E (--retries=0), policy tests and Electron smoke BEFORE packaging. Linux uses xvfb and leaves Chromium sandbox enabled. `publish: null` plus `--publish never`, read-only contents permission, and GitHub workflow artifacts only (14-day retention). No GitHub release creation/deployment.

## Requests to coordinator (outside P ownership)
- Root `lint`, `typecheck`, `test`, `build`, `test:e2e` scripts are required by CI. They were added concurrently and were successfully invoked; retain the forwarding of `--retries=0` in root test:e2e.
- Retain client `electron:smoke: node e2e/electron-smoke.mjs`. Optional additions: `electron:pack: electron-builder --config electron-builder.yml --publish never`, `electron:test: node --test electron/navigation.test.cjs`. P did not change scripts.
- Root ESLint currently applies `@typescript-eslint/no-require-imports` to all Electron `.cjs` files, including the original CommonJS main entry. Coordinator should scope that rule off for `**/*.cjs`. P retained idiomatic CommonJS instead of adding file-local lint suppressions or editing shared config.
- Root lint also fails in C-owned real-sim.ts (preserve-caught-error). Root unit gate currently exposes Lua private-global/instruction-guard vulnerabilities in sim source; coordinator/security owner must fix them. Browser E2E still has integration/UI failures (below). These gates intentionally block release CI before packaging.
- Installer version remains the coordinator-owned package version 0.0.0; no tag-driven manifest/version modification added.

## Verification — final P checks
- `node --check packages/client/electron/main.cjs` and smoke script: passed.
- `node --test packages/client/electron/navigation.test.cjs`: 4/4 passed, no failures, covering local entry/development validation, modes/anchors, redirects/frames, webviews and popup denial.
- Targeted `pnpm exec eslint packages/client/e2e/electron-smoke.mjs`: passed.
- Workflow and builder YAML parsed with installed js-yaml; assertions passed for triggers, read-only permissions, all three platforms, root gates preceding packaging, publish-never and requested targets.
- `pnpm --filter @tendril/client electron:smoke`: passed against built dist, tick 0 -> 101 (Run plus exact +100 Step), real Lua/wasm/worker, rendered canvas/editor and navigation/security/error assertions.
- `CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --config electron-builder.yml --mac --arm64 --dir --publish never`: passed. Electron downloaded/extracted normally; no permission bypass. Output: `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/client/release/mac-arm64/Tendril.app`. Builder explicitly skipped signing because identity is null; uses default Electron icon (no custom icon provided).
- `TENDRIL_ELECTRON_EXECUTABLE=/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/client/release/mac-arm64/Tendril.app/Contents/MacOS/Tendril pnpm --filter @tendril/client electron:smoke`: passed against the final real packaged .app, tick 0 -> 101 with all assertions.
- Asar payload assertions passed: top-level dist/electron/package.json only; dist/index.html, emitted sim-worker and glue wasm present; no node_modules or test files. Bundle CFBundleIdentifier verified by plutil: com.tendril.game.
- `codesign --display --verbose=2` reported linker ad-hoc signature, no TeamIdentifier, no sealed resources, Info.plist not bound. This is not developer-signed or notarized; no signing identity used.

## Verification — root gates and earlier concrete failures
These are actual separate runs during concurrent implementation, not automated retries or a claimed green release gate.
- Initial root build/typecheck failed on old MockSim bootstrap/loop and incomplete renderer inspector/asset types. Later root `pnpm build` PASSED (39 models copied; Vite worker/wasm emitted), and root `pnpm typecheck` PASSED for sim/client/server. Wasmoon browser externalization of Node `module` produces a nonfatal Vite warning.
- Final root `pnpm lint`: FAILED, 12 errors: 11 CJS no-require-imports errors plus real-sim.ts preserve-caught-error. Targeted smoke lint passed.
- Initial root `pnpm test`: 55 passed, 2 failed (replay helper spread stack overflow), golden fixture absent. G fixed those concurrently. Latest root unit run: 80 passed, 4 failed in test/sandbox.test.ts: private __ globals exposed; coroutine-create/coroutine-wrap/pcall-repeat probes exceed the host guard and subprocess time out/SIGKILL. Other 11 sim test files passed. Recursive command stops at sim failure, so no claim that downstream server unit suite ran.
- Playwright Chromium install: passed (cached, no errors).
- Initial browser E2E: 2 passed, 2 failed, 1 screenshot skipped while new controls were absent (null addEventListener and tick staying 0).
- Latest root `pnpm test:e2e --retries=0`: 16 passed, 4 failed, 1 optional screenshot skipped. Failures: missing #farm-inspector in sandbox/live instruments tests; Monaco completion test timed out; pause assertion observed pending worker ticks (310 vs 332). Golden-path Lua/checkpoint/replay/restart, live clock and multiple renderer/security/error tests passed. No browser E2E edits made by P.
- Earlier Electron smoke first had no dist, then old-UI bootstrap failed; native graphics fixed the explicit SwiftShader WebGL failure. Lua smoke corrected `print` to the actual game `log` API. Final smoke runs after these concrete changes passed; failures are not concealed.

## Validation not performed / remaining gate
- No Windows/Linux binaries, installers or native smoke executed locally. No macOS x64 build, dmg/zip creation, installation/uninstallation, quarantine/Gatekeeper validation, notarization or developer signing performed. Only actual native macOS arm64 directory build/run was validated.
- CI definition validated locally only; workflow never run remotely and nothing uploaded/published.
- Full root release gate is NOT green: coordinator must fix lint/sim security/browser E2E blockers, then rerun the complete no-retry gate before relying on installer CI. P packaging/smoke is implemented and locally verified, not a release approval.

---

# Task P (polish): farm stage, HUD, market pill, trails

(The section above is the older desktop-packaging note that shared this file name; this section is the farm-view polish task.)

## Files changed
`style.css` (stage layout, caption, decks, phone rules, `#editor` overflow), `farm-hud.ts/css` (one compact row), `farm-minimap.ts` (144 px, collapse), `farm-market.ts/css` (pill, hidden without a market), `farm-drones.ts` (+ test) (trails), `inspectors.ts` (tile hint to caption). `index.html`, `farm-view.ts` needed no change. Ids/ARIA hooks kept (`#soil-overlay`, `#btn-focus-farm`, `#farm-minimap-canvas`, `#tile-inspector`, `#farm-light`, `#farm-hud`).

## What changed
- Layout: `#farm-stage` is `flex: 1 1 0; min-height: max(52vh, 300px)`; decks are a fixed scroll region `clamp(112px, 19vh, 180px)`; panel heading tighter. 1400x900: stage 488 px tall (was ~280). <=1100: stage `clamp(360px, 64vh, 640px)`, <=640: `clamp(340px, 58vh, 520px)`. No horizontal scroll at 390 (checked by e2e).
- HUD: one row top-left: Home, Follow, rotate x2 (icon + label, icons only on phones), Light popover (sun + current preset, presets inside, closes on pick/outside/Escape), Lens select, View disclosure (zoom mode + shortcuts). The glass box behind the whole bar (old `#stage-tools > * > *` rule) is gone. Phone popovers span the stage width.
- LOD badge removed from the bar: the "Close / Field / Map, px per tile" text shows in the minimap header for ~1.8 s after the zoom changes, then fades.
- Minimap: 144 px (96 px phone), header button `Map -` / `Map +` collapses it (stored in `localStorage['tendril.minimap']`, default collapsed at <=640 px). The caption stops short of it (`:has()` rule).
- Tile hint: moved into the caption bottom-left as one line with ellipsis + `title`; short default text "Click a tile to read its soil".
- Market: `.farm-market` hidden when the card kind is `base` (sandbox, live, campaign, no market), a top-right pill when `soon`, expanded when a market day opens (`open`), collapsible. Phone: bottom-left above the caption. Price lens option is disabled and hidden without a market.
- Trails: `trimTrail` keeps length in distance (`trailLength(pace)`: 3.5 tiles at 1x down to 0.5 at high pace), width and brightness scale with `trailFade(pace)` (1 up to pace 4, 0 at 28+, about 0.5 at 16x), history cleared when hidden so no criss-cross smear returns when speed drops. Pace = ticks per snapshot.
- Unrelated race fixed: `#editor { overflow: hidden; max-width: 100% }`. The mobile test `app.spec.ts:81` failed about half the time because Monaco kept its 1280-px-wide layout for a moment after `setViewportSize` (`document.scrollWidth` 553); it now passes 6/6.

## Screenshots (DPR 2, looked at each)
`brain/notes/farm-redesign-shots/`: `p-wide.png` (1400x900), `p-mid.png` (900x800), `p-phone.png` (390x844 full page), `p-large-farm.png` (64-plot farm, close LOD), `p-market-light.png` (market day expanded + light popover). Script `shoot-p.mjs` (`ONLY_LARGE=1` for the slow large-farm shot). Removed outdated `after-*.png`, `large-farm-*.png`, `live-30s.png`; kept `before-*.png`, `assets.png`, `shoot.mjs`. Seen: farm dominates, HUD is one row, no card in sandbox, hint stops before the minimap, expanded market card clears the minimap. Not verified in a browser: trails at 16x live (only unit-tested), market pill on phone.

## Checks (real output)
- `pnpm lint`: exit 0. `pnpm typecheck`: exit 0 (all workspaces). `pnpm test`: rating 42, sim 96, server 615, lang 47 (1 skipped), client `# pass 61 # fail 0` (new trail test included). `pnpm build`: `built in 32.92s`.
- e2e (`PW_CHROMIUM=... playwright test view instruments app firstrun replay room farm-hud rating --workers=2`): 39 passed, 1 skipped, 2 failed:
  - `room.spec.ts:35` (fps >= 20, got 16.8 with 2 parallel software-GL workers): passes alone (`--workers=1`: 1 passed). CPU contention; the room uses the lite view, untouched by this task.
  - `rating.spec.ts:90`: fails deterministically, also alone. Timeout is on `page.click('#btn-run-end')` with "element is not enabled". Cause is not the farm view and not boot timing: `arena.ts:155` disables the button from `tendril:status.canStep`, and `game-loop.ts:343` has `canStep = loaded && free && !busy && !this.ended`. The test runs the daily to its end, then `page.reload()`s; the finished run is restored from the saved state so `ended` is true and Run to end stays disabled. The first half of the test (before the reload) passes. Fix belongs in the test (use a fresh context/clear storage before the reload, or reset the run) or in the intended behaviour of resuming a finished daily; I did not change either. Not confirmed on the pre-redesign code (no baseline run was made); the reasoning is from the code path above.
