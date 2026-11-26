# Decisions (append only)

Format: ID, date, decision, why, alternatives considered. A later decision may supersede an earlier one; say so explicitly.
Where `docs/PLAN.md` disagrees with this file, this file wins.

## D-001 (2026-11-11) Build in a separate folder; the original repo stays untouched
- **Decision:** All work happens in `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8`. It was seeded by copying `~/Developer/tendril` (commit `4799809` plus its uncommitted client-integration work) without `.git`, `node_modules` or build output, then `git init`. Nothing in `~/Developer/tendril` is ever edited.
- **Why:** Rohan asked for it explicitly. The uncommitted work there is theirs.
- **Note:** The imported tree is commit `10a25f9` on `main` here, so every later change is diffable against the original.

## D-002 (2026-11-11) Branching and the gate
- **Decision:** Uncommitted work happens on `dev`. No further commits or merges without explicit user permission. Even with permission, `main` only receives a merge after the full gate passes twice in a row with no retries: lint, typecheck, unit tests (all packages), production build, Playwright E2E, Electron smoke.
- **Why:** Rohan's standing rule. A flaky pass counts as a fail.

## D-003 (2026-11-11) Use available app agents, with disjoint ownership
- **Decision:** Use available "Software Dev Team" engineer/test agents for complex integration and security-sensitive backend, and the configured "Free Executor (OmniRoute)" agent for routine asset generation/packaging. Review and final gate stay with the coordinator. Eight workers initially: client, server, golden tests, terrain/props, crops, bots/buildings, renderer, packaging.
- **Why:** User authorized independent model choices and as many subagents as needed. Free Executor matches the routine work and standing cost preference; no manual gateway key retrieval or model-selector changes.
- **Constraint:** Each agent's actual model/billing is set by the app/agent definition, not this chat. No claim of per-task model selection or guaranteed free execution. An unauthenticated direct gateway probe returned AUTH_002; we use the configured agent normally, not bypass authentication.

## D-004 (2026-11-11) Stack follows the plan's 11 Nov update
- **Decision:** TypeScript everywhere, and the rules engine is shared by the client and the server. Electron (not Tauri), Vite, Monaco, Three.js, Lua through wasmoon. There is no Rust and no `sim.wasm`.
- **Why:** These were already decided in PLAN.md's "endless farm" section and are already built. Plan sections that mention Tauri, `sim.wasm`, `cargo` or `rules.toml` are out of date.

## D-005 (2026-11-11) Backend runs locally first, on free tools only, and can move to Supabase later
- **Decision:** `packages/server` is plain TypeScript: Postgres SQL migrations with row-level security, pure request handlers, a replay verifier and a small `node:http` dev server. Tests run the real migrations against **PGlite** (Postgres compiled to WebAssembly, running in-process). Deploying to Supabase or Vercel is a later step, and only with Rohan's go-ahead.
- **Why:** Rohan treats paid services and required accounts as blockers. Docker is not running and the Supabase CLI is not installed. PGlite is real Postgres, so the RLS tests mean something, and the SQL ports to Supabase unchanged.
- **Alternatives:** Supabase plus Vercel now (needs accounts and a deploy, and is visible to others). SQLite (would not test RLS).

## D-006 (2026-11-11) Sign-in sits behind an adapter; development uses local tokens
- **Decision:** Handlers receive an authenticated `userId` from an `Auth` adapter. The dev adapter issues opaque random bearer tokens stored as hashes in a `sessions` table (`POST /api/dev/login`). A Supabase JWT adapter comes later.
- **Why:** The plan's GitHub and magic-link sign-in needs a hosted Supabase project (see D-005).

## D-007 (2026-11-11) Asset generation uses headless Blender; the live socket is for previews
- **Decision:** Asset scripts run with `blender -b --factory-startup -P assets/scripts/<file>.py`. The live Blender connection (`localhost:9876`, the blender-mcp add-on, Blender 5.3) is used only to inspect results interactively.
- **Why:** Headless runs are reproducible, can run in parallel (one process per agent) and never disturb Rohan's open Blender session. A smoke run took 3 seconds, including the glTF export and the thumbnail.
- **Conventions:** see CONTRACTS.md#assets. Shared helpers are in `assets/scripts/common.py`.

