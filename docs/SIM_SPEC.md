# Tendril simulation spec (rules version 3: endless farm, research, perennials, buildings)

> A rules version 4 DRAFT (shared daily market) is appended at the end. It is a proposal, not implemented; version 3 below is what the code does.

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

## Appendix: Arena helpers (`packages/sim/src/arena.ts`)
Pure helpers shared by the server and clients. They add no rules and do not change `RULES_VERSION` (3) or any hash.

- `DAILY_EPOCH = '2026-12-01'`; `dailyNumber(date)` = UTC days since the epoch + 1 (epoch day is 1). `date` is a real `YYYY-MM-DD`, else it throws.
- `DAILY_PAR = 290`: net worth at tick 3000 that the bundled `daily.sprout` reaches or beats on 96 of the 100 daily seeds from the epoch (`dailySeed` of 2026-12-01 .. 2027-03-10; observed range 286..352).
- `farmMosaic(world)`: 64 characters for plot (0,0), row by row (y, then x). `B` barn tile (0,0), `h` hive, `c` composter, `1`..`6` crop id (settled state, so a crop killed by frost shows as empty), `t` tilled and empty, `0` untilled. Read-only.
- `replayWithPar(world, actions, toTick, par)`: same validation and end state as `replayChunk`, returns `{ netWorth, parTick, mosaic }`. `parTick` is the first `world.tick` at which `netWorth >= par`, checked at the start, after every applied action and after every tick (so a sale at tick t counts as t); `null` if never reached. Throws `IllegalAction` on a bad log or non-integer `par`.
- `challengeSetup(kind, seed)` with `kind` `'daily' | 'season' | 'duel'` returns `{ ticks, setup }`, currently `{ ticks: DAILY_TICKS, setup: {} }` for every kind. Servers must create challenge worlds through it.

## Rules version 4 (DRAFT rev 3, proposed by E1a, not implemented): shared daily market

Nothing below changes the code until E1b. Version 3 above stays exact. Version 4 is version 3 plus one optional
input, `prices`; a world without `prices` plays exactly as version 3 (same actions, results and hashes).
Decisions (coordinator, Fable's review): band 50..200%, daily move cap 25 points of base price, minimum 10 players,
scale-free shares against a blended target share, 3:2:1 smoothing over three days, floor rounding, dailies only.

### 4.1 Prices become an input
```ts
interface Setup { coins?: number; unlocks?: number; weatherBias?: number; prices?: number[] }
// prices: length 8; index 1..7 = price of that item in centicoins (1/100 coin); index 0 and 8 are 0
```
- `createWorld` stores `world.prices` only when `setup.prices` is given. Items 1..7 must be integers
  `1 <= p <= 100000`, else it throws. The server only passes tables inside the bounds of 4.2.
- `price(w, i)` = `w.prices ? w.prices[i] : ITEMS[i].price * 100` (centicoins). Compost is always 0.
- **sell** gain = `floor(b * price(w, a) / 100)` coins (v3: `b * price`, identical without prices). Floor rounding, no
  1-coin minimum: a sale may pay 0 coins; it is legal and the stock is still removed.
- **netWorth** stock term = `sum over i in 1..7 of floor(stock[i] * price(w, i) / 100)`, so net worth uses the day's
  prices on client and server. Selling the whole stock at once equals its valuation; selling in pieces never gains.
- **Orders do not change.** `reward = qty * CROPS[crop].price * 2 + 10` always uses the base price. Document it in
  the player docs as the hedge: orders pay a fixed, predictable price while the market moves.
- **Sprout**: free query `price(item)` returns the day's price of item 1..7 in centicoins (an integer; base carrot is 200).
  Like `scan`, it is never logged, costs no ticks and does not mutate state. Out-of-range item is a script error.
- **hashWorld**: when `w.prices` exists, mix `prices[1..7]` (8 bytes each) right after `stock[1..7]`; when absent nothing
  is added, so every v3 hash is unchanged. `serialize` writes `rulesVersion: 3` without prices and `4` with them;
  `deserialize` accepts 3 and 4 and rejects anything else.
- `RULES_VERSION = 4` (new challenges), `SUPPORTED_RULES_VERSIONS = [3, 4]`. Dispatch is by data: a v3 challenge
  row has no table, so its world has no `prices`. The server rejects an entry whose `rulesVersion` differs from the
  row (existing 409) and refuses a v4 row without a table or a v3 row with one.
- **Par** is computed under the day's table: the reference script runs on the v4 world, and `parFromReference` takes
  its net worth, exactly as F1 does for modifiers (same fallback to `DAILY_PAR` if the check fails). The verify
  function therefore receives the table.

### 4.2 The day's table (pure helpers in `arena.ts`; they add no rules)
`m` = per-item multipliers in permille of base, items 1..7 (1000 = base price).

Constants (`MARKET`): `LO = 500`, `HI = 2000` (the 50%..200% band), `STEP = 250` (25 points of base per day),
`MIN_PLAYERS = 10`, `SMOOTH = [3, 2, 1]`, and `BASE_SHARE = [_, 194, 129, 388, 65, 97, 78, 49]` (permille of units sold: carrot, wheat, clover, pumpkin, berry, apple,
honey), the equal-revenue split: each item's share is proportional to `1 / base price` (60:40:120:20:30:24:15 out of
309), so it needs no guessed volumes. It sums to 1000. Fixed forever for version 4; changing it needs version 5.
`WINDOW = 14`, `MIN_VALID = 7`. The smoothing weights apply newest first.

