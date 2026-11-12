# Module contracts (wave 3: Sprout, rules v3, Vercel + Turso, website)

The coordinator owns this file. An agent requests a contract change in its notes; never invent one at a seam.
`docs/SIM_SPEC.md` (rules v3) and `docs/LANGUAGE.md` (Sprout v1) are authoritative. This file covers seams.

## Packages
- `packages/sim` (`@tendril/sim`): rules only. Server-safe. No Lua, no wasmoon, no interpreter.
- `packages/lang` (`@tendril/lang`): Sprout lexer/parser/interpreter, prelude, `api.ts` (single source of
  built-in docs), CLI (`tendril run|replay file.sprout`), examples `examples/*.sprout`, goldens. Imports sim.
  Never imported by the server. Imported by the client worker, the editor (api.ts/grammar only) and the site (api.ts).
- `packages/server` (`@tendril/server`): Fetch-API handlers + libSQL. Imports `@tendril/sim/src/index.ts` only.
- `packages/client` (`@tendril/client`): Vite web app + Electron shell. Web build is served at `/play/`.
- `packages/site` (`@tendril/site`): Astro static website (landing, download, docs, leaderboard).
- Root `api/index.ts`: the one Vercel Node function; adapts `createApp(...)` from the server package.

## Simulation
See SIM_SPEC. `RULES_VERSION = 3`. `LogEntry = [tick,bot,op,a?,b?]`. Server never passes `Setup`.

## Language
See LANGUAGE.md section 10 (`compile`, `createRun`, `ScriptRun`, `BotDebug`, `API`, `LANGUAGE_VERSION`).
Also exported for the editor: `KEYWORDS: string[]`, `CONSTANTS: string[]`, and
`monarchTokens(): object` (a Monaco Monarch tokenizer definition, plain data, no Monaco import).

## Client worker (C owns protocol; E/P consume GameLoop only)
`sim-protocol.ts` commands, each with `id`:
`init {saved|null, seed, source, scenario}` `setSource {source}` `step {ticks}` `reset {seed, source, scenario}`
`setBreakpoints {lines:number[]}` `stepLine {}` `resume {}`.
`scenario = {kind:'live'|'sandbox'|'campaign'|'daily', features?:string[], setup?:Setup, tickLimit?:number}`.
State reply: `{type:'state', id, fromTick, fromHash, hash, snapshot, output:OutputLine[], errors:ScriptError[],
diagnostics:Diagnostic[], log:LogEntry[], saved, debug:BotDebug[], paused:{bot,line}|null, heat:[line,count][]}`.

`GameLoop` (DOM-free, `game-loop.ts`):
```ts
new GameLoop(sim: RealSim); await loop.init(scenario?)
loop.mode; loop.running; loop.speed (1..64, sandbox/campaign/daily only)
loop.run(); loop.pause(): Promise<void>; loop.step(ticks:number); loop.setSpeed(n)
loop.setSource(source): Promise<Diagnostic[]>      // compile errors returned, farm keeps running old program if any
loop.reset(): Promise<void>                        // caller confirms in live mode
loop.startScenario(s: Scenario & {seed:number, source:string}): Promise<void>
loop.setBreakpoints(lines); loop.stepLine(); loop.debug(): BotDebug[]; loop.snapshot(): Snapshot|null
loop.logChunks(): {fromTick,toTick,actions}[]       // for ranked/daily submission
```
DOM events on `window` (detail in brackets): `tendril:snapshot` [Snapshot], `tendril:output` [OutputLine[]],
`tendril:errors` [ScriptError[]], `tendril:diagnostics` [Diagnostic[]], `tendril:debug` [{bots, paused}],
`tendril:heat` [[line,count][]], `tendril:status` [{running, mode, tick, durableTick, message}],
`tendril:scenario-end` [{snapshot, log}] (fired once when tickLimit reached; loop pauses itself).
`window.tendril = {loop, sim, editor}` only on localhost/dev for E2E.
Page mode: `?mode=live|sandbox|campaign|daily` (default live); campaign also `&lesson=<id>`.

## UI shell (E owns DOM)
`main.ts` bootstraps: RealSim -> GameLoop -> Editor -> FarmView -> UI wiring -> `mountProgression(ctx)` (P) ->
`mountReference()`, `mountInspectors(view)`. `ctx = {loop, editor, view, api}`.
Editor seam: `{getSource(), setSource(text), setDiagnostics(d:Diagnostic[]), setErrors(e:ScriptError[]),
setBreakpoints(lines), onBreakpointsChange(cb), showBotLines(debug:BotDebug[]), showHeat(heat), setFeatures(set|null)}`.
Keep existing IDs (`btn-run btn-pause btn-reset btn-step speed hud-tick hud-coins hud-networth hud-weather console editor farm-canvas`).