## D-008 (2026-11-11) Wall-clock performance assertions move out of the unit suite
- **Decision:** Unit tests must be deterministic. `expander.lua ... is fast` failed at 28.6 s against a 20 s limit while the full suite ran in parallel, and passed at 18.4 s on its own. Timing budgets move to a separate `test:perf` script that runs files one at a time. The unit test keeps every correctness assertion and drops the time limit.
- **Why:** The gate does not accept flaky passes (D-002).

## D-009 (2026-11-11) Client typecheck accepts the sim's `.ts` import paths
- **Decision:** `packages/client/tsconfig.json` gets `allowImportingTsExtensions: true` (it already has `noEmit`).
- **Why:** The client imports `@tendril/sim/src/*.ts`, which imports with `.ts` extensions. This was the only typecheck failure at import time.

## D-010 (2026-11-11) Build sequence, not a scope cancellation
- **Decision:** First playable slice: endless local live farm, sandbox, verified local backend/boards, 39 assets and unsigned packaging. Campaign/teaching UI, hosted auth, monthly leagues, tier-5 rules follow after the core is validated. These are remaining plan items, not silently declared complete or canceled. Code signing needs paid accounts and is not enabled by default.
- **Why:** Incremental integration protects working rules and allows a takeover to see exactly what is still missing. Additional crop/adjacency rules require a coordinated spec/version change; hosted auth needs explicit deployment approval.

## D-011 (2026-11-11) UI direction and honest instruments
- **Decision:** A greenhouse control-room interface: deep teal #174449, mist #DCEBEC, sage #8EA98B, wheat #D5B65B, orange #D97742. Farm is primary, Monaco alongside it, read-only soil/stock/order/crew instruments underneath. Georgia italic display, system body, monospace data. No external fonts or paid assets.
- **Why:** Farming automation is a working instrument, not a marketing page. Stock and soil must be readable, and actual action tick costs come from the rules file. Remaining action ticks are labeled honestly, not sold as a full historical profiler.

## D-012 (2026-11-11) Local tooling and outputs
- **Decision:** Root pnpm scripts run lint/typecheck/unit/build/E2E/Electron smoke; asset copy auto-builds the manifest from budget-checked sidecars. Vite proxies /api to loopback8787. Generated public/models, dist-*, .data and Python caches ignored. Playwright PW_PORT/PW_OUT isolate worker test servers.
- **Why:** Repeatable checks and no port/build collisions between agents. Backend data and generated distributions must not pollute the source review.

## D-013 (2026-11-11) Asset origins normalized in shared export
- **Decision:** common.finalize applies rotation/scale and sets the joined mesh origin to the world ground centre (0,0,0) before export.
- **Why:** Blender join preserves the first object's origin otherwise; loaded models need consistent origins for animation/instancing. Geometry appearance does not change.

## D-014 (2026-11-11) Patch Monaco's transitive sanitizer dependency
- **Decision:** Root pnpm override pins dompurify3.4.17. Runtime audit after installation reports no known vulnerabilities.
- **Why:** Original Monaco transitive DOMPurify version triggered five advisories including critical SAFE_FOR_TEMPLATES shadow-root bypass and high IN_PLACE sanitization issue. Pinning the published patched release avoids inheriting it without changing Monaco API.
- **Note:** pnpm skipped electron-winstaller postinstall; this is not approved globally or bypassed. Packaging uses NSIS; agent P must report whether the skipped optional builder dependency matters.

## D-015 (2026-11-11) Patch development toolchain advisories too
- **Decision:** Sim/server Vitest upgraded to patched4.1.12; vulnerable minimatch>=7<11.0.1 resolved to11.0.8. Full pnpm audit, not only prod audit, now reports no known vulnerabilities. Backend59tests/typecheck/lint passed independently with the upgraded toolchain.
- **Why:** Dev audit flagged critical tinypool prototype-pollution RCE paths, Vitest mocker traversal/injection and minimatch amplification advisories. No security checks or dependency-build restrictions bypassed.

