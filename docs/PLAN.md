# Farming + coding game: design and technical plan

Nov 11, 2026 · @Rohan

## Concept and pillars

**Tendril** (working title) is a desktop game where you run a hillside terrace farm without ever touching a crop. You write Lua scripts, and a crew of small tending bots carries them out. Better code grows more food, and a verified leaderboard ranks whose code farms best.

The design is original. It shares a genre with other programming and automation games, but the setting, rules, crops, bots and art are our own. Four pillars make it distinct:

- **Soil is the puzzle.** Every tile tracks moisture, nitrogen and fatigue. Crops drain or restore them, so rotation and companion planting beat brute-force replanting.
- **Time is the currency.** Every bot action costs ticks, and a season has a fixed number of them. A smarter plan literally harvests more before the season ends.
- **A crew, not a single bot.** You unlock several bots that run scripts at the same time and coordinate through shared signals. It is a gentle concurrency puzzle.
- **Contracts and weather give the farm a goal.** The market posts orders with deadlines, and a forecast API warns of rain and frost. Score is coins earned.

The one technical idea that everything else hangs on: the whole simulation is deterministic. The same script and seed always produce the same farm, on any machine. That makes local play fast and makes cheating pointless, because the server replays your bots' moves against its own copy of the rules.

The game is open-ended by design. The rules are few, simple and composable: soil chemistry, adjacency effects, shared signals, contracts. There are no scripted solutions and no limit on how hard a script may think, so players can find strategies we never planned for. The only ceiling is their own thinking.

## The endless farm (updated 11 Nov)

The main mode is one persistent farm per player that never ends and has no size limit. This section replaces the fixed seasons and the 32 by 32 cap described in the first draft, and it wins wherever older text below disagrees.

- **Unlimited land.** Land is bought in plots of 8 by 8 tiles, in any direction, forever. Plot number n costs 150 x n x n coins.
- **Unlimited bots.** Bot number m costs 80 x m x m coins. One program drives every bot, and scripts can buy land and bots themselves.
- **Compounding growth.** Costs rise polynomially, not exponentially, so a farm never hits a wall. Each step is harder, and better code reaches it sooner.
- **Same game time for everyone.** Each farm receives 10 ticks per second from the server clock, also while the app is closed. On opening, the app runs your script through the ticks you missed. Without this rule, the richest farm would belong to whoever simulated the most hours.
- **The ranked number is net worth.** Coins, plus everything spent on land and bots, plus the value of stock in the barn.
- **Verification in chunks.** The app uploads the action log in chunks. The server replays each chunk from its saved checkpoint, rejects any illegal move or any tick ahead of the clock, and saves the new checkpoint.
- **Cost stays flat as farms grow.** Tiles are computed only when a bot touches them, so server work depends on the number of moves, not on farm size.

Two build changes since the first draft. The rules engine is written in TypeScript and shared by the app and the server, so there is no `sim.wasm` and no Rust to install. The desktop shell is Electron instead of Tauri for the same reason, and it gives the identical browser engine on all three systems.

## Core game loop

The loop is write, run, inspect, improve. Each pass earns coins that unlock new crops, bot parts and API functions, which open harder contracts.

1. **Write.** Open the in-game editor and script your bots against the farm API.
2. **Run.** The simulation advances in discrete ticks. You watch bots work at 1x to 64x speed, or skip straight to the result.
3. **Inspect.** A log console, a per-bot tick profiler and tile overlays (moisture, nitrogen, fatigue) show where time and yield were lost.
4. **Improve.** Edit and rerun. Runs are deterministic, so a change in score always comes from your code.
5. **Deliver.** Harvest goes to the barn and fills market contracts for coins.
6. **Unlock.** Spend coins on the unlock tree, then take on the next terrace.

### World rules

- The farm starts as one plot of 8 by 8 tiles and grows without limit as you buy more.
- Each tile holds moisture, nitrogen and fatigue as integers from 0 to 100, plus at most one crop with a growth stage from 0 to 3.
- A crop's growth rate is set by the soil when it is planted. Harvesting too early or on tired soil cuts yield.
- Bots occupy one tile, carry a limited load, and perform one action at a time. Each action takes a fixed number of ticks.
- Time never runs out. The farm earns 10 ticks per second, forever.

