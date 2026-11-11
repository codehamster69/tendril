# Tendril simulation spec (rules version 3: endless farm, research, perennials, buildings)

Single source of truth for `packages/sim`. Integer maths only. Forbidden in rule code: floats
(other than `| 0` truncating division), `Math.random`, `Date`, `performance`, any I/O, and iterating
`Map`/`Set`/object keys where order could depend on anything but insertion order defined here.
Every number must stay a safe integer; throw `Error('overflow')` if `coins` would exceed 2^53 - 1.
Version 3 replaces version 2 outright (D-022): no hosted farm or replay exists, so there is no
version dispatch. The player language is Sprout (`docs/LANGUAGE.md`), which lives outside this package.

Design goals: (1) the farm never ends and can grow without limit; (2) `tickWorld` is O(1) and a
tile is only computed when touched ("lazy settle"), so cost depends on actions, not farm size;
(3) the server can verify a run from the action log alone, in chunks, from a saved checkpoint.

## Farm (input)
```ts
interface Farm { id: string; seed: number /* uint32, 0 -> 1 */ }
interface Setup { coins?: number; unlocks?: number }  // local campaign fixtures only; the server never passes it
```
Real-time gating (10 ticks per second since the farm's start) is enforced by the server, not here.
Horizon: tile timestamps are Int32, valid to tick 2^31-1 (about 6.8 years at 10 TPS).

## Items
Index 1..8: `1 carrot, 2 wheat, 3 clover, 4 pumpkin, 5 berry, 6 apple, 7 honey, 8 compost`.
Items 1..6 are crops (plantable). Honey comes from hives. Compost is made at a composter, is carried
by bots only (never deposited, never sold, worth 0). Prices: crops from the table, honey 8, compost 0.

## Land
- Tiles live on an infinite integer plane `(x, y)`. Land is owned in plots of 8x8 tiles.
  Plot `(px, py)` covers `x in [8px, 8px+7]`, `y in [8py, 8py+7]`. Use floor division for negatives.
- A new farm owns plot `(0, 0)`. The barn is tile `(0, 0)`: it cannot be tilled, planted, built on or cleared.
- Plots are stored in purchase order: `plots: { px, py, tiles: Int32Array(64 * 10) }[]` plus a
  lookup `Map<string, number>` from `"px,py"` to index. Hashing walks `plots` in array order.
- Tile fields (10 ints): `tilled, crop, plantedAt, rate, moisture, nitrogen, fatigue, updated, building, built`.
  Initial: `0, 0, 0, 0, 50, 30 + tileHash(seed, x, y) % 21, 0, <tick the plot was bought>, 0, 0`.
- `tileHash(seed, x, y)`: `h = seed; h = imul(h ^ (x|0), 0x9E3779B1); h = imul(h ^ (y|0), 0x85EBCA6B); h ^= h >>> 15; return h >>> 0`.

## Crops
| id | name | stageLen | thirst | hunger | drink | nDelta | fatigue | yield | price | hardy | perennial |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | carrot | 60 | 20 | 10 | 10 | -8 | 6 | 4 | 2 | no | no |
| 2 | wheat | 90 | 15 | 20 | 6 | -12 | 8 | 8 | 3 | yes | no |
| 3 | clover | 50 | 25 | 0 | 10 | 20 | -10 | 1 | 1 | yes | no |
| 4 | pumpkin | 150 | 40 | 30 | 25 | -20 | 15 | 20 | 6 | no | no |
| 5 | berry | 80 | 20 | 15 | 8 | -6 | 4 | 6 | 4 | yes | yes |
| 6 | apple | 200 | 30 | 25 | 15 | -10 | 6 | 24 | 5 | yes | yes |

## Buildings
`building` tile field: `0 none, 1 hive, 2 composter`. Coin prices: hive 120, composter 80 (fixed, added to `spent`).
- **Hive honey:** `honeyAt(T) = min(6, floor((T - built) / 400))`.
- **Pollination:** when a mature crop is harvested, `h` = number of the 4 orthogonal neighbour tiles that are
  owned and have `building == 1`. Final units `u = base + (base * 25 * h / 100 | 0)` where
  `base = max(1, yield * (100 - fatigue) / 100 | 0)`.

## Research (unlocks)
`unlocks` is a bitmask on the world; a new farm has `unlocks = 1` (carrot). Bit id, name, coin price:
`0 carrot 0, 1 wheat 40, 2 clover 60, 3 pumpkin 250, 4 berry 400, 5 apple 900, 6 hive 300, 7 composter 200, 8 satchel 500`.
Crop `c` (1..6) needs bit `c - 1`. Hive needs bit 6, composter bit 7. Satchel raises bot capacity.
Capacity (total carried units of all items, per bot) = `satchel ? 30 : 20`. Unlock prices add to `spent`.

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
`rate` is set when planting (and on perennial regrowth): 2 if `moisture >= thirst && nitrogen >= hunger`
(checked before the drink), else 1.

## Orders (infinite, own stream `orng`, seeded `seed ^ 0x5EED5EED`, 0 -> 1)
`nextOrderAt` starts at 200, `nextOrderId` at 1. Inside `tickWorld`, after `tick++`:
```
while nextOrderAt <= tick:
  pool = unlocked crop ids among 1..6, ascending        // never empty: carrot is always unlocked
  crop = pool[rand(orng) % pool.length]
  qty  = (5 + rand(orng) % 16) * plots.length
  life = 1500 + rand(orng) % 1500
  push { id: nextOrderId++, crop, qty, reward: qty * price(crop) * 2 + 10, opensAt: nextOrderAt, deadline: nextOrderAt + life }
  nextOrderAt += 800 + rand(orng) % 1200
drop orders with deadline < tick
```
An order is open while it is in the list (filled orders are removed).

## Bots
`{ x, y, busyUntil, load: Int32Array(9) }` (index = item id). A new farm has one bot at `(0, 0)`.
Bots may share tiles. A move onto unowned land fails with result 0.

## Actions
Log entry: `[t, bot, op, a?, b?]`. A bot can start an action only when `busyUntil <= tick`; starting sets
`busyUntil = tick + cost`; the effect applies immediately (settle the tile first). Result 0 = failed
in-world, which is still a legal move. Farm-level actions use `bot = -1`, cost 0 ticks.
"Free capacity" = capacity minus the sum of `load[1..8]`.

| op | index | args | cost | effect and result |
|---|---|---|---|---|
| move | 0 | a = dir 0..3 (north = y-1, east = x+1, south = y+1, west = x-1) | 2 | 0 if target tile is unowned, else step, 1 |
| till | 1 | | 3 | 0 on the barn, if a crop is present or a building is present; else tilled = 1, result 1 |
| plant | 2 | a = crop 1..6 | 2 | 0 unless crop unlocked, tilled, no crop, no building, not barn; else set rate, `moisture = max(0, moisture - drink)`, crop = a, plantedAt = tick, result 1 |
| water | 3 | | 2 | `moisture = min(100, moisture + 30)`, result 1 |
| harvest | 4 | | 3 | Hive tile: normalise `built = max(built, T - 2400)`, units = `honeyAt(T)`, take `min(units, free)` honey, `built += taken * 400`, result = taken. Crop tile: 0 if no crop. Annual: units = stage < 3 ? 0 : pollinated `u`; bot takes `min(units, free)`; `nitrogen = clamp(n + nDelta, 0, 100)`, `fatigue = clamp(f + fatigue_c, 0, 100)`; crop, plantedAt, rate, tilled = 0. Perennial: if stage < 3 result 0 and nothing changes; else take as annual, apply nDelta/fatigue, then crop and tilled stay, `plantedAt = T`, rate recomputed (no drink). Result = units taken. Other tiles: 0 |
| deposit | 5 | | 1 | 0 unless on the barn; items 1..7 move to barn stock (compost stays carried); result = units moved |
| deliver | 6 | a = order id | 2 | 0 unless on the barn, order open, stock[crop] >= qty; then stock -= qty, coins += reward, order removed; result = reward |
| wait | 7 | a = n 1..1000 | n | result 1 |
| sell | 8 | a = item 1..7, b = units >= 1 | 1 | 0 unless on the barn and stock[a] >= b; then stock -= b, coins += b * price; result = coins gained |
| buyPlot | 9 | a = px, b = py; bot = -1 | 0 | 0 if owned, not edge-adjacent to an owned plot, or coins < `plotCost`; else pay and append the plot; result 1 |
| buyBot | 10 | bot = -1 | 0 | 0 if coins < `botCost`; else pay, append a bot at `(0, 0)` with `busyUntil = tick`; result = new bot index + 1 |
| build | 11 | a = kind 1..2 | 4 | 0 unless kind unlocked, coins >= price, not barn, not tilled, no crop, no building; else pay (`spent += price`), building = a, built = tick, result 1 |
| clear | 12 | | 3 | 0 on the barn or if the tile has no crop, no building and is not tilled; else crop, plantedAt, rate, tilled, building, built = 0, result 1 (no refund, no yield) |
| compost | 13 | | 2 | 0 unless the tile is a composter; `p` = sum of load[1..6]; `made = floor(p / 4)`; remove `4 * made` units taking from item 1 upward; `load[8] += made`; result = made |
| fertilize | 14 | | 2 | 0 on the barn, on a building, or if load[8] < 1; else load[8] -= 1, `nitrogen = min(100, n + 25)`, `fatigue = max(0, f - 20)`, result 1 |
| unlock | 15 | a = bit 0..8; bot = -1 | 0 | 0 if already unlocked or coins < price; else pay (`spent += price`), set bit, result 1 |

`plotCost = 150 * n * n` where `n` = plots owned now. `botCost = 80 * m * m` where `m` = bots owned now.
`spent` accumulates every coin paid for plots, bots, buildings and research.

Illegal (throw `IllegalAction`; the whole chunk is rejected): `t` not an integer or not equal to the world
tick; bot index out of range (or not -1 for ops 9, 10, 15; or -1 for other ops); bot busy; unknown op; any
required arg missing, non-integer or out of range.

## Tick
`tickWorld(world)`: `tick++`, then the order generation above. Nothing else. All tile changes are lazy.

## Net worth (the ranked number)
`netWorth = coins + spent + sum(stock[i] * price(i) for i in 1..7)`.

## Daily challenge
`dailySeed(date: 'YYYY-MM-DD')` = FNV-1a 32-bit over the UTF-8 bytes of `tendril-daily:` + date, 0 -> 1.
Farm id `daily-` + date, `DAILY_TICKS = 3000`. Score = `netWorth` at tick 3000 from `createWorld` (no setup).

## Hash and checkpoint
- `hashWorld(world)`: FNV-1a 32-bit over, in order: tick, coins, spent, unlocks, orng, nextOrderAt, nextOrderId,
  stock[1..7], each weather segment with `start <= tick` (kind, start, end; `wrng` itself is NOT hashed), each order
  (id, crop, qty, reward, opensAt, deadline), each bot (x, y, busyUntil, load[1..8]), each plot (px, py, all 10 tile ints).
  Each int is mixed as 8 bytes (low 32 bits then high 32 bits, little-endian). Result: 8 hex chars.
- `serialize(world): string` (JSON, includes `rulesVersion: 3`) and `deserialize(s): World` round-trip exactly;
  `deserialize` rejects any other rulesVersion.

## Public API of `@tendril/sim` (exact names; all exported from `src/index.ts`)
```ts
createWorld(farm: Farm, setup?: Setup): World
applyAction(world: World, e: LogEntry): number            // throws IllegalAction
tickWorld(world: World): void
replayChunk(world: World, actions: LogEntry[], toTick: number): void  // mutates; throws IllegalAction; ends with world.tick === toTick
hashWorld(world: World): string
netWorth(world: World): number
serialize(world: World): string;  deserialize(s: string): World
snapshot(world: World): Snapshot                          // settles a copy of every owned tile to world.tick; does not mutate world
// free queries (never logged, must not mutate hashed state; settle on a copy)
scan(world, bot): ScanResult;  scanAt(world, x, y): ScanResult | null (null when unowned)
forecast(world, n): { kind: 'rain'|'frost'; start: number; end: number }[]   // segments overlapping [tick, tick+n)
weatherAt(world, tick): 'clear'|'rain'|'frost'
openOrders(world): Order[]
plotCost(world): number;  botCost(world): number;  capacity(world): number
isUnlocked(world, bit): boolean;  dailySeed(date): number
CROPS, ITEMS, BUILDINGS, UNLOCKS, OPS, OP, COST, DAILY_TICKS, RULES_VERSION = 3
type LogEntry = [t: number, bot: number, op: number, a?: number, b?: number]
interface ScanResult { tilled; crop; stage; moisture; nitrogen; fatigue; barn: boolean; building; honey }
```
`ITEMS[i] = { name, price }` for i 1..8; `BUILDINGS[k] = { name, price }` for k 1..2;
`UNLOCKS[bit] = { name, price }` for bit 0..8. `forecast`/`weatherAt` may extend the generated weather
schedule (a pure function of the seed); the hash therefore only includes segments with `start <= tick`.
```ts
interface Snapshot {
  tick: number; coins: number; netWorth: number; weather: 'clear'|'rain'|'frost';
  unlocks: number; capacity: number;
  plots: { px: number; py: number }[];
  tiles: { x: number; y: number; tilled: number; crop: number; stage: number; moisture: number; nitrogen: number;
           fatigue: number; building: number; honey: number }[];
  bots: { x: number; y: number; busyUntil: number; load: number; items: number[] /* length 9 */; op: number | null }[];
  stock: number[] /* length 8 */; orders: Order[]; plotCost: number; botCost: number;
}
```
`World` keeps `lastOp: (number | null)[]` per bot for the snapshot only; it is not hashed but is serialized.