## D-016 (2026-11-11) Asset build design notes are part of the brain
- **Decision:** Preserve per-stream modeling choices, triangle/footprint checks and actual build results in brain/notes/{AT,AC,AB}.md, indexed from STATUS/MAP, instead of copying hundreds of modeling decisions into this file.
- **Why:** Every consequential decision stays discoverable without bloating the central decision index. Nine bot/building exports reviewed visually: gardener bot with tool variants, red timber gabled barn, striped produce stall. Tank/hive/compost fit the stricter prop1500 budget rather than building3000; this is accepted.

## D-017 (2026-11-11) Private Lua environment and irreversible cooperative safety guard
- **Decision:** Player code compiles with an explicit allowlisted _ENV; _G points only to that environment, text load uses it too, standard libraries/API tables are copied, scheduler/JS bridge globals remain private. User-created coroutines inherit the instruction hook. Shared20Minstruction accounting uses1000-instruction slices across coroutine trees; protected-call wrappers rethrow a tripped guard instead of swallowing it.
- **Why:** G found22privatefunctions exposed and coroutine-create/wrap/pcall loops requiring external10second kills. After actual fix, sandbox6checks andgolden21checks passed; full84simtests passed without retries. Finite scripts preserve20goldenstatehashes, rulesversion2 unchanged (sandboxfix, not worldrulechange). Independentexpander200kticks includingstartup9.73s<20s;1Mticksreplay7.61ms<2000ms.
- **Remaining:** C2 implements out-of-VM watchdog/explicit restart for native-heavy calls or unexpected WASM hangs; cooperative hooks alone cannot bound every native operation.

## D-018 (2026-11-11) Strict advancing chunks and bounded replay downloads
- **Decision:** Require toTick>fromTick (zero span422); emptyactions may still advance idle time. Public replay GET uses fromTickcursor and limit1..2(default1), returns nextFromTick. Backend review's unbounded wholehistoryquery must be replaced with SQL-level limit. Native oversizedunfinisheduploads must flushJSON413before closing transport.
- **Why:** T->Tacceptedchunk consumed an unchangedcheckpointprecondition forever; repeatedpublicGETcouldallocateentireinfinitehistory. Reviewer verifiedbothbugs. Contracts updated first; S2 implementing exact fixes and regressions.

## D-019 (2026-11-11) Quiet inspectors, authentic CommonJS lint scope
- **Decision:** Mount API reference and farm inspector before first snapshot. Soil lens/frame/selectedtile stay visible; stock/order/crew detail is collapsible beneath existing average cassettes, avoiding overwhelming the farm view. ESLint no-require-imports is disabled only for .cjsfiles, not via file-local blanket suppressions.
- **Why:** C/P/V'sremaininginstrumenttests correctly exposed unmounted modules. Electron CommonJS entry is intentional, so lint must match language conventions.

## D-020 (2026-11-11) Verifier connection preserves local farms and honest score labels
- **Decision:** Webpreview connects to local verifier; desktopfile-origin stays sandboxed and does not allow null-origin CORS or privilegedNodebridges. Server farms use separate ranked.<farmId> storage namespace and server-owned seed/epoch/checkpoint. ManualboundedSynconechunk, exactacceptedprefixacknowledgment, no blind409/429retries; localpendingwealth is never labeledverified.
- **Why:** Server can validate only logs from its own checkpoint, not the existingrandomlocalfarm. Preserve every local/unsubmittedaction; auth remains explicitly localdevelopment, not production sign-in. C2 implements connection/recovery UI and tests.

## D-021 (2026-11-12) Sprout pseudocode replaces Lua
- **Decision:** Players write Sprout, a plain-English Python-ish pseudocode (docs/LANGUAGE.md) run by a deterministic TypeScript tree-walking interpreter in `packages/lang`. wasmoon, lua.ts and all Lua examples/tests are removed. Thinking budget (5,000 steps/tick) replaces the instruction guard, so scripts can never hang.
- **Why:** Rohan: "not supposed to be a Lua driven game, instead a pseudocode driven game"; chose the plain-English Python-ish style. A TS interpreter also gives the debugger (lines, vars, breakpoints, heat) and feature gating for the campaign.

