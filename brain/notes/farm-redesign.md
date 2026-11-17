# Farm view redesign: contract for the parallel build

Goal: replace the farm view with the "living island" design and bring the whole game view up to the same standard. Approved by Rohan 2026-11-14. Defaults kept: left-drag pans, right/Ctrl-drag orbits, Golden hour default light. Original art only (not a copy of The Farmer Was Replaced).

Reference implementation (behaviour, numbers, shaders, geometry): `/mnt/project-files/farm-view-mockup.html` (three r128, one file). Written spec: `/mnt/project-files/farm-view/spec.md`. Port the ideas to TypeScript on three ^0.187 (colour management is on in r187, lights are physical: retune intensities by screenshot, do not copy numbers blindly).

## Rules for every task
- Edit only the files you own (below). New files are yours if named in your task. Need a change elsewhere: write it under "Requests" in `brain/notes/<task>.md`.
- Do NOT edit `farm-view.ts`, `main.ts`, `room-main.ts`, `replay-main.ts` (the integration task owns them). Do not commit or push.
- Other tasks are being written at the same time in the same tree. `pnpm --filter @tendril/client typecheck` may show errors in files you do not own: ignore those, make yours clean. Run `pnpm exec eslint <your files>` and `pnpm --filter @tendril/client test -- <your test>` for yours.
- Keep ids, data attributes and ARIA labels that e2e tests use (grep `packages/client/e2e`). If a test must change because behaviour changed on purpose, list it under "Requests".
- Unbounded farm: no array sized by farm width or height, no per-tile work per frame, no hard-coded size limit. Cost must follow the screen and the touched land.
- No new dependencies. No remote fonts or images (Electron app:// and offline use).
- Reduced motion: honour `prefers-reduced-motion`.
- Write `brain/notes/<task>.md`: files changed, real command output of checks, decisions, open issues, requests.

## Shared types (all in the owning module)
`Bounds = { x0, x1, z0, z1 }` from `farm-scenery.ts` (`tileBounds`). World axes: x = tile x, z = tile y, y up. Tile (x,y) is centred on world (x, 0, y), 1 unit wide, top surface at y = 0.

## Modules and APIs

### A. `farm-camera.ts` (+ `farm-camera.test.ts`)  [Sonnet]
Replaces OrbitControls. Port the mockup's rig: `cur`/`des` state, anchor-lock zoom (`applyLocked`), exponential easing, grab-pan with momentum, right/Ctrl orbit, two-finger pinch + pan, WASD/arrow pan, Q/E 90 degree turns, auto-tilt, follow, fit.
```ts
export class FarmCamera {
  constructor(camera: THREE.PerspectiveCamera, dom: HTMLElement, onTap?: (clientX: number, clientY: number) => void)
  setBounds(b: Bounds | null): void            // clamps target (bounds + margin), scales min/max distance, near/far
  update(dt: number): void                     // every frame before render; places the camera
  fit(snap?: boolean): void                    // frame all land (also the Home / jump-to-farm action); re-arms auto framing
  focus(x: number, z: number, o?: { dist?: number; snap?: boolean }): void
  follow(source: (() => { x: number; z: number } | null) | null): void   // dragging cancels; zoom keeps the drone centred
  readonly following: boolean
  rotate(steps: number): void                  // 90 degree steps, anchored at screen centre
  zoomAt(factor: number, ndcX: number, ndcY: number): void
  zoomMode: 'cursor' | 'center'                // default 'cursor'
  autoTilt: boolean                            // default true
  groundAt(ndcX: number, ndcY: number, out?: THREE.Vector3): THREE.Vector3 | null
  readonly target: THREE.Vector3; readonly distance: number; readonly yaw: number; readonly pitch: number
  onChange?: () => void                        // fired when the pose changes (FarmView mirrors it into data-camera-*)
  /** True while the camera is where fit() last left it (or still easing there): used to re-frame when land is bought. */
  autoFramed(): boolean
  /** Visible ground quad as 4 world points, clamped for horizon rays (minimap + world window). */
  visibleQuad(maxReach?: number): THREE.Vector3[]
  dispose(): void
}
```
Pure maths (lock, easing, pitch curve) lives in exported functions so the unit test can assert: after a wheel zoom at an off-centre pointer the ground point under it moves less than 0.01 tiles; `zoomMode = 'center'` moves it noticeably. Default pose when no bounds: as today (position 10,14,16 looking at 3.5,0,3.5).

### B. `farm-light.ts` + `farm-scenery.ts`  [Sonnet]
```ts
export type LightPreset = 'dawn' | 'noon' | 'golden' | 'night'
export class FarmLight {
  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer)   // owns sun, hemisphere, fog, scene.background (sky gradient), tone mapping exposure
  setPreset(p: LightPreset, snap?: boolean): void                  // lerps ~1 s; default 'golden'
  readonly preset: LightPreset
  setWeather(w: 'clear' | 'rain' | 'frost'): void                  // tints on top of the preset
  update(dt: number, focus: { x: number; z: number }, distance: number): void  // shadow window follows focus, fog scales with distance, lod-aware
  readonly glow: number                                            // 0.2..1.5, drones and fireflies read it
  readonly shadowsOn: boolean
  dispose(): void
}
export class FarmIsland {                                          // replaces meadow plane + terrace walls
  constructor(scene: THREE.Scene)
  update(bounds: Bounds | null, owned: (x: number, y: number) => boolean): void  // slab: soil lip, strata, stone keel, hanging tendrils; grows with land; frontier glow edge; tendril length capped
  setDistance(d: number): void                                    // frontier thickness scales with distance
  pulse(time: number): void
  dispose(): void
}
```
Keep `sceneryPlacements`/`tileBounds` exports working (tests may import them); trees and rocks may stay as optional props around the island. The island must also work for non-rectangular land (plots anywhere): slab = bounding rectangle, but only owned tiles draw as tiles, the rest of the slab top is meadow.

### C. `farm-world.ts` (+ `farm-world.test.ts`)  [Sonnet, heavy]
View-window renderer, replaces the per-tile loops in `FarmView.update`.
```ts
export interface WorldView { camera: THREE.Camera; quad: THREE.Vector3[]; distance: number; tilePx: number; time: number }
export class FarmWorld {
  constructor(scene: THREE.Scene, models: (name: string) => AssetModel)   // models: GLB if loaded, else fallback
  setSnapshot(s: Snapshot): void            // incremental sparse store, 32x32 chunks keyed by tile; O(changed tiles) when possible
  refresh(view: WorldView, o: { overlay: FarmOverlay; priceMultipliers: number[] | null }): { lod: 0 | 1 | 2; stride: number; ripeInView: number; cells: number }
  tileAt(x: number, y: number): SnapshotTile | undefined
  readonly bounds: Bounds | null
  forEachChunk(fn: (cx: number, cy: number, tiles: ReadonlyMap<string, SnapshotTile>) => void): void   // minimap
  setSway(on: boolean): void; dispose(): void
}
```
LOD by pixels per tile (28 / 10, 10 percent hysteresis): Close = furrows + tufts + crops, Field = crops, Map = coloured cells (crop + ripeness), cells merge 2,4,8.. so at most about 14,000 instances (cap 20,000 per mesh). Crop sway in a vertex shader (`onBeforeCompile`, instanceMatrix based, no per-frame JS). Price lens: ripe crops coloured by multiplier (blue 0.5 to orange 2.0), rest dimmed; implemented via instance colours; `priceMultipliers` index = item id, value 0.5..2. Keeps overlay (moisture/nitrogen/fatigue) behaviour via the existing `OverlayLayer` (`farm-overlay.ts`, you own it). Furrow, tuft and tile counts are instance-based, never one object per tile. Test: stride choice, window culling, and that a 100,000 x 100,000 sparse farm with 1,000 tiles refreshes with <= 20,000 instances.

### D. `farm-drones.ts` + `farm-fx.ts`  [Sonnet]
```ts
export class FarmDrones {
  constructor(scene: THREE.Scene, model: () => AssetModel | null)   // GLB `bot_tender` when loaded (new lantern drone), else procedural lantern drone from the mockup
  setBots(bots: SnapshotBot[], tickDelta?: number): void            // targets; emits fx when a bot's op changes
  update(dt: number, time: number, glow: number, viewScale: number): void   // easing, banking, blades, bob, blob shadows, trails, viewScale keeps drones ~12 px at Map zoom
  position(id: number): { x: number; z: number } | null
  setSelected(id: number | null): void                              // ring
  trails: boolean
  dispose(): void
}
export class FarmFx { constructor(scene); burst(x, y, z, hex, n?): void; update(dt, time, focus: {x:number;z:number}, glow: number, scale: number): void; dispose(): void }   // pooled particles + fireflies that stay around the camera focus
```
Trails: additive ribbon of the last ~44 path points per drone, coloured per drone (6 colours, cycle). Pool everything; no allocation per frame.

### E. `farm-hud.ts` + `farm-minimap.ts` (+ `inspectors.ts` stage-tools part)  [Sonnet]
DOM built from TypeScript into `#stage-tools` and the stage. Replaces the old "Frame farm" button and lens select in `inspectors.ts` (you edit that file only for that).
```ts
export interface FarmHudApi {
  home(): void; follow(): void /* cycles drones then off */; rotate(steps: number): void
  setLens(l: 'none' | 'moisture' | 'nitrogen' | 'fatigue' | 'price'): void
  setLight(p: LightPreset): void; setZoomMode(m: 'cursor' | 'center'): void
  jumpTo(x: number, z: number): void
}
export function mountFarmHud(stage: HTMLElement, api: FarmHudApi, opts?: { priceAvailable?: () => boolean }): FarmHud
export class FarmHud { update(s: { following: boolean; lod: 0 | 1 | 2; tilePx: number; cells: number }): void; minimap: FarmMinimap; dispose(): void }
export class FarmMinimap { update(m: { chunks: (fn) => void; quad: THREE.Vector3[]; bots: { x: number; z: number; color: string }[]; selected: { x: number; z: number } | null; home: { x: number; z: number }; bounds: Bounds | null }): void }
```
Contents: Home (jump to farm) with Home key, Follow drone (F), rotate buttons (Q/E), light preset segmented control (persist in localStorage, wrapped in try/catch), lens select including Price (disabled with a reason tooltip when no market), LOD badge ("Close/Field/Map · N px per tile"), 176 px minimap (drawn from chunks, built area stays visible at any scale with a minimum marker size, click/drag to move the camera, viewport quad, drones, home marker, selected tile), keyboard hint chips. Minimap redraw at most 8 times a second and only when dirty. Everything keyboard accessible, `aria-label`s, `aria-pressed`. Must fit phone width and not cover the canvas controls.

### F. `farm-market.ts` (+ `farm-market.test.ts`)  [Sonnet]
```ts
export interface MarketData { prices: number[]; multipliers: number[]; shares: number[] | null }   // as in api-client ChallengeInfo.market (centicoins, permille), index = item id
export class FarmMarket {
  constructor(stage: HTMLElement, scene: THREE.Scene)
  setMarket(m: MarketData | null, opts?: { opensInDays?: number }): void   // null: base prices (card shows "Base prices", lens disabled); opensInDays > 0: "Market opens in N days"
  readonly multipliers: number[] | null                                     // 0.5..2 per item id, for the price lens
  setStallAt(x: number, z: number): void                                   // little stall + sign (canvas texture) next to the barn showing the best price
  popup(camera: THREE.Camera, x: number, z: number, coins: number, multiplier: number): void   // DOM floating text, pooled, rate limited, hidden at Map LOD
  update(dt: number): void; dispose(): void
}
```
Card: crop rows with colour dot, name, 50 to 200 percent gauge (mark at 100), arrow against base or yesterday if available, share of units sold when `shares` exists, countdown to the next UTC midnight. Use the sim's item names (`ITEM_NAMES`) and `describeMarket`/`MarketView` from `@tendril/sim` if they fit; do not duplicate rules maths. Pure formatting functions are unit tested.

### G. Assets  [Sonnet]  files: `assets/scripts/gen/*`, `assets/export/*`, `scripts/validate-assets.mjs`, `scripts/copy-assets.mjs` if needed, `packages/client/src/fallback-models.ts`
New original art in the island style (palette in the spec: grass 4e9a63, soil 6b4636, path d1b98a, stone 58666b, tendril 4fd1b0, lantern ffc65a): replace the GLBs that clash: `tile_*` (flat top 0.94 with chamfer, no gap baked into other meshes), `crop_*` (carrot, wheat, clover, pumpkin, berry, apple × 4 stages), `bot_tender` (+ v1..v3: lantern drone with leaf blades and amber core), `prop_barn`, `prop_market` (stall), `prop_beehive`, `prop_compost`, `item_*`, `tile_water`. Props that do not clash (tree, rocks, fence, crate, signpost, windmill, ...) stay but are tinted to the palette if cheap. No Blender in this container: write a Node generator (`assets/scripts/gen/*.mjs`) that builds flat-shaded low-poly meshes and writes binary glTF 2.0 files (own minimal GLB writer, vertex colours or per-colour materials, Y up, same names, same `*.json` sidecars: `{name, group, tris, budget, size}`), within the triangle budgets in `scripts/validate-assets.mjs`. Keep origin and orientation conventions of the existing files (check one first). Run `pnpm assets:check` and `pnpm assets:copy`. Update `fallback-models.ts` so the procedural fallbacks match the new look (same shapes as the mockup). Document the generator in `assets/scripts/README` style comment at the top of the main script. Art license: CC BY-NC-SA 4.0 (`LICENSE-ART.md`), mention in the generator header.

### H. Whole-game chrome  [Sonnet]  files: `packages/client/src/style.css`, `progression.css`, `reference.css`, `index.html` (visual structure only), `room.html`/`replay.html` styles, editor theme in `editor.ts` (colours only)
Bring top bar, mode tabs, readouts, panel headings, deck tabs and cards, toolbar, editor (syntax colours), console/debugger docks, status bar, modals/toasts to the island identity: lantern gold + teal on deep teal, soft panel glass (blur), consistent radii, tabular numerals, mono labels, subtle depth, focus rings, refined buttons (primary lantern gold), better spacing and responsive behaviour (phone width, 900 px, wide). System font stacks only (no remote fonts); display serif for headings as today. Keep every id, class and ARIA hook that tests or scripts use (`grep -rn` e2e first). Must keep WCAG AA contrast for text. Take Playwright screenshots (device scale factor 2) at 1400x900 and 390x844 into `brain/notes/farm-redesign-shots/` for the PR. The stage (`#farm-stage`) must leave room for the HUD overlays described in E (top-left tools, bottom-right minimap).

### I. Integration  [Sonnet, after A-H]
Rewrites `farm-view.ts` as a thin orchestrator of A-F (keeping its public API: `update`, `setOverlay`, `focusFarm`, `selectBot`, `overlayMesh`, `dispose`, dataset attributes, keyboard tile navigation, tile click `tendril:tile` event, `tendril:models`), wires `FarmHud`, `FarmMarket` (market from the challenge in `arena.ts`/`main.ts`), harvest popups (detect coins gain per bot op or tile crop reset in the snapshot diff), `replay-main.ts`/`room-main.ts` (multiple small views: shadows off, trails off, no HUD), updates e2e specs for intended behaviour changes, adds e2e for zoom lock and Home, docs (`brain/*` notes request section merged by the coordinator), README screenshot.
