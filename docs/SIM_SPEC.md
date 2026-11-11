# Tendril simulation spec (rules version 1)

Single source of truth for `packages/sim`. Everything here is integer maths. Forbidden in rule code:
floats (other than `| 0` truncating division), `Math.random`, `Date`, `performance`, iteration over
`Map`/`Set`/object keys whose insertion order depends on input, and any I/O.

## Challenge (input to a run)
```ts
interface Challenge {
  id: string; w: number; h: number;      // grid 4..32
  seed: number;                           // uint32, 0 is treated as 1
  endTick: number;                        // season length, e.g. 20000
  bots: number;                           // 1..8, bot i starts at the barn tile
  barn: { x: number; y: number };         // barn tile: cannot be tilled or planted
  crops: number[];                        // crop ids allowed in this challenge
}
```

## State
- `tick`, `rng` (xorshift32, see `rand` in world.ts), `coins`.
- Tiles: `Int32Array(w*h*6)`, per tile: `tilled, crop, growth, moisture, nitrogen, fatigue`.
  Initial: tilled 0, crop 0, growth 0, moisture 50, nitrogen `30 + rand % 21`, fatigue 0
  (tiles initialised in index order, one `rand` call each, before weather and orders are generated).
- Bots: `x, y, busyUntil, load[cropId]` (units carried per crop). Capacity: 20 units total.
  Bots may share a tile. Nothing blocks movement except the grid edge.
- Barn stock per crop id.
- Weather schedule and orders: generated once at `createWorld`, in that order, from `rng`.

## Crops
| id | name | stageLen | thirst | hunger | drink | nDelta | fatigue | yield | price | hardy |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | carrot | 60 | 20 | 10 | 2 | -8 | 6 | 4 | 2 | no |
| 2 | wheat | 90 | 15 | 20 | 1 | -12 | 8 | 8 | 3 | yes |
| 3 | clover | 50 | 25 | 0 | 2 | 20 | -10 | 1 | 1 | yes |
| 4 | pumpkin | 150 | 40 | 30 | 4 | -20 | 15 | 20 | 6 | no |

Stage = `min(3, growth / stageLen | 0)`. Growth is capped at `3 * stageLen`.

## One world tick (`tickWorld`), in this exact order
1. Weather for this tick `T` is looked up from the schedule: clear, rain or frost.
2. If frost starts exactly at `T`: every non-hardy crop at stage 0 dies (crop 0, growth 0; tile stays tilled).
3. For each tile in index order that has a crop `c`:
   - rate = 0 if moisture == 0, or if frost and `c` is not hardy; else
     2 if `moisture >= thirst` and `nitrogen >= hunger`; else 1.
   - `growth = min(3*stageLen, growth + rate)`.
   - if `T % 8 == 0`: `moisture = max(0, moisture - drink)`.
4. For each tile with no crop: if `T % 16 == 0`: `fatigue = max(0, fatigue - 1)`.
5. If rain and `T % 4 == 0`: every tile `moisture = min(100, moisture + 2)`.
6. `tick = T + 1`.

## Weather schedule
```
t = 0
while t < endTick:
  t += 300 + rand % 500                       // clear spell
  if t >= endTick: break
  if rand % 4 == 0: kind = frost, len = 60 + rand % 60
  else:             kind = rain,  len = 80 + rand % 120
  push { kind, start: t, end: t + len }       // end exclusive
  t += len
```

## Orders (generated after weather)
```
t = 200; id = 1
while t < endTick - 500:
  crop = crops[rand % crops.length]
  qty  = 5 + rand % 16
  life = 1500 + rand % 1500
  push { id, crop, qty, reward: qty * price(crop) * 2 + 10, opensAt: t, deadline: t + life, filled: false }
  id += 1; t += 800 + rand % 1200
```
An order is *open* when `opensAt <= tick <= deadline` and not filled.

## Actions (the only things that change the world besides ticks)
A bot can start an action only when `busyUntil <= tick`. Starting sets `busyUntil = tick + cost`;
the effect is applied immediately. Result 0 means "failed in-world" and is still a legal move.