## D-022 (2026-11-12) Rules version 3 replaces version 2 without dispatch
- **Decision:** Add berry/apple perennials, hives (honey, pollination), composter/compost/fertilize, clear, research unlocks (bitmask, op 15), satchel capacity, orders from unlocked crops, daily seed. v2 replays are not preserved; goldens regenerate.
- **Why:** Rohan approved all four expansions. No hosted farm, chunk or replay exists, so version dispatch would be dead code.

## D-023 (2026-11-12) Hosting: Vercel functions + Turso, GitHub OAuth; supersedes D-005/D-006 hosting parts
- **Decision:** One Vercel project serves the Astro site, the web game at /play and a single Node function at /api. Storage is Turso (libSQL); PGlite/Postgres RLS removed, ownership enforced in handlers and tested. Auth is GitHub OAuth with hashed opaque sessions; desktop uses a nonce poll. Rohan authorized an actual deploy under their accounts.
- **Why:** Rohan: "make sure it doesn't need a VM; we will use vercel and turso"; chose GitHub OAuth and real deploy.

## D-024 (2026-11-12) Website and renders
- **Decision:** `packages/site` (Astro static): landing, download, docs (language guide/reference generated from lang api.ts, crops/buildings/research generated from rules.ts with Blender PNG renders), leaderboard. Blender renders live in assets/renders.
- **Why:** Rohan asked for a documentation + download website and 2D PNGs of assets to explain them.

## D-025 (2026-11-12) Wave 3 parallelism
- **Decision:** All workstreams launch at once (Rohan: "spawn as many subagents as required and finish as soon as possible"). Client agents code against CONTRACTS while sim/lang land; coordinator integrates and runs the gate.

## D-026 (2026-11-12) Desktop auto-update from GitHub Releases
- **Decision:** `electron/updater.cjs` uses electron-updater on Windows (NSIS) and Linux AppImage: check 10 s after launch and every 6 h, download in the background (player can turn that off), install on restart or quit. macOS and .deb only check the GitHub API and open the release page. The version shows as a chip in the status bar with an update panel. electron-updater is the client's only production dependency; renderer libraries moved to devDependencies because Vite bundles them.
- **Why:** Rohan asked for auto-update and visible version info. Builds are unsigned, and Squirrel.Mac refuses unsigned updates; .deb installs need root. Windows skips signature checks when no publisherName is set; electron-updater still verifies sha512 from latest.yml.
- **Release rule:** bump `packages/client/package.json` version before tagging `v<version>`; the workflow fails a tag that does not match. v0.1.1 and earlier have no updater, so those players update once by hand.

## D-C3 (2026-11-12) The server runs Sprout, in one isolated function (C3); amends the "server never runs player code" rule
- **Decision:** `api/verify.mjs` (built from `packages/lang/src/vercel-verify.ts`) is a second Vercel function. Given a program, the challenge's kind and seed, it runs the interpreter and answers `{tokens, logHash}`. The main API compares `logHash` with the SHA-256 of the submitted log; only a match stores the source, sets `tokens` and `source_verified`. The main bundle must never contain the interpreter: `scripts/build-api.mjs` fails the build if it does. The main function reaches verify over HTTPS with a shared secret (`VERIFY_SECRET`, else derived from `TURSO_AUTH_TOKEN`; no new setting needed). Each check has an 8 s wall-clock deadline on top of the interpreter's 5,000-step-per-bot-per-tick budget; overruns are a clean 422.
- **Why:** Rohan approved server-side Sprout verification (plan C3) so Brevity numbers are as trustworthy as scores. Isolation keeps the blast radius of a player program to one stateless function with no database and no user data.
- **Rules that came with it:** the client never sends a token count (a `tokens` field is a 422); the server counts. Brevity is "fewest tokens among programs that reach par", otherwise an empty program wins it. A string literal costs one extra token per 16 characters beyond the first 16, so a log cannot be hidden in one literal. Sources are private until the author ticks "publish" and the challenge has closed (duels: also to anyone with their own entry).
## D-027 (2026-11-12) Free-tier cost cuts for Endless sync and ranking
- **Decision:** A verified chunk writes one row (the farm row carries the attempt counter, the buffered log, the cached rank/growth); `chunks` rows are written every 10 min, worth samples every 30 min; rank is capped at 500 and the client syncs by rank (15 s / 60 s / 180 s). Arena ranks are computed over the index range up to the player's own key, boards above 300 players read the top slice plus counters plus a 5-minute histogram. Details and numbers: `brain/notes/COST.md`.
- **Why:** F2 projected 11 always-on players exhaust Turso's 10M monthly writes and ~1,200 daily players exhaust 500M reads. Rohan wants the game to run itself on free tiers with a near-real-time board; the visible top stays within 15 s.