### Progression

New API functions unlock in tiers, so the game teaches programming as it goes.

| Tier | Unlocks | Programming idea it teaches |
| --- | --- | --- |
| 0 | Move, till, plant, harvest, one crop | Sequences and loops |
| 1 | Tile scanning, a second crop, barn deposit | Conditionals and state |
| 2 | Watering, nitrogen-fixing crops, soil overlays | Functions and planning ahead |
| 3 | A second and third bot, shared signals | Concurrency and coordination |
| 4 | Market contracts, weather forecast | Scheduling and optimisation |
| 5 | Orchards, beehives (pollination by adjacency), compost | Spatial layout and long-horizon trade-offs |

### Modes

- **Endless farm.** The main mode: your persistent, ranked farm.
- **Leagues.** Each month everyone can start a fresh league farm at the same moment, so new players compete on level terms.
- **Sandbox.** An offline farm with free time control for testing scripts. It is never ranked.

## Player scripting API and sandbox

Players write Lua, and it runs on their own machine inside a sealed WebAssembly sandbox with no file, network or clock access. I recommend Lua because it is small, has exact instruction counting, and its coroutines make a blocking call like `bot.move()` natural.

### How a script runs

- Each bot runs one script as a coroutine. An action call such as `bot.harvest()` pauses the script for that action's tick cost, then returns.
- Thinking is free. There is no instruction limit, so a script can plan as hard as the player's own machine allows. Only actions spend game time.
- Every run is recorded as an action log: which bot did what on which tick. The log is what gets replayed and ranked.
- The only randomness in the world comes from the run's seed. Scripts get no file or network access, so a script shared by another player is safe to run.
- Runtime errors stop that bot, mark the line in the editor and leave the rest of the farm running.

### API surface (first version)

| Call | Returns | Tick cost |
| --- | --- | --- |
| `bot.move(dir)` | true, or false if blocked | 2 |
| `bot.till()` | true or false | 3 |
| `bot.plant(crop)` | true or false | 2 |
| `bot.water()` | true or false | 2 |
| `bot.harvest()` | amount picked | 3 |
| `bot.deposit()` | amount stored (at the barn) | 1 |
| `bot.scan()` | table: crop, stage, moisture, nitrogen, fatigue | 1 |
| `bot.pos()`, `bot.load()` | position, carried amounts | 0 |
| `world.tick()`, `world.size()` | current tick, grid size | 0 |
| `world.forecast(n)` | weather for the next n ticks | 1 |
| `market.orders()` | open contracts | 1 |
| `market.deliver(id)` | coins paid | 2 |
| `signal.set(key, value)`, `signal.get(key)` | shared values between bots | 0 |
| `log(...)` | writes to the console | 0 |

Calls that cost 0 ticks are free. The costs above are starting values and live in one rules file, so balancing never needs a code change.

### A first script

```lua
-- Sweep the field in rows, harvest what is ripe, replant.
local w, h = world.size()
while true do
  for y = 1, h do
    for x = 1, w - 1 do
      local t = bot.scan()
      if t.stage == 3 then bot.harvest() end
      if t.crop == nil then bot.till(); bot.plant("carrot") end
      bot.move(y % 2 == 1 and "east" or "west")
    end
    bot.move("south")
  end
end
```

### One engine, two places

The simulation rules are compiled into a single file, `sim.wasm`. The desktop app runs it together with your Lua script. The server runs the identical file with no Lua at all and only replays action logs. All game maths uses integers, never floats, so results match bit for bit across Windows, macOS and Linux.

Because the server only replays moves, the scripting language carries no anti-cheat risk. JavaScript would work equally well, so the choice between it and Lua is a matter of taste.

## Anti-cheat: the server replays your moves and runs none of your code

The server never trusts a score, and it never runs player code. Your script runs only on your machine. A ranked submission is the log of actions your bots took, and the server replays that log through its own copy of the rules to compute the score. Editing memory, patching the client or forging traffic can only ever produce a log, and a log with one illegal move is rejected.