Day `D` reads the entries of day `D-1`: for every player who has an entry on that challenge with a stored `sold`
vector, the single entry with the highest net worth (ties: earlier). Players whose total units sold is 0 are not counted.
`N` = players counted. For player `p`, `u[p][c]` = units of item `c` sold, `U[p]` = their total.

Observed share (stored on the day's row as `sh`; null when `N < MIN_PLAYERS`), integers only:
```
sh[c] = floor( sum over counted players of floor(1000 * u[p][c] / U[p]) / N )     // each player counts equally, whatever their volume
```
Blended target share: take the `sh` of the last `WINDOW` challenge rows up to and including day `D` (14 row reads; a
missing row or a null `sh` is skipped). With `V` valid rows:
```
if V < MIN_VALID:  tgt[c] = BASE_SHARE[c]
else:              trail  = floor( sum of sh[c] over the valid rows / V )
                   tgt[c] = max(1, floor( (BASE_SHARE[c] + trail) / 2 ))          // half fixed, half what the crowd really sells
```
Raw target (stored on the day's row as `t`):
```
if N < MIN_PLAYERS:   t[c] = 1000 for all c                         // not enough data: neutral
else:  rho = floor(1000 * sh[c] / tgt[c])                          // 1000 = sold exactly its target share
       t[c] = clamp(floor(2000000 / (1000 + rho)), LO, HI)         // rho 0 -> 2000, 1000 -> 1000, 3000+ -> 500
```
Each player contributes only their own mix, so no account can swing the market by volume (scale-free; there is no
cap constant). Then smooth over the raw targets of day `D` (`t`), `D-1` and `D-2` (a missing row or a day below
`MIN_PLAYERS` counts as 1000) and step from yesterday's table `prev` (base table 1000 x 7 when none):
```
avg  = floor( (3*t_D[c] + 2*t_(D-1)[c] + 1*t_(D-2)[c]) / 6 )
m[c] = prev[c] + clamp(avg - prev[c], -STEP, +STEP)
price[c] (centicoins) = floor(ITEMS[c].price * m[c] / 10)
```
Guarantees: `LO <= m <= HI` always (a clamped step from inside the band toward a target inside it stays inside);
`|m - prev| <= 250`; no float; every intermediate is below 2^31 for any N. The lazy read touches at most 13 earlier rows (the share window; the smoothing needs the last two `t`).

### 4.3 Storage and lazy computation
- `challenges.market` (nullable JSON, E1b migration): `{ m, p, t, sh, n, from }`: multipliers, centicoin table used by the
  world, raw target, observed shares (null if too few players), players counted, and the id of the previous challenge it was derived from (null for none). Null on
  v3 rows and on challenges without a market.
- Computed on the first request that creates or loads that day's row (same moment as today), never by a scheduled job.
  A missing earlier row means neutral targets, no share and the base `prev`. Stored with
  `UPDATE challenges SET market = ? WHERE id = ? AND market IS NULL`; the loser re-reads, so everyone sees one table.
  After it is stored the table never changes, so grace-period entries for `D-1` cannot rewrite it.
- Dailies only. Seasons stay v3. A duel created from a daily copies that daily's version and table (like F1
  modifiers); other duels are v3.
- API: `GET /challenges/:id` gains `market: { prices: number[] /* centicoins, 1..7 */, multipliers: number[], shares: number[] /* yesterday's shares, permille, or null */ } | null`. `challengeSetup(kind, seed, setupVersion, market?)`
  adds `prices` to the setup; client, server and verify function all build worlds through it.

### 4.4 What the server records
- `replayStats(world, actions, toTick)` (sim, read-only helper next to `replayWithPar`) returns `sold: number[8]`: for
  every sell action, `b` units are added to `sold[a]` when `stock[a]` fell by `b` (a legal sale can pay 0 coins, so the
  stock is checked). Order deliveries do not count. It runs for every submission on every version.
- `entries.sold` (nullable JSON, 7 ints), written at submit. Rows without it are ignored by the table.

### 4.5 Rollout: MARKET_EPOCH
`MARKET_EPOCH = '2026-12-08'` (sim constant). A daily dated before it is created as v3 with no table (base prices,
today's behavior). A daily dated on or after it is created as v4. The epoch day has no earlier v4 row, so its table is
the base table (`t` neutral, `n` = 0 even if the day before had entries). The day after is the first derived table; it
needs 10 players on the epoch day, else it stays neutral. Everything before the epoch stays replayable as v3.
- The daily winner bot announces the opening on that date (E1c).
- Game and site show "Market opens in N days" before the epoch, then today's prices and yesterday's shares.
  The Season 0 page mentions that the market opens on 8 December (E1c).

### 4.6 Version compatibility
- Client: the challenge info carries `rulesVersion`. A client that does not support it (not in
  `SUPPORTED_RULES_VERSIONS`) refuses to play or submit and shows "This day needs a newer Tendril. Update the app."
- Desktop 0.1.x and the legacy `/api/daily` alias: on a v4 day `GET /daily` returns `rulesVersion: 4`, and the
  old submit (which sends 3) gets the existing 409 mismatch with the message "This day uses rules version 4. Update
  Tendril." E1b must test that the 0.1.x paths fail with that error and never write a score. Closes with `LEGACY_GRACE_MS = 0`.

### 4.7 Simulated month (`brain/notes/E1a-market-sim.mjs`; seeded; `SMOOTH=0` shows it unsmoothed, `TRAIL_NUM/TRAIL_DEN` change the trailing weight)
Player model: each player splits their volume across the seven items in proportion to `BASE_SHARE[c] * (m[c]/1000)^k`
with per-player noise; k = 3 normally, 8 for herding; (a) and (b) use a fixed crowd mix instead. "Reversals" = direction
changes of an item's multiplier over days 10..30 (7 items, 147 possible); "swing" = max minus min over days 10..30 (worst item).

| scenario | min | max | max daily move | swing |
|---|---|---|---|---|
| A steady 200 players | 98.9% | 101.5% | 2.2 pts | 2.2 pts |
| B growth 8 to 3000 players | 97.5% | 103.1% | 4.2 | 2.4 |
| C 30 of 200 sell only wheat | 76.1% | 106.9% | 16.9 | 2.3 |
| D 10 of 50 sell only carrots | 79.9% | 109.8% | 14.9 | 5.8 |
| E 200, then 10 dormant days, then 6, then 12 players | 98.0% | 105.1% | 5.6 | 6.7 |
| F herding (k = 8), accepted as intended | 91.6% | 127.9% | 25.0 | 34.4 |
| G everyone sells only carrots (pre-blend run; kept as the extreme rail case) | 50.0% | 200.0% | 25.0 | 0 |
| H everyone sells only honey 12 days, then normal | 50.0% | 200.0% | 25.0 | 117 (regime change) |
| (a) 90% of volume is carrot, 30 days | 50.0% (days 3-6 only) | 188.5% | 25.0 | 1.8 |
| (b) crowd 90% carrot, 90% wheat from day 15 (45 days) | 50.0% | 190.7% | 25.0 | regime change |

- **(a)** carrot is pinned at the floor only while fewer than 7 valid days exist (days 3 to 6); from day 7 the trailing half
  of the target takes over and carrot settles at **75.4%** of base, wheat 169%, the rest 165..179%, steady to the end. The
  half-weight blend is enough; the trailing weight stays 1/2 (no change to 2/3).
- **(b)** the response starts on day 15 itself and moves the 25-point cap every day: carrot 75 to 100 to 125 to 150 to 175
  on days 15..18 while wheat falls 144, 119, 94, 69; at day 20 carrot peaks at 189.9% and wheat bottoms at 50.0%. It
  re-centres as the trailing mean catches up: carrot 169.5% and wheat 72.1% by day 29 (14 days after the shift) and flat
  at 168.7% / 72.6% from day 35 (it does not return to 100%, since half the target stays fixed).
- Without smoothing A..D swing 25..28 points with a reversal almost every day; with 3:2:1 the swing is about 2 points.
  The blended target does not oscillate in A..E, (a) or (b). The band is never left.
- **F still oscillates and this is accepted as intended behaviour** (a crowd that follows price harder than volume ~ ratio^6:
  k <= 5 swing <= 3.1 pts, k = 6 10.8 pts, k = 8 34.4 pts, k = 12 about 38 pts). The 25-point cap and three-day smoothing
  stay as specified; there is no fourth smoothing day.

### 4.8 Tests E1b must add
v3 goldens untouched; base-price rounding cases; the blended target (fewer than 7 valid days uses `BASE_SHARE`; null shares skipped; window of 14 rows); property test (10,000 random inputs keep `m` in [500, 2000], moves
<= 250, N < 10 neutral, a whale cannot move shares beyond one player's weight); serialize round trip with and
without prices; CAS race returns one table; epoch tests for the day before (v3, no table), the epoch day (v4, base
table), the day after with 10+ players (derived) and with fewer than 10 (neutral); v3 row replays after migration;
0.1.x fails cleanly on a v4 day; `challengeSetup` identical on server, client and verify; `price(item)` in Sprout.