## D-028 (2026-11-12) Dependency updates and monthly releases run without a person (F5)
- **Decision:** Dependabot opens weekly grouped patch/minor pull requests. The `auto-merge` job in `.github/workflows/ci.yml` squash-merges one only after the `gate` and `e2e` jobs in that same run pass, and only when it is patch or minor, is not Electron, touches no file under `packages/sim` or `packages/lang`, and changes nothing but manifests, the lockfile or workflows. Everything else gets the `needs-human` label and waits. `monthly-release.yml` bumps the client patch version, tags and calls `release.yml` when the app changed since the last tag.
- **Why:** Rohan approved auto-merging passing patch/minor updates (viral plan) and wants the game to run itself. This is a standing exception to "no merge without permission", limited to Dependabot pull requests that pass the full gate.
- **Why in the workflow, not branch protection:** the gate is enforced by job order, so it works without repository settings. A golden replay hash change fails `pnpm test` and blocks the merge.
- **Release tag:** a push made with the workflow token does not start other workflows, so `monthly-release.yml` calls `release.yml` directly (`workflow_call`, inputs `tag` and `publish`).

## D-029 (2026-11-17) Silos and sellPlot are rules v5, switched on by data from SILO_EPOCH (L1)
- **Decision:** `World.siloTick` switches silos and `sellPlot` on (SIM_SPEC section 5). Dailies from 2026-11-17 (brought forward from 15 Dec by Rohan, no players yet; the market on v5 dailies still opens 8 Dec) and seasons starting from then are v5; Endless farms derive the tick from their start time and never store it, so their stored version, checkpoints and hashes stay readable by older desktop builds.
- **Why:** one barn makes big farms walk-bound; sellPlot undoes a bad plot purchase. Details and tuning: `brain/notes/L1-silos.md`.

## D-C3 (2026-11-17) Farm rests after 6 hours away
A live Endless farm may run at most 6 hours (216,000 ticks) behind the wall clock. `POST /farms/wake {atTick}` adds exactly the excess to `farms.rested_ms` (server-computed, only grows, idempotent; never rests below the caller's own unsynced tick). `started_at` never moves, so silo/market ticks, hashes, replays and rules versions are untouched. Target tick = (now - started_at - rested_ms) / 100 on server (`accept`) and client (`clock.ts`). The client calls wake in `connectRanked` before the farm opens. Applies to backlogs that predate the feature (pending Rohan's choice).

## D-K4 (2026-11-17) Ratings need a verified program; brief contests rate on final scores (K4)
- **Decision:** `ALGO_VERSION` 2. In every discipline and every contest only entries with `source_verified = 1` are rated (summary `excluded.noProgram`, present only when above 0 so unaffected summaries keep their bytes). Contests with `setup_v >= 2` use `final_score` (Wealth), `final_par_tick` (Speed) and tokens among entries with a final par tick (Brevity); old contests still read `net_worth` / `par_tick`. Migration 010 adds `entries.score`, `final_score`, `final_par_tick`, `hidden_done` (K3 fills them).
- **Waiting:** a brief contest is rated only when no verified entry of a rateable player (not operator-excluded, GitHub account old enough) has `hidden_done = 0`. The check is read-only and runs before the lock. Order is kept, so it holds later contests too, but only until 48 h after close: then it rates with what is done (unfinished entries have no final score and drop out) and logs a warning.
- **Why:** an action log alone can come from an offline optimiser; the program has to run on the hidden farms. Details: `brain/notes/K4.md`.