### What each cheat runs into

| Attempt | Why it fails |
| --- | --- |
| Memory editor gives yourself coins or instant crops | Local state is never uploaded. The server rebuilds the farm from the action log alone. |
| Forged request claiming a huge score | The claimed score is ignored. Only the server's computed score is stored. |
| Patched client with free or instant actions | The server charges every action its real tick cost and rejects any move the rules do not allow, such as harvesting an empty tile. |
| Speed hack | The simulation counts ticks, not seconds. Wall-clock speed is irrelevant. |
| Hand-edited action log | A log is only a list of moves. If every move is legal, it is a valid way to play. If one is not, the run is rejected. |
| Simulating the season ahead of time | Allowed. Everything in a challenge is knowable, and working it out is the game. |
| Huge or malformed log aimed at the server | Logs have a size cap and at most one action per bot per tick. Replay cost is small and bounded. |
| Replaying someone else's submission | Submissions are tied to a signed-in account. Identical logs are flagged, and the earlier one keeps the rank. |

### Rules that keep this honest

- **No player code on our side.** The server needs no sandbox and no virtual machines. A replay is a short loop over a list of moves.
- **Version pinning.** Every score records the hash of the rules that produced it. A rules change starts a new leaderboard season, so old and new scores never mix.
- **Public seeds.** Each challenge publishes its seed. There is no hidden information, so there is nothing to leak or steal.
- **Limits.** Ten ranked submissions per account per hour and a log size cap of about 2 MB compressed.
- **Local progress is not competitive.** Campaign unlocks live in a local save file. Editing it only affects your own game.

### Limits of this design

Two things it does not try to stop. A player can copy a strategy that someone shares, and a player can use any outside tool to work out their moves. That fits the game: any legal sequence of moves is fair play, and the ranking rewards whoever thought of the best one.

## Leaderboard

The leaderboard shows only server-verified scores, and every row can be traced to the script and simulation version that produced it.

### Boards

- **All-time net worth.** Every endless farm, ranked by verified net worth.
- **Growth rate.** Net worth gained over the last 24 hours, so a clever newcomer can top a board on day one.
- **Monthly league.** Fresh farms that all started at the same moment. Final standings are kept forever.

### Submission flow

1. The player presses Submit on a finished local run.
2. The app sends the compressed action log and challenge id with the player's session token.
3. The server checks size and rate limits and queues the submission.
4. The verifier replays the log through the rules and writes the score with the rules hash.
5. The app shows the verified score and rank, usually within a few seconds.

Ties go to the earlier submission. A player's best score per board counts, and the app keeps their submission history so they can see progress.

### What players see

Rank, name, score, submission date and a replay button. Replays are cheap because the action log fully describes a run. A replay shows what the bots did, never the code behind it, so a strategy stays private unless the player shares their script.

## Client and cross-platform desktop build

I recommend building the desktop app with Tauri 2, TypeScript and Three.js. A coding game lives or dies on its editor, and this stack gets Monaco (the editor inside VS Code) and native WebAssembly for free.

### Parts of the app

- **Shell.** Tauri 2 wraps a web front end in a small native window on Windows, macOS and Linux. Installers are a few megabytes plus assets.
- **Editor.** Monaco with Lua highlighting, autocompletion for the farm API, inline error markers and the tick profiler.
- **Simulation.** `sim.wasm` runs in a background worker so the window never freezes, even at 64x speed.
- **Renderer.** Three.js draws the farm from Blender models in glTF format. It reads simulation snapshots and animates between them.
- **Saves.** Scripts and campaign progress are plain files in the user's app data folder.

### Builds for the three systems

GitHub Actions builds all three installers on every tagged release, one runner per system. That avoids cross-compiling and needs no Windows or Linux machine. The outputs are `.msi` for Windows, `.dmg` for macOS and `.AppImage` plus `.deb` for Linux.

Unsigned builds work but show a warning on first launch on Windows and macOS. Removing those warnings needs an Apple Developer account and a Windows signing certificate, which cost money. I suggest shipping unsigned until there are players.