## Progression (P owns)
`mountProgression(ctx): void` from `progression.ts`. Campaign saves `localStorage` key `tendril.campaign.v1`
= `{schema:1, completed:string[], unlockedFeatures:string[]}`; achievements `tendril.achievements.v1`.
Lessons: `{id, title, intro(md), goal(text), starter, features:string[], setup?, seed, tickLimit, check(snapshot, log)->boolean}`.
Campaign never affects ranked legality. Research (unlock op) is real game state, shown as a tree from `UNLOCKS`.

## Renderer (V owns farm-view.ts, asset-loader.ts, new fx.ts/scenery.ts)
`new FarmView(canvas)`, `.update(Snapshot)`, `.dispose()`, `.setOverlay('none'|'moisture'|'nitrogen'|'fatigue')`,
`.focusFarm()`, `.selectBot(id)`, `.onTileClick(cb:(x,y)=>void)`, `.setTimeOfDay(auto|fixed)`.
Renders v3 tiles (building, honey), perennials, hives/composters, bot carried items, weather FX, scenery.

## Server HTTP (S owns server package + api/index.ts)
Base `/api`. Storage: libSQL/Turso via `@libsql/client` (`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`); local dev and
tests use `file:` or `:memory:`. Migrations are idempotent SQL applied by `pnpm --filter @tendril/server migrate`
(and lazily on first request, guarded by a schema_version table). No RLS in SQLite: every handler enforces ownership.
Auth: GitHub OAuth (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `PUBLIC_ORIGIN`). Sessions are opaque random tokens;
DB stores SHA-256 only. Web: `HttpOnly; Secure; SameSite=Lax` cookie `tendril_session`; cookie-authenticated
mutations require header `X-Tendril-Client: 1`. Desktop: Bearer token obtained by polling. Dev login only when
`TENDRIL_DEV_AUTH=1` and `VERCEL_ENV` is not `production`.
```
GET  /api/auth/github?return=/play/&desktop=<nonce?>   302 to GitHub, state cookie (10 min)
GET  /api/auth/github/callback                         web: set cookie, 302 to same-origin return path; desktop: HTML "return to Tendril"
POST /api/auth/desktop/poll {nonce}                    200 {token,profile} once | 202 pending | 404
POST /api/auth/logout                                  204
GET  /api/me                                           200 {profile:{id,login,displayName,avatarUrl}} | 401
POST /api/dev/login {displayName}                      dev only
POST /api/farms, GET /api/farms/me, POST /api/farms/:id/chunks, GET /api/farms/:id/replay   (unchanged semantics, rulesVersion 3)
GET  /api/leaderboard?board=networth|growth&limit=20
GET  /api/daily                                        {date, seed, ticks:3000, rulesVersion}
POST /api/daily/submit {date, rulesVersion, actions}   replays from createWorld; {netWorth, rank, best}
GET  /api/daily/leaderboard?date=&limit=20
GET  /api/stats                                        {players, farms, dailyEntries}
```
Chunk limits unchanged (2 MB, 20,000 actions, span 1..20,000, toTick <= floor((now-startedAt)/100), 360 attempts/user/hour (client syncs every ~15 s),
CAS on checkpoint). Daily: today or yesterday (UTC) only, 20 submissions/user/day, best score kept. Errors `{error}`.
CORS: same-origin only for cookies; Bearer requests also allowed from `app://tendril` (Electron) without credentials.

## Desktop
Electron serves the built client from the privileged custom scheme `app://tendril/` (not file://), API base
`TENDRIL_API_ORIGIN` baked at build (default the production Vercel URL). Opens GitHub sign-in in the system browser.

## Deployment (coordinator owns vercel.json and root scripts)
One Vercel project from the repo root. `pnpm build:web` builds client with base `/play/` and the site, then copies the
client into `packages/site/dist/play`. Output `packages/site/dist`; function `api/index.ts`; rewrite `/api/(.*)` -> `/api`.
No VM, no container, no long-running process.

## Assets
Blender Z-up, export_yup. 1 unit = 1 m = tile. Origin bottom centre. Single joined mesh, flat matte palette, no rigs.
Budgets: tile/crop 300, bot 1500, building 3000, prop 1500. `common.build(...)` writes GLB + sidecar + thumbnail.
Existing 39 assets stay. New (A1, `assets/scripts/farm_extras.py`): `crop_apple_s0..s3`, `item_honey`, `item_compost`,
`prop_greenhouse`, `prop_windmill`, `prop_well`, `prop_scarecrow`, `prop_silo`, `prop_pond`, `prop_flowers`,
`prop_bush`, `prop_lamp`, `prop_cart`, `prop_hay`, `tile_water`. Building group for greenhouse/windmill/silo.
Renders (A2, `assets/scripts/render_sprites.py`, Eevee, headless): `assets/renders/<name>.png` 512x512 transparent
isometric for every manifest asset; `assets/renders/scenes/{hero,farm_overview,crew,buildings,growth_<crop>}.png`;
`assets/renders/icon_1024.png`. Site copies renders at build; never edits them.