## D-K5 Sprout brief queries (2026-11-17)
Six free queries (`goal quota budget twists bot_cap plot_cap`) read optional world fields through `packages/lang/src/brief.ts`; neutral values with no brief. Feature `queries`. Names become reserved words. See brain/notes/K5.md.

## D-K1 (2026-11-17) Daily briefs are optional Setup fields, no rules bump (K1)
- **Decision:** a brief (goal + 0-2 twists, seasons exactly 2) is drawn from the challenge seed by `drawBrief` and carried as optional `Setup` fields (SIM_SPEC section 6). Setup version 2, `BRIEF_EPOCH = '2099-01-01'` (off). `RULES_VERSION` stays 5; absent fields change nothing, every existing golden hash is unchanged. Scores come from `replayWithGoal`; `finalOf` sums the visible and hidden farms.
- **Why:** the plan (`challenges/plan.md`) needs a different problem every day, and dispatch by stored data keeps old challenges, Endless farms and duels replaying exactly. Drought is `weatherBias 2` (rain segments of length 0), hard frost is `-2`.
- **Open:** festival quota sizes are first values for K2 to calibrate (`brain/notes/K1.md`).

## D-K6 (2026-11-17): brief client
Live goal progress comes from the sim worker (`tendril:goal`), with `World.brief.orderCoins` added to the sim for the orders score. A practice farm is the real brief on another world seed (`?practice=<seed>`), never submitted. On a brief day the offline fallback is a random practice brief, since today's seed is secret. Duel panel hidden on brief results until K3 confirms duel copies. Details: `brain/notes/K6.md`.

## D-K2 (2026-11-17) Reference programs, par floors and the reroll rule (K2)
- **Decision:** one plain reference Sprout program per goal (`packages/lang/examples/brief-<goal>.sprout`; the server holds copies in `REFERENCE_SOURCES`). A brief whose reference scores under a per-goal floor on the visible farm is redrawn from `rerollSeed(seed, n)`, at most 8 times, then the best draw is kept (SIM_SPEC 6.6). `QUOTA_UNIT` and the twist strengths are unchanged.
- **Why:** par is 90% of the reference, so a day the reference cannot play (a festival that needs 650 coins of research from a 30-coin start) would have a meaningless par. About 1 festival draw in 6 is rerolled, other goals under 2%. Rerolling shifts the goal mix slightly away from festival. Numbers and the checks run: `brain/notes/K2.md`.


## D-K7 (2026-11-17) Brief pages, CLI practice and recheck, how-to-play section (K7)
- **Decision:** daily pages show the brief's notice and twists (from `challengeSetup(..., SETUP_BRIEF)` on the stored seed; older rows show none). The CLI prints the brief, scores brief days by their goal, and takes `--practice` (random farm, not saved) and `--farm <seed>` (recheck a hidden farm, not saved; refused until the server publishes siblings). How-to-play gets "A new problem every day". CHANGELOG entry under Unreleased.
- **Why:** players see the problem before they play, and practice runs cannot touch the submitted run. Practice reads as "today's brief on a random farm"; the brief stays fixed.
- **Open:** closed-page sibling seeds and final scores wait for K3/K4 columns and API fields; the season page (client) waits for K6/K3.

## D-K3 (2026-11-17) Brief challenges on the server: HMAC seeds, hidden farms checked lazily after close (K3)
- **Decision:** from `setup_v >= 2` a daily or season takes `seed = HMAC-SHA256(CHALLENGE_SALT, "tendril-brief:" + id)` (first 4 bytes), sibling i the same over `id + ":h" + i`. `CHALLENGE_SALT` env, else sha256 of the Turso token; a brief with neither is refused (503). Par = 90% of the reference program's mean score over the visible and every hidden farm, min 1, stored once; if the reference cannot run, the day does not open (503) instead of storing a wrong par. After close, `closeBrief` runs each `source_verified` entry's program on the hidden farms (3 entries per request, hidden farms in parallel, arena_meta lock) and stores `final_score`, `final_par_tick`, `hidden_done`.
- **Why:** the contract's FNV hash of salt and id lets anyone continue the visible seed's hash with `:h1` and get every sibling seed without the salt (a test proves the HMAC does not). A plain brief par fallback (`DAILY_PAR`) would be meaningless for festival (permille) or orders goals.
- **Consequences:** on a brief challenge `entries.net_worth` stores the visible score (every board, tie-break and prune already sorts on it); `entries.score` holds the same value. The board stays ordered by the visible score; final scores come as fields and rate in K4.