### Engine options compared

|  | Tauri + Three.js (recommended) | Godot 4 | Unreal Engine 5 |
| --- | --- | --- | --- |
| Code editor in game | Monaco, ready made | Basic built-in control, needs work | Must be built or embedded as a web view |
| Running `sim.wasm` | Native to the platform | Needs an extension | Needs a C++ runtime plugin |
| Build all three systems | CI runners, straightforward | Exports all three from a Mac | Windows builds need a Windows machine |
| Install and setup | Small, no account | Small, no account | Very large install, Epic account |
| Visual ceiling | Stylised 3D, good | Stylised 3D, good | Highest |
| Bonus | Can also ship as a web build | Strong 3D tooling | Best lighting and effects |

Unreal would give the best lighting, but the game's look is stylised low-poly, where that advantage is small. It would also make the editor, the sandbox and the three-system builds much harder. My advice is to skip Unreal for version one.

## Backend and hosting

The backend is small: sign-in, a Postgres database, one submit endpoint and one verifier. I recommend Supabase for sign-in and the database, and a Vercel function for the verifier, since both are already connected to your account.

&#91;embedded content: architecture · desktop app and server, 6 parts\]

The only thing that crosses from the player's machine to the server is the action log. Player code never leaves the player's machine. The two highlighted boxes run the same rules.

### Services

- **Sign-in.** Supabase Auth with GitHub and email magic link. The desktop app opens the system browser and receives the session through a deep link.
- **Database.** Supabase Postgres. Row-level security lets anyone read leaderboards and lets only the verifier write scores.
- **Submit endpoint.** Checks the session, log size and rate limit, then stores the submission as queued.
- **Verifier.** A small server function that loads `sim.wasm` and replays the action log. It runs no player code, needs no sandbox or virtual machine, and uses a service key that never ships in the app.

### Data model

| Table | Holds | Who can read |
| --- | --- | --- |
| `profiles` | Display name, linked to the auth user | Everyone |
| `challenges` | Rules, farm layout, public seed, start and end dates, rules hash | Everyone |
| `submissions` | Compressed action log, log hash, status, timestamps | Owner, and everyone once it is ranked (for replays) |
| `scores` | Verified score, ticks, rules hash, link to submission | Everyone |

### Hosting options

| Option | Fit | Catch |
| --- | --- | --- |
| Supabase + Vercel (recommended) | Auth, database and verifier with almost no server code. Free tiers should cover a prototype. | Two services to configure. |
| Supabase alone, verifier as an edge function | One service fewer. | Tight CPU limit per call, so replay time must be measured first. |
| Cloudflare Workers + D1 | Cheap and fast at the edge. | Sign-in has to be built or bought separately. |

Free-tier limits and prices change, so I will check the current numbers before we commit. Replaying a 20,000-tick season is a plain loop with no scripting, so it should take milliseconds. The first build task measures it.

## Asset pipeline

All 3D assets are generated in Blender by Python scripts that I run through the Blender connection on your Mac, then exported as glTF files the game loads directly. Scripts, not hand modelling, so every asset can be regenerated and restyled in one pass.

On looks, plainly: script-built models will not reach big-studio realism. What is achievable is a polished stylised look, carried by one consistent palette, soft lighting, shadows, ambient occlusion and post-processing in the renderer. Hero assets such as the bot and the barn get extra modelling passes.

### Style and rules

- **Look.** Stylised low-poly with flat colours from one shared palette. It reads clearly from the farm camera and hides the limits of generated models.
- **Scale.** One tile is one metre. Every model's origin sits at the bottom centre of its tile.
- **Budgets.** A crop stage stays under 300 triangles, a bot under 1,500, a building under 3,000.
- **Naming.** `crop_carrot_s0.glb` to `crop_carrot_s3.glb` for growth stages, `bot_tender.glb`, `prop_barn.glb`, `tile_soil.glb`.
- **Animation.** Bots move and bob through code in the renderer, so models need no rigging in version one.

### First asset list

