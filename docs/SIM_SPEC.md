# Tendril simulation spec (rules version 2: endless farm)

Single source of truth for `packages/sim`. Integer maths only. Forbidden in rule code: floats
(other than `| 0` truncating division), `Math.random`, `Date`, `performance`, any I/O, and iterating
`Map`/`Set`/object keys where order could depend on anything but insertion order defined here.
Every number must stay a safe integer; throw `Error('overflow')` if `coins` would exceed 2^53 - 1.

Design goals: (1) the farm never ends and can grow without limit; (2) `tickWorld` is O(1) and a
tile is only computed when touched ("lazy settle"), so cost depends on actions, not farm size;
(3) the server can verify a run from the action log alone, in chunks, from a saved checkpoint.

## Farm (input)
```ts
interface Farm { id: string; seed: number /* uint32, 0 -> 1 */ }
```
Real-time gating (10 ticks per second since the farm's start) is enforced by the server, not here.

## Land
- Tiles live on an infinite integer plane `(x, y)`. Land is owned in plots of 8x8 tiles.
  Plot `(px, py)` covers `x in [8px, 8px+7]`, `y in [8py, 8py+7]`. Use floor division for negatives.
- A new farm owns plot `(0, 0)`. The barn is tile `(0, 0)`: it cannot be tilled or planted.
- Plots are stored in purchase order: `plots: { px, py, tiles: Int32Array(64 * 8) }[]` plus a
  lookup `Map<string, number>` from `"px,py"` to index. Hashing walks `plots` in array order.
- Tile fields (8 ints): `tilled, crop, plantedAt, rate, moisture, nitrogen, fatigue, updated`.
  Initial: `0, 0, 0, 0, 50, 30 + tileHash(seed, x, y) % 21, 0, <tick the plot was bought>`.
- `tileHash(seed, x, y)`: `h = seed; h = imul(h ^ (x|0), 0x9E3779B1); h = imul(h ^ (y|0), 0x85EBCA6B); h ^= h >>> 15; return h >>> 0`.

## Crops
| id | name | stageLen | thirst | hunger | drink | nDelta | fatigue | yield | price | hardy |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | carrot | 60 | 20 | 10 | 10 | -8 | 6 | 4 | 2 | no |
| 2 | wheat | 90 | 15 | 20 | 6 | -12 | 8 | 8 | 3 | yes |
| 3 | clover | 50 | 25 | 0 | 10 | 20 | -10 | 1 | 1 | yes |
| 4 | pumpkin | 150 | 40 | 30 | 25 | -20 | 15 | 20 | 6 | no |

## Weather (infinite schedule, generated on demand from its own stream `wrng`, seeded `seed ^ 0xA5A5A5A5`, 0 -> 1)
Segments are appended in order whenever a tick beyond the last generated segment is needed:
```
t = end of last segment (0 at start)
t += 300 + rand(wrng) % 500                 // clear spell (not stored)
if rand(wrng) % 4 == 0: kind = frost, len = 60 + rand(wrng) % 60
else:                    kind = rain,  len = 80 + rand(wrng) % 120
push { kind, start: t, end: t + len }       // end exclusive
```
`rand` is xorshift32: `x ^= x << 13; x ^= x >>> 17; x ^= x << 5` on uint32.
Helpers: `rainTicks(a, b)` = number of ticks `T` in `[a, b)` that are rain and `T % 4 == 0`;
`frostTicks(a, b)` = number of frost ticks in `[a, b)`. Both by segment overlap, no per-tick loops.

## Lazy settle: `settle(tile, T)` brings a tile from `updated` to tick `T` (call before any read or write)
1. `moisture = min(100, moisture + 2 * rainTicks(updated, T))`.
2. If no crop: `fatigue = max(0, fatigue - (floor(T/16) - floor(updated/16)))`.
3. If crop `c` is not hardy: for each frost segment with `updated < start <= T`, in order:
   if `growthAt(start) < stageLen` the crop dies (`crop = 0, plantedAt = 0, rate = 0`, tile stays tilled) and stop.
4. `updated = T`.

`growthAt(T)` for a planted tile: `g = rate * (T - plantedAt - (hardy ? 0 : frostTicks(plantedAt, T)))`,
`growth = min(3 * stageLen, g)`. Stage = `min(3, growth / stageLen | 0)`.
`rate` is fixed when planting: 2 if `moisture >= thirst && nitrogen >= hunger` (checked before the drink), else 1.

## Orders (infinite, own stream `orng`, seeded `seed ^ 0x5EED5EED`, 0 -> 1)
`nextOrderAt` starts at 200, `nextOrderId` at 1. Inside `tickWorld`, after `tick++`:
```
while nextOrderAt <= tick:
  crop = 1 + rand(orng) % 4
  qty  = (5 + rand(orng) % 16) * plots.length
  life = 1500 + rand(orng) % 1500
  push { id: nextOrderId++, crop, qty, reward: qty * price(crop) * 2 + 10, opensAt: nextOrderAt, deadline: nextOrderAt + life }
  nextOrderAt += 800 + rand(orng) % 1200
drop orders with deadline < tick
```
An order is open while it is in the list (filled orders are removed).

## Bots
`{ x, y, busyUntil, load: Int32Array(5) }` (index = crop id). Capacity 20 units total. A new farm has one
bot at `(0, 0)`. Bots may share tiles. A move onto unowned land fails with result 0.

## Actions
Log entry: `[t, bot, op, a?, b?]`. A bot can start an action only when `busyUntil <= tick`; starting sets
`busyUntil = tick + cost`; the effect applies immediately (settle the tile first). Result 0 = failed
in-world, which is still a legal move. Farm-level actions use `bot = -1`, cost 0 ticks.

| op | index | args | cost | effect and result |
|---|---|---|---|---|
| move | 0 | a = dir 0..3 (north = y-1, east = x+1, south = y+1, west = x-1) | 2 | 0 if target tile is unowned, else step, 1 |
| till | 1 | | 3 | 0 on the barn or if a crop is present; else tilled = 1, result 1 |
| plant | 2 | a = crop id 1..4 | 2 | 0 unless tilled, no crop, not barn; else set rate (see above), `moisture = max(0, moisture - drink)`, crop = a, plantedAt = tick, result 1 |
| water | 3 | | 2 | `moisture = min(100, moisture + 30)`, result 1 |
| harvest | 4 | | 3 | 0 if no crop. units = stage < 3 ? 0 : `max(1, yield * (100 - fatigue) / 100 \| 0)`. Bot takes `min(units, free capacity)`. Then `nitrogen = clamp(nitrogen + nDelta, 0, 100)`, `fatigue = clamp(fatigue + fatigue_c, 0, 100)`, crop = 0, plantedAt = 0, rate = 0, tilled = 0. Result = units taken |
| deposit | 5 | | 1 | 0 unless on the barn; all load moves to barn stock; result = units moved |
| deliver | 6 | a = order id | 2 | 0 unless on the barn, order open, stock[crop] >= qty; then stock -= qty, coins += reward, order removed; result = reward |
| wait | 7 | a = n 1..1000 | n | result 1 |
| sell | 8 | a = crop id, b = units >= 1 | 1 | 0 unless on the barn and stock[a] >= b; then stock -= b, coins += b * price; result = coins gained |
| buyPlot | 9 | a = px, b = py; bot = -1 | 0 | 0 if owned, not edge-adjacent to an owned plot, or coins < `plotCost`; else pay and append the plot; result 1 |
| buyBot | 10 | bot = -1 | 0 | 0 if coins < `botCost`; else pay, append a bot at `(0, 0)` with `busyUntil = tick`; result = new bot index + 1 |

`plotCost = 150 * n * n` where `n` = plots owned now. `botCost = 80 * m * m` where `m` = bots owned now.
`spent` accumulates every coin paid for plots and bots.

Illegal (throw `IllegalAction`; the whole chunk is rejected): `t` not an integer or lower than the previous
entry's `t` or lower than the world tick; bot index out of range (or not -1 for ops 9, 10; or -1 for ops 0..8);
bot busy; unknown op; any required arg missing, non-integer or out of range.

## Tick
`tickWorld(world)`: `tick++`, then the order generation above. Nothing else. All tile changes are lazy.

## Net worth (the ranked number)
`netWorth = coins + spent + sum(stock[c] * price(c))`.

## Hash and checkpoint
- `hashWorld(world)`: FNV-1a 32-bit over, in order: tick, coins, spent, orng, nextOrderAt, nextOrderId,
  stock[1..4], each weather segment with `start <= tick` (kind, start, end; `wrng` itself is NOT hashed), each order (id, crop, qty, reward, opensAt, deadline),
  each bot (x, y, busyUntil, load[1..4]), each plot (px, py, all tile ints). Each int is mixed as 8 bytes
  (low 32 bits then high 32 bits, little-endian) so large values hash correctly. Result: 8 hex chars.
- `serialize(world): string` (JSON) and `deserialize(s): World` round-trip exactly: `hashWorld(deserialize(serialize(w))) === hashWorld(w)`.

## Public API of `@tendril/sim` (exact names; all exported from `src/index.ts`)
```ts
createWorld(farm: Farm): World
applyAction(world: World, e: LogEntry): number            // throws IllegalAction
tickWorld(world: World): void
replayChunk(world: World, actions: LogEntry[], toTick: number): void  // mutates; throws IllegalAction; ends with world.tick === toTick
hashWorld(world: World): string
netWorth(world: World): number
serialize(world: World): string;  deserialize(s: string): World
snapshot(world: World): Snapshot                          // settles a copy of every owned tile to world.tick; does not mutate world
// free queries (never logged, must not mutate hashed state; settle on a copy)
scan(world, bot): { tilled; crop; stage; moisture; nitrogen; fatigue; barn: boolean }
scanAt(world, x, y): same | null (null when unowned)
forecast(world, n): { kind: 'rain'|'frost'; start: number; end: number }[]   // segments overlapping [tick, tick+n)
weatherAt(world, tick): 'clear'|'rain'|'frost'
openOrders(world): Order[]
plotCost(world): number;  botCost(world): number
CROPS, OPS, COST, RULES_VERSION = 2
type LogEntry = [t: number, bot: number, op: number, a?: number, b?: number]
```
Note: `forecast`/`weatherAt` may extend the generated weather schedule. That is allowed because the
schedule is a pure function of the seed; the hash must therefore only include segments with `start <= tick`.
```ts
interface Snapshot {
  tick: number; coins: number; netWorth: number; weather: 'clear'|'rain'|'frost';
  plots: { px: number; py: number }[];
  tiles: { x: number; y: number; tilled: number; crop: number; stage: number; moisture: number; nitrogen: number; fatigue: number }[];
  bots: { x: number; y: number; busyUntil: number; load: number; op: number | null }[];
  stock: number[]; orders: Order[]; plotCost: number; botCost: number;
}
```
`World` keeps `lastOp: (number | null)[]` per bot for the snapshot only; it is not hashed but is serialized.

## Lua layer (`src/lua.ts`, local play only, never imported by the server)
One program drives every bot: the same source is started as a coroutine per bot (see the spike for the
scheduling pattern: coroutines live inside Lua, actions are `coroutine.yield`). Bots bought later get a
coroutine the moment they exist. Scripts cannot be saved mid-run: after an app restart or a script edit,
every coroutine restarts from the top against the current world, so good scripts read the world first.
Player API (1-based nothing: coordinates are the world's integer `x, y`):
`bot.id()`, `bot.move(dir)` ("north"/"east"/"south"/"west"), `bot.till()`, `bot.plant(name)`, `bot.water()`,
`bot.harvest()`, `bot.deposit()`, `bot.wait(n)`, `bot.scan()`, `bot.pos()` -> x, y, `bot.load()` -> table name->units,
`world.tick()`, `world.scan(x, y)`, `world.owns(x, y)`, `world.plots()`, `world.forecast(n)`, `world.weather()`,
`market.orders()`, `market.deliver(id)`, `market.sell(name, units)`, `market.stock()`, `market.coins()`,
`farm.plot_cost()`, `farm.buy_plot(px, py)`, `farm.bot_cost()`, `farm.buy_bot()`, `farm.bots()`,
`signal.set(k, v)`, `signal.get(k)` (a Lua table shared by all bots, not world state), `log(...)`.
`farm.buy_*` are instant (no yield). Unknown direction or crop names raise a Lua error in that bot.
`os`, `io`, `require`, `dofile`, `loadfile`, `package`, `debug` are removed.
```ts
interface LuaRun {
  world: World; pending: LogEntry[];            // actions since the last takeLog()
  errors: { bot: number; message: string }[]; output: string[];
  step(ticks: number): void;                    // advance exactly `ticks` ticks
  takeLog(): LogEntry[];                        // returns and clears `pending`
  close(): void;
}
createLuaRun(world: World, source: string): Promise<LuaRun>   // world from createWorld or deserialize
```
Within a tick, idle bots are resumed in index order; farm-level actions are logged at the current tick.