| op | index | arg | cost | effect and result |
|---|---|---|---|---|
| move | 0 | dir 0..3 = north, east, south, west | 2 | step one tile; 0 at the grid edge, else 1 |
| till | 1 | none | 3 | 0 on barn tile or if a crop is present; else tilled = 1, result 1 |
| plant | 2 | crop id | 2 | 0 unless tile is tilled, empty and not barn; else crop set, growth 0, result 1 |
| water | 3 | none | 2 | `moisture = min(100, moisture + 30)`, result 1 |
| harvest | 4 | none | 3 | 0 if no crop. units = stage < 3 ? 0 : `max(1, yield * (100 - fatigue) / 100 \| 0)`. Bot takes `min(units, free capacity)`, rest is lost. Then `nitrogen = clamp(nitrogen + nDelta)`, `fatigue = clamp(fatigue + fatigue_c)` (both 0..100), crop 0, growth 0, tilled 0. Result = units taken |
| deposit | 5 | none | 1 | 0 unless on the barn tile; moves all load to barn stock; result = units moved |
| deliver | 6 | order id | 2 | 0 unless on barn tile, order open, and barn stock of its crop >= qty; then stock -= qty, coins += reward, filled; result = reward |
| wait | 7 | n 1..1000 | n | result 1 |

Illegal (replay throws `IllegalAction`, run is rejected): `t` not an integer, `t` lower than the
previous entry's `t`, `t >= endTick`, bot index out of range, bot busy, unknown op index, arg missing,
non-integer or out of range (dir, crop id not in `challenge.crops`, wait n). An unknown order id is a
legal move with result 0.

## Score
`finalScore = coins + sum(barn stock[c] * price(c))`, computed at `tick == endTick`. Bot loads count for nothing.

## Action log (the only thing sent to the server)
```ts
type LogEntry = [t: number, bot: number, op: number, arg?: number];
interface ActionLog { v: 1; rules: 1; challenge: string; actions: LogEntry[] }
```
Entries are in the order they were applied. Within a tick the local runner resumes bots in id order.

## Public API of `@tendril/sim` (exact names)
```ts
createWorld(ch: Challenge): World
applyAction(world: World, e: LogEntry): number          // throws IllegalAction
tickWorld(world: World): void
replay(ch: Challenge, log: ActionLog): { score: number; hash: string; coins: number }  // throws IllegalAction
hashWorld(world: World): string                          // 8 hex chars, FNV-1a over every state int
finalScore(world: World): number
snapshot(world: World): Snapshot                         // plain JSON for the renderer, see below
// free queries (never logged)
scan(world, bot): { tilled; crop; stage; moisture; nitrogen; fatigue; barn: boolean }
forecast(world, n): { kind: 'clear'|'rain'|'frost'; start: number; end: number }[]  // segments overlapping [tick, tick+n)
openOrders(world): Order[]
weatherAt(world, tick): 'clear'|'rain'|'frost'
CROPS, OPS, COST, DIRS, RULES_VERSION = 1
```
```ts
interface Snapshot {
  tick: number; endTick: number; coins: number; score: number; weather: 'clear'|'rain'|'frost';
  w: number; h: number; barn: { x: number; y: number };
  tiles: { tilled: number; crop: number; stage: number; moisture: number; nitrogen: number; fatigue: number }[];
  bots: { x: number; y: number; busyUntil: number; load: number; op: number | null }[];  // op = action in progress
  stock: Record<number, number>; orders: Order[];
}
```

## Lua layer (`src/lua.ts`, local play only, never imported by the server)
Scripts run as coroutines scheduled inside Lua (see the spike in `src/lua.ts`). Player-facing API:
`bot.move(dir)` (dir is "north"/"east"/"south"/"west"), `bot.till()`, `bot.plant(name)`, `bot.water()`,
`bot.harvest()`, `bot.deposit()`, `bot.wait(n)`, `bot.scan()`, `bot.pos()` → x, y (1-based),
`bot.load()` → table name→units, `bot.id()`, `world.tick()`, `world.size()`, `world.forecast(n)`,
`market.orders()`, `market.deliver(id)`, `market.stock()`, `signal.set(k, v)`, `signal.get(k)`
(a plain Lua table shared by all bots, not part of world state), `log(...)`.
Bad arguments (unknown direction or crop name) raise a Lua error in that bot instead of being logged.
```ts
interface LuaRun {
  world: World; log: ActionLog; errors: { bot: number; message: string }[]; output: string[];
  step(ticks: number): void;       // advance up to `ticks` ticks, stops at endTick
  close(): void;
}
createLuaRun(ch: Challenge, scripts: string[]): Promise<LuaRun>   // scripts[i] drives bot i
```