| Group | Items | Count |
| --- | --- | --- |
| Tiles | Grass, tilled soil, wet soil, path, terrace wall | 5 |
| Crops | Carrot, wheat, clover, pumpkin, berry bush, each in 4 stages | 20 |
| Bots | Tender bot with 3 upgrade variants | 4 |
| Buildings | Barn, market stall, water tank, beehive, compost bin | 5 |
| Props | Fence, crate, tree, rocks, signpost | 5 |

### How an asset gets made

1. A script in `assets/scripts/` builds the model in Blender from primitives and modifiers.
2. The script applies palette materials and checks the triangle budget.
3. Blender renders a thumbnail so I can check the result by eye.
4. The script exports a `.glb` into `assets/export/` and adds it to a manifest the game reads.

This needs Blender open on your Mac with the connector add-on running while assets are generated. The game is fully playable with placeholder boxes before that, so art never blocks the build.

### If you want Unreal later

The same Blender scripts can export FBX for Unreal, so the art is not wasted. The simulation, server and scripting API would carry over unchanged. Only the client would be rewritten.

## Build task breakdown

The build is 24 tasks in six milestones. I keep the architecture, the determinism core and the security review, and hand the rest to cheaper Sonnet and Haiku workers one self-contained task at a time.

### How each task is handed over

A worker sees only its brief, so every brief carries the same five parts:

- **Goal** in one sentence.
- **Exact files** it may create or change, and nothing else.
- **Interfaces** it must match, copied in full: function signatures, data shapes, the API table.
- **Constraints**, such as integers only in the simulation, no new dependencies, no network calls.
- **Done check**, a command that must pass, listed in the table below.

Workers never commit. I read each diff, run the done check myself, and either merge or send it back once with a sharper brief. After one failed retry I do the task myself. Tasks that touch the same files run one after another, and tasks with separate files run in parallel.

### Repository layout

```
tendril/
  sim/        Rust crate: world, rules, Lua binding. Builds sim.wasm and a native test binary
  client/     Tauri 2 + Vite + TypeScript: editor, renderer, HUD
  server/     SQL migrations, submit endpoint, verifier
  assets/     Blender scripts, exported .glb files, manifest
  docs/       ARCHITECTURE.md, API reference, task briefs
```

### Milestone 0: prove the core (me)

| ID | Task | Who | Done check |
| --- | --- | --- | --- |
| T0 | Spike: rules in `sim.wasm`, Lua driving one bot on a 4 by 4 grid, action log recorded and replayed | Me | Replaying the log without Lua gives the same state hash natively and in Node, and replay time for 20,000 ticks is measured |
| T1 | Write `docs/ARCHITECTURE.md`, the API spec file, the action log format and the state snapshot format | Me | Every later brief can quote its interfaces from these files |

### Milestone 1: simulation

| ID | Task | Who | Needs | Done check |
| --- | --- | --- | --- | --- |
| T2 | Repo scaffold, lint, test and wasm build scripts, CI | Haiku | T0 | `cargo test` and the wasm build pass on a clean clone and in CI |
| T3 | World state, seeded random numbers, state hash | Sonnet | T1 | Unit tests: same seed gives same hash 1,000 times, different seeds differ |
| T4 | Crop and soil rules loaded from `rules.toml` | Sonnet | T3 | Table-driven tests for each crop's growth, yield and soil effect |
| T5 | Bot actions and the tick scheduler | Sonnet | T3 | Tests for every action's tick cost, blocking and failure cases |
| T6 | Lua binding for the full API, coroutine pauses, action log recording | Sonnet, I review | T5 | Replaying a recorded action log without Lua gives the same state hash as the live run |
| T7 | Market contracts and weather | Sonnet | T4, T5 | Tests for deadlines, payouts, rain and frost effects |
| T8 | Command-line runner: `sim run script.lua --seed 7` | Haiku | T6 | Prints score and state hash, exits non-zero on script error |
| T9 | Golden test suite: 20 scripts with recorded hashes | Haiku | T7, T8 | CI fails if any hash changes without the rules version changing |

### Milestone 2: desktop client