## D-LAUNCH (2026-11-18) Daily briefs go live: BRIEF_EPOCH = 2026-11-18
- **Decision:** `BRIEF_EPOCH` is `2026-11-18` (Rohan set the launch date to today, 18 Nov his time). Dailies dated on or after it, and seasons starting on or after it, draw a brief (setup version 2). Earlier rows and every row already stored keep their version.
- **Why:** the choice is stored on the row when it is first created, so the switch changes nothing already running. `CHALLENGE_SALT` is set in Vercel; without it a brief day answers 503 instead of opening.
- **Consequences:** server tests that use a real date pin `setupVersion` to the old version where they test the pre-brief world. To roll back, set `BRIEF_EPOCH` back to a far date; rows already created as briefs keep working.

## D-W5 (2026-11-26) Site uses the workbench palette, text buttons, a cropped replay hero
- **Decision:** `packages/site` takes the workbench tokens (soil base, straw text, carrot accent) and Barlow Condensed for headings and labels. Buttons are text with an animated carrot border; primary actions are underlined. The home hero is the replay clip cropped to remove its dev footer. The three-card and four-step rows are removed.
- **Why:** Rohan asked to remove the generated look; the site should match the game, and the dev footer in the old clip showed localhost.
- **Consequences:** the light theme uses a straw base with some light-only values chosen for contrast. OG social cards still use the old font until a Barlow TTF is added.
## D-H3 (2026-11-24) Crop Circles: the picture goal is setup version 3, shipped off (H3)
- **Decision:** a new goal kind `picture` drawn only under `SETUP_PICTURE = 3`, behind `PICTURE_EPOCH = '2099-01-01'`. Dailies draw the goal out of 19 with picture 4 (about 21%); seasons keep the version 2 draw. A picture (8x8, 16x8 or 16x16, from a pool of 178 CC0 pictures or a seeded symmetric glyph, 1 draw in 5) is stored whole on the goal; extra plots come through `setup.plots`. Score is the permille of pixels matching the farm seen from above at the final tick (grass, soil, six ripe crops, the barn pixel matching anything); `parTick` is first time at par.
- **Why:** every rule change ships off and dispatches by stored data, so every existing hash, challenge and duel replays as today (a digest of 4500 version 2 setups is pinned). Storing the picture on the goal means a later change to the pool cannot alter a stored challenge.
- **Consequences:** pool pictures have at most 40% grass and 45% soil so doing nothing never wins; apple is kept rare because of its research cost. The reference program, par and floor (`BRIEF_FLOOR.picture`, now 0) come from H4; the client and share from H5.
## D-H13a (2026-11-24) Logic-first Sprout: `tend` blocks and `when` rules are expanded to ordinary Sprout (H13a)
- **Decision:** `tend every tile:` with `when <plain words>: <action>` rules (first match wins) and top-level between-tile `when` rules compile to ordinary statements inside `compile`; `expandTend` prints the result. Walking, depositing when full, returning home and an idle `wait 10` are automatic in a fixed documented order. Several bots take contiguous shares of the tile list. `countTokens` counts only what the player wrote.
- **Why:** players should write decisions, not plumbing. Expanding in the parser means the interpreter, compiled engine and server check run identical code, so no golden hash, challenge or replay changes and no epoch is needed.
- **Consequences:** five contextual keywords (`tend when every unless region`), a `tend` lesson feature id, warnings for rules that can never run, `compile` returns the program alongside warnings. Lessons 1-3 and the "See the full program" button are follow-ups (client).
