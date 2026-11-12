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
GET  /api/stats                                        {players, farms, dailyEntries, entriesPerDay:[{date, entries}]}
```
Chunk limits unchanged (2 MB, 20,000 actions, span 1..20,000, toTick <= floor((now-startedAt)/100), 360 attempts/user/hour (client syncs every ~15 s),
CAS on checkpoint). Daily aliases (kept for desktop 0.1.x): today or yesterday (UTC), 20 submissions/user/day, best score kept; now served by the Arena pipeline below. Errors `{error}`.
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

## Arena (A2 owns this section; rules v3, migration 002_arena.sql)
Threads build against these names. Ask in your notes for a change; do not invent one at a seam.

**challenges**(id, kind daily|season|duel, number, seed, ticks, par, opens_at, closes_at, created_by, rules_version).
Daily id `d-YYYY-MM-DD` (open one UTC day, number 1 = 2026-12-01, <= 0 before). Season id `s-YYYY-Www` (ISO week, Monday to
Monday UTC, number 1 = week of 2026-11-30). Duel id `x-` + 8 random chars: no number, never closes. Daily/season rows are
created on first request, only for today and yesterday (daily) or this and last week (season); any other unknown id is 404.
`today` and `week` are accepted wherever an id is. Season seed = FNV-1a 32 of `tendril-season:<id>` (0 -> 1). Par is
DAILY_PAR for daily/season and for duels of 3,000 ticks; any other duel length has par NULL (no Speed medal).
Worlds are always built with `challengeSetup(kind, seed)` from the sim (F1 varies it later).

**entries**(id, challenge_id, user_id, net_worth, par_tick, tokens, actions, actions_count, log_hash, mosaic, source,
source_public, source_verified, author_kind, model, created_at). Id = 12 base64url chars. `log_hash` = SHA-256 of
`JSON.stringify(actions)`. At most three per player per challenge: their best for each medal (wealth: highest net worth;
speed: lowest par_tick; brevity: lowest tokens, needs tokens). Ties go to the earlier entry. Identical non-empty logs from different players are accepted and share a rank (the first
submitter is listed first; the next distinct run takes rank = rows before it + 1, like 1, 1, 3). Rows moved from the old
`daily_entries` have no log, mosaic or par tick (replay is 404). **follows**(follower_id, followee_id, created_at) exists;
B5 owns the routes. `daily_entries` stays as a read-only archive. `arena_meta` marks one-off data moves.

**Routes** (all under /api; JSON; errors `{error}`):
```
GET  /challenges/today|week|:id  -> {id, kind, number, seed, ticks, par, opensAt, closesAt, rulesVersion, players, best}
                                    best = highest net worth so far, or null
POST /challenges/:id/entries {rulesVersion, actions, source?, sourcePublic?, authorKind?, model?}   (session required)
       -> {entryId, netWorth, parTick, tokens, mosaic, ranks:{wealth,speed,brevity}, percentile, improved, total}
GET  /challenges/:id/board?medal=wealth|speed|brevity&scope=global|friends&author=human|model&limit=20 (max 100)
       -> {medal, entries:[{rank, entryId, userId, login, displayName, avatarUrl, value, mosaic, authorKind, model, createdAt}],
           histogram:{min, max, width, counts:[10]}, total, me:{...row, percentile}|null}
GET  /entries/:id          -> {id, player:{login, displayName, avatarUrl}, netWorth, parTick, tokens, mosaic, authorKind, model,
                               sourceVerified, sourcePublic, createdAt, sealed, challenge:{id, kind, number, seed, ticks, par, opensAt, closesAt, rulesVersion}}
GET  /entries/:id/replay   -> {seed, ticks, rulesVersion, actions} | 403 sealed | 404 no log stored
POST /duels {seed?, ticks?} -> 201 {challengeId}   (session; seed 1..2^32-1; ticks 100..6000; default 3000)
```
Not in A2: `/entries/:id/source` (C3), `/players`, `/follows`, `/badge` (B5), `/og`, `/r/` (B4).
`ranks.*` is 1-based among players with that medal, null if the player has none. `percentile` = floor(100 * (total - rank +
1) / total) on the wealth board ("at or above this share of players"; 100 for first). Brevity is empty until C3 sets tokens.
On a non-improving submit, `entryId` is the player's current best-wealth entry, `improved` false, and the other fields
describe the submitted run. `source`, `sourcePublic` are validated (source <= 32 KB) but not stored until C3.

**Status codes.** 401 no session; 403 sealed; 404 unknown challenge/entry; 409 rules mismatch, challenge not open, or a repeat of
your own log (you already submitted this exact log; empty logs exempt, and the old /daily/submit returns the existing entry instead); 413 body over 2 MB or more actions than the kind's cap; 422
bad body or illegal log; 429 over 60 entries or 20 duels per user per UTC day. Cookie sessions need `X-Tendril-Client: 1` on POST.

**Sealing.** A replay is readable once its challenge has closed. Before that: its owner always; for duels, anyone who has
submitted their own entry on the same duel. Everything else is 403.

**Caps per kind** (`KIND_LIMITS` in arena.ts): 20,000 actions each; duel ticks <= 6,000. The widest legal body at the cap is
about 1 MB, under both our 2 MB limit and Vercel's 4.5 MB (a test asserts it). C2 may lower a kind's cap.

**Old clients.** `/daily`, `/daily/submit`, `/daily/leaderboard` keep their shapes and now read and write the Arena tables
(a repeat of your own log is answered with the existing entry, not 409). They also keep the one-day-late grace (`LEGACY_GRACE_MS`); set it to 0 when 0.1.x is gone.