| ID | Task | Who | Needs | Done check |
| --- | --- | --- | --- | --- |
| T10 | Tauri shell, Vite app, worker that loads `sim.wasm` | Sonnet | T6 | App opens, runs a bundled script, shows the same hash as the command-line runner |
| T11 | Monaco editor: Lua highlighting, API autocompletion, error markers | Sonnet | T10 | Typing `bot.` lists every API call, and a runtime error underlines its line |
| T12 | 3D farm view with placeholder boxes, camera, smooth movement | Sonnet | T10 | Playwright screenshot test of a known seed at tick 500 matches |
| T13 | HUD: run, pause, speed, console, tick profiler, soil overlays | Sonnet | T11, T12 | Speed control from 1x to 64x works and the console shows `log` output |
| T14 | Campaign terraces, unlock tree, local saves | Sonnet | T13 | Finishing terrace 1 unlocks tier 1 and survives an app restart |
| T15 | In-game API reference generated from the API spec file | Haiku | T1, T10 | Every call in the spec appears with its cost and an example |

### Milestone 3: art

| ID | Task | Who | Needs | Done check |
| --- | --- | --- | --- | --- |
| T16 | Blender scripts and exports for the 39 first assets | Me, through Blender on your Mac | T12 | Every file is within its triangle budget and has a thumbnail I have checked |
| T17 | Asset manifest loader that swaps placeholders for models | Haiku | T12 | Missing models fall back to boxes, and the screenshot test passes with models |

### Milestone 4: backend and leaderboard

| ID | Task | Who | Needs | Done check |
| --- | --- | --- | --- | --- |
| T18 | Database tables and row-level security | Sonnet, I review | T1 | Tests prove an anonymous or signed-in user cannot write a score |
| T19 | Submit endpoint with size and rate limits | Sonnet | T18 | Oversized, unauthenticated and over-limit requests are each rejected |
| T20 | Verifier that replays action logs in `sim.wasm` | Sonnet, I review | T9, T18 | Replayed score for the 20 golden runs equals the command-line runner's, and a log with one illegal move is rejected |
| T21 | Sign-in and leaderboard screens in the client | Sonnet | T13, T19 | A signed-in test account submits and sees its rank |

### Milestone 5: ship

| ID | Task | Who | Needs | Done check |
| --- | --- | --- | --- | --- |
| T22 | Release workflow that builds Windows, macOS and Linux installers | Haiku | T14 | A tagged commit produces three installers that launch |
| T23 | Attack pass: forged score, patched client, illegal moves, edited logs, oversized logs | Me | T20, T21 | Every attack in the anti-cheat table is tried and fails, with results written up |

### Order and checkpoints

Milestone 1 comes first because everything depends on it. After that, milestones 2 and 4 run side by side, and art joins once the farm view exists. I will check in with you at three points: after the spike, when the farm is first playable with placeholder art, and before the first public leaderboard goes live.

## Decisions you can still change

You asked me to go from planning straight to building, so I am going ahead with the recommendations below. Tell me if you want any of them changed. The earlier, the cheaper.

| # | Decision | My recommendation | Alternatives |
| --- | --- | --- | --- |
| 1 | Game client | Tauri 2 + Three.js. No Unreal install. | Godot 4, or Unreal Engine 5 (large install, Epic account, Windows machine for Windows builds) |
| 2 | Scripting language for players | Lua | JavaScript, which more players know but is harder to meter exactly |
| 3 | Backend hosting | Supabase for sign-in and database, Vercel for the verifier | Supabase plus a small paid server, or Cloudflare |
| 4 | Sign-in methods | GitHub and email magic link | Add Google or Steam later |
| 5 | Code signing | Ship unsigned for now | Pay for Apple and Windows signing to remove first-launch warnings |
| 6 | Workers for the delegated tasks | Sonnet and Haiku subagents | Your free OmniRoute workers, which cost nothing but send code to third-party providers |

Two smaller things I will assume unless you say otherwise:

- The working title stays **Tendril** and the code lives in a new private GitHub repository named `tendril` under your account.
- The project folder on your Mac is `~/Developer/tendril`.

Nothing has been installed or created yet apart from this document.
