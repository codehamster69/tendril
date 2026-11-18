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
`building` tile field: `0 none, 1 hive, 2 composter, 3 silo` (silo: rules v5 only, section 5). Coin prices: hive 120, composter 80 (fixed, added to `spent`); silo `siloCost` (section 5.2).
- **Hive honey:** `honeyAt(T) = min(6, floor((T - built) / 400))`.
- **Pollination:** when a mature crop is harvested, `h` = number of the 4 orthogonal neighbour tiles that are
  owned and have `building == 1`. Final units `u = base + (base * 25 * h / 100 | 0)` where
  `base = max(1, yield * (100 - fatigue) / 100 | 0)`.

## Research (unlocks)
`unlocks` is a bitmask on the world; a new farm has `unlocks = 1` (carrot). Bit id, name, coin price:
`0 carrot 0, 1 wheat 40, 2 clover 60, 3 pumpkin 250, 4 berry 400, 5 apple 900, 6 hive 300, 7 composter 200, 8 satchel 500, 9 silo 1200`.
Bit 9 (silo) can be bought only while silo rules are active (section 5); before that `unlock 9` results 0.
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
| deposit | 5 | | 1 | 0 unless on the barn or a silo (v5); items 1..7 move to barn stock (compost stays carried); result = units moved |
| deliver | 6 | a = order id | 2 | 0 unless on the barn, order open, stock[crop] >= qty; then stock -= qty, coins += reward, order removed; result = reward |
| wait | 7 | a = n 1..1000 | n | result 1 |
| sell | 8 | a = item 1..7, b = units >= 1 | 1 | 0 unless on the barn or a silo (v5) and stock[a] >= b; then stock -= b, coins += b * price; result = coins gained |
| buyPlot | 9 | a = px, b = py; bot = -1 | 0 | 0 if owned, not edge-adjacent to an owned plot, or coins < `plotCost`; else pay and append the plot; result 1 |
| buyBot | 10 | bot = -1 | 0 | 0 if coins < `botCost`; else pay, append a bot at `(0, 0)` with `busyUntil = tick`; result = new bot index + 1 |
| build | 11 | a = kind 1..3 | 4 | Silo (3): 0 unless silo rules are active (section 5), and its price is `siloCost`. 0 unless kind unlocked, coins >= price, not barn, not tilled, no crop, no building; else pay (`spent += price`), building = a, built = tick, result 1 |
| clear | 12 | | 3 | 0 on the barn or if the tile has no crop, no building and is not tilled; else crop, plantedAt, rate, tilled, building, built = 0, result 1 (no refund, no yield; a silo pays half back, section 5.3) |
| compost | 13 | | 2 | 0 unless the tile is a composter; `p` = sum of load[1..6]; `made = floor(p / 4)`; remove `4 * made` units taking from item 1 upward; `load[8] += made`; result = made |
| fertilize | 14 | | 2 | 0 on the barn, on a building, or if load[8] < 1; else load[8] -= 1, `nitrogen = min(100, n + 25)`, `fatigue = max(0, f - 20)`, result 1 |
| unlock | 15 | a = bit 0..9; bot = -1 | 0 | bit 9: 0 unless silo rules are active; 0 if already unlocked or coins < price; else pay (`spent += price`), set bit, result 1 |
| sellPlot | 16 | a = px, b = py; bot = -1 | 0 | Rules v5, section 5.4. 0 unless silo rules are active and the plot may be sold; else result = coins paid back |

`plotCost = 150 * n * n` where `n` = plots owned now. `botCost = 80 * m * m` where `m` = bots owned now.
`spent` accumulates every coin paid for plots, bots, buildings and research.

Illegal (throw `IllegalAction`; the whole chunk is rejected): `t` not an integer or not equal to the world
tick; bot index out of range (or not -1 for ops 9, 10, 15, 16; or -1 for other ops); bot busy; unknown op; any
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
- `challengeSetup(kind, seed, version = SETUP_VERSION)` with `kind` `'daily' | 'season' | 'duel'` returns `{ ticks, setup, modifiers }`. Servers and clients must create challenge worlds through it, passing the setup version stored with the challenge (`setupVersion` in the API, `setup_v` in the database).
  - Version `0` (`SETUP_LEGACY`): every challenge created before modifiers. `{ ticks: DAILY_TICKS (SEASON_TICKS for seasons), setup: {}, modifiers: null }`, so old entries replay exactly as before.
  - Version `1` (`SETUP_VERSION`): the day's modifiers, drawn from the seed (below). New challenges are written with version 1.

### Challenge modifiers (setup version 1)
These add no rules and do not change `RULES_VERSION` (3) or any golden hash: they are `createWorld` setup values, plus one optional setup field, `weatherBias`, that is absent (and changes nothing) on every other world. Draws use xorshift32 seeded with `(seed ^ 0xC0DE5EED) >>> 0` (0 -> 1); each draw advances the state and takes `(state >>> 8) % n`. Order and bounds (`MODIFIER_BOUNDS`):

| # | Modifier | Draw | Values | Effect |
|---|---|---|---|---|
| 1 | starting coins | `% 7` | 0, 10, 20, 30, 40, 50, 60 | `setup.coins` (omitted when 0) |
| 2 | starting research | `% 3` | none, wheat (bit 1), clover (bit 2) | `setup.unlocks = 1 \| bit` (omitted for none) |
| 3 | weather bias | `% 3` | -1 frosty, 0 standard, 1 calm | `setup.weatherBias` (omitted when 0) |
| 4 | tick budget | `% 3` | 2400, 3000, 3600 | `ticks` (seasons always `SEASON_TICKS`; duels use the daily draw unless the creator gives a length) |

- `weatherBias` (-1, 0, 1; anything else throws) only changes which weather segments are frost. The segment timings and lengths consume the same random draws. Standard: frost when `wrng % 4 === 0`. Bias -1: `wrng % 2 === 0` (about half of segments, a superset of the standard frosts). Bias 1: `wrng % 8 === 0` (about one in eight, a subset). `serialize` writes `weatherBias` only when non-zero and `deserialize` restores it.
- Kinds share the draw: a duel made from a daily's seed gets that daily's coins, research and weather.
- `describeModifiers(modifiers, kind)` gives the labels shown in the game header, the CLI and on the site (e.g. `30 starting coins`, `wheat researched`, `frosty weather`, `2,400 ticks`).
- Par: when a challenge with setup version 1 is created, the server asks the verify function to run the bundled reference program (a copy of `packages/lang/examples/daily.sprout`) on that exact world and sets `par = max(PAR_MIN, floor(netWorth * PAR_PERCENT / 100))` with `PAR_PERCENT = 90`, `PAR_MIN = 60`. The reference therefore reaches par every day (a 365-day test checks it; its net worth ranges 238 to 404, so par 214 to 363). If the check cannot be made, par falls back to `DAILY_PAR` (290), and it is never recomputed for an existing challenge. Version 0 challenges keep their stored par.

## Rules version 4 (rev 3, implemented by E1b): shared daily market

Implemented in E1b (`packages/sim/src/arena.ts`, `packages/server/src/market.ts`). Version 3 above stays exact. Version 4 is version 3 plus one optional
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

**Implementation notes (E1b).**
- `price(w, i)` and `createWorld(..., { prices })` are in `world.ts`; `prices` is checked (length 8, items 1..7 integers 1..100000) and copied. `deserialize` accepts 3 (no table) and 4 (table required) only.
- `RULES_VERSION = 4` is the newest version; `BASE_RULES_VERSION = 3` is what endless farms, seasons, duels not made from a market daily and dailies before `MARKET_EPOCH` use. The server compares a submission with the version stored on the row (never with the constant); on a mismatch where the row is newer the answer is 409 "This day uses rules version N. Update Tendril." and nothing is replayed or written.
- Sprout `price(item)` returns the day's centicoin price on a market world and the base price in whole coins elsewhere (a v3 world keeps its old answer, so old programs verify exactly as before). Compost is a script error.
- `replayWithPar` now also returns `sold` (length 8); `replayStats` is the thin helper over it. The server writes `entries.sold` (7 integers) on every submit.
- `challengeSetup(kind, seed, version, market?)` takes `{ p }` and adds `prices`; a season refuses a market. Everything that builds a challenge world (server replay, verify function, client, CLI, replay viewer) passes the stored table.
- Verify function request: `rulesVersion` + `market` (`{ p, ... }`, validated with `isMarketTable`); v4 without a table and v3 with one are refused with reason `rules`.
- API: `GET /challenges/:id` and `GET /entries/:id` (challenge) and `/entries/:id/replay` carry `market: { prices, multipliers, shares } | null`. `POST /duels` accepts `from: 'd-YYYY-MM-DD'` (same seed, a daily): the duel copies that daily's version and table.
- Pure helpers exported from `@tendril/sim`: `MARKET`, `MARKET_EPOCH`, `marketActive`, `dailyRulesVersion`, `daysUntilMarket`, `baseMarket`, `marketPrices`, `observedShares`, `blendedTarget`, `rawTarget`, `nextMultipliers`, `nextMarket`, `isMarketTable`.

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

## Rules version 5 (L1, 2026-11-17): silos and sellPlot

Why: one barn at (0,0), moves cost 2 ticks, bots carry 20 (30). On big farms bots spend most ticks walking to the barn.
A silo is a second barn the player places. `sellPlot` is the undo for a plot bought in the wrong place.

### 5.1 The switch: `World.siloTick` (dispatch by data, like the v4 table)
- `World.siloTick?: number`. Absent: none of section 5 exists and the world plays exactly as v3/v4. Present: silo rules are
  **active** at tick `T` iff `T >= siloTick` (`silosActive(w)`).
- While not active, silo research (`unlock 9`), `build 3` and `sellPlot` are legal and result 0 with no other effect (the bot
  still spends the op's ticks). This holds for worlds without `siloTick` too, so a new client can send them on any day.
- `siloTick` is **not** mixed into `hashWorld` (everything a silo or a sale changes is: tiles, plots, coins, spent). This is what
  lets Endless farms carry it without changing any hash an older client computes.
- `serialize` writes `rulesVersion: 5` and `siloTick` when present (the table too when present); `deserialize` accepts
  version 5 only with a valid `siloTick`, with or without a table. Versions 3 and 4 are unchanged.

### 5.2 Silos
- Building kind 3, placed with `build 3` on any owned tile that is not the barn, not tilled, has no crop and no building.
  Needs research bit 9 (`silo`, 1200 coins, after the satchel).
- `siloCount` = tiles with `building == 3`, counted over all plots. `siloCost = siloPrice(siloCount)` with
  `siloPrice(n) = SILO_BASE * (n + 1)^2`, `SILO_BASE = 500` (tuned from the brief's 300, section 5.7). Paid and added to `spent`.
- On a silo tile `deposit` and `sell` work exactly as on the barn, into and out of the one global `stock`.
  `deliver` stays barn-only: orders are the barn's contracts, and keeping one hand-in point keeps order logic and the order UI unchanged.
- Hives count neighbours by `building == 1` only; a silo is not a hive. Tilling, planting and fertilizing a silo tile fail as on any building.

### 5.3 Clearing a silo
`clear` on a silo: first `paid = siloPrice(siloCount - 1)` (the newest silo's price), `spent -= paid`,
`coins += floor(paid / 2)`; then the usual clear. Net worth drops by `paid - floor(paid / 2)`.

### 5.4 sellPlot `[t, -1, 16, px, py]`
Fails (0) unless all of: silo rules active; `(px, py)` owned and not `(0, 0)`; at least one of its 4 neighbour plots is not
owned (an edge plot); no bot stands on any of its tiles; and every other owned plot still reaches `(0, 0)` through owned plots
(4-neighbour, breadth first). Then, in order:
1. For each tile of the plot in tile order with `building == 3`: `siloCount -= 1`, `spent -= siloPrice(siloCount)` (no coins).
   Other buildings, crops and soil on the plot are lost with no refund.
2. `paid = plotPrice(plotsOwned - 1)` (the newest plot's price); `spent -= paid`; `coins += floor(paid / 2)`; result = `floor(paid / 2)`.
3. The plot is removed from `plots`; later plots move down one index in their order (`plotIndex` follows).
Orders already issued keep their `qty`; new orders use the new plot count. Buying the plot again gives fresh soil
(`addPlot` at the current tick). Every buy and sell loop loses coins and net worth (tested).

### 5.5 Rollout: `SILO_EPOCH = '2026-11-17'` (00:00 UTC)
Brought forward from 15 Dec by Rohan on 2026-11-17 (no players yet), so it now comes before MARKET_EPOCH.
- Dailies dated from it: rules v5 (`dailyRulesVersion`). A v5 daily has the market table from MARKET_EPOCH on and none before.
  Seasons whose week starts on or after it: v5 without a table (`seasonRulesVersion`). Duels copy the version and table of
  the daily they come from; other duels created from the epoch on are v5 without a table. No new challenge is v4 any more.
- The table on v5 is dispatched by data: `marketAllowed(v, kind)` = `v == 4 || (v == 5 && kind != 'season')`;
  `marketFits(v, kind, has)` = v4 needs a table, v3 and seasons have none, other v5 challenges may have one. The server
  requires one on a daily that is v4, or v5 dated from MARKET_EPOCH.
- Challenges build their world with `challengeSetup(kind, seed, setupVersion, market, rulesVersion)`, which sets `siloTick = 0`
  for v5. Server replay, the verify function, the CLI and the client all pass the stored version.
- Endless farms keep their stored `rules_version` (3) and checkpoint format. Their switch is `endlessSiloTick(startedAtMs) = 0`:
  silos and `sellPlot` work from the first tick. (It was the first tick at or after the epoch by wall clock, which left farms with rested
  time switched off for days, because a farm's tick lags the wall clock by `restedMs`.)
  Server and client call `withEndlessSilos(world, startedAtMs)` on every Endless world they load and delete `siloTick` before
  storing a checkpoint, so stored checkpoints stay version 3 and older desktop builds keep loading and syncing them. An older
  build cannot produce the new ops, and without them both rule sets give the same result. `GET /farms/:id/replay` returns `siloTick`.
- Local sandbox farms use the same start-time rule.

### 5.6 Snapshot and view
Tiles already carry `building`. Snapshots of v5 worlds add `siloCost` and `plotRefund` (what `sellPlot` pays now); older
worlds' snapshots are unchanged. The compact view carries them in its scalars, and resends every plot when a plot is
removed, since a plot index then names different land.

### 5.7 Tuning (`node --experimental-strip-types packages/sim/scripts/silo-tuning.ts`)
Same simple program on every farm (bots walk their share of the tiles, harvest wheat, replant, unload at the nearest store),
square farms with the barn in a corner, bots = plots / 2. Coins per 1000 ticks over ticks 3000..13000. With `SILO_BASE = 500` and research 1200:
the first silo on a 9-plot farm pays back silo plus research in about 1800 ticks; on 4 plots about 3900; a silo on every plot never pays back
in any sensible time (73k ticks on 9 plots, 690k on 36). The full table is in `brain/notes/L1-silos.md`.


## 6. Daily briefs (K1, 2026-11-17): goals, twists, hidden farms, scoring
A **brief** replaces "make the most money" with one goal and 0-2 twists drawn from the challenge seed. Everything here is an optional input: a world without these `Setup` fields plays exactly as before, no hash changes, and `RULES_VERSION` stays 5. Code: `packages/sim/src/brief.ts` (draw), `arena.ts` (`challengeSetup`, `replayWithGoal`, `finalOf`), `start.ts` (inherited farm, hive).

### 6.1 Switch and version
- `BRIEF_EPOCH = '2026-11-18'` (live). `briefActive(date)`: dailies dated on or after it, seasons starting on or after it. `setupVersionFor(date)` = `SETUP_BRIEF` (2) from the epoch, else `SETUP_VERSION` (1).
- Setup version 2 is stored per challenge (`setup_v`); versions 0 and 1 are unchanged and carry no `brief`. Dispatch by stored data only, never by "now".
- `challengeSetup(kind, seed, 2, market, rulesVersion, source?)` returns `{ ticks, setup, modifiers: null, brief }`. `source` ('daily' | 'season') only matters for a duel: it copies the brief of the challenge it was made from, so use the source's kind and seed. `setup.prices` is the market table, or for a specialist day the table (or base price) times the multiplier; `siloTick = 0` is set for rules v5 as before.
- `HIDDEN_FARMS = { daily: 2, season: 4, duel: 0 }`. A hidden farm is the same `setup` with another world seed: `createWorld({ id, seed: siblingSeed }, setup)`. The brief, caps, quotas and starting land are identical; soil patches, weather, orders and the inherited farm's layout come from the world seed, so they differ.

### 6.2 The draw (`drawBrief`)
xorshift32 from `(seed ^ BRIEF_SALT) >>> 0` (`BRIEF_SALT = 0x7B21E5D1`, 0 -> 1), four warm-up steps, each draw `(state >>> 8) % n`. Order: goal (16) -> twist count (daily: 4, giving 0, 1, 1 or 2; season: always 2, no draw) -> twist picks (11 each, rejected picks still use a draw, at most 40 tries) -> twist values in catalogue order -> goal parameters.
- Goal weights out of 16: wealth 4; festival, specialist, orders, inherited 3 each.
- Budget: daily 3000 ticks, season 6000 (`SEASON_TICKS`), duel as its source.
- Twist rules: no repeats; `drought` clashes with `dry_soil` and with `hard_frost`; `land` is never drawn on an inherited farm; `research_given` and `research_locked` never name the same research; a locked research is never one the goal needs (festival items, specialist favoured item).

| Twist | Value | Setup field | Effect |
|---|---|---|---|
| `land` | n = 1..3 extra plots | `plots` (flat px,py) | a chain of n plots from the barn plot, each next to the one before (straight, left or right turns) |
| `poor_soil` | 15, 20, 25 | `poorSoil` | nitrogen minus value on 4x4 tile patches (a patch when `tileHash(seed ^ 0x50304F52, gx>>2, gy>>2) % 3 == 0`, `seed` = world seed), every plot incl. bought ones |
| `dry_soil` | 20, 30, 40 | `drySoil` | starting moisture minus value on patches (salt `0x44525959`) |
| `drought` | - | `weatherBias = 2` | every rain segment has length 0 (the draws are unchanged, so later segments shift in time); frost as standard |
| `hard_frost` | - | `weatherBias = -2` | frost 1 in 2 segments (as bias -1) and 100..199 ticks long |
| `bot_cap` | 1..3 | `maxBots` | `buyBot` returns 0 at that many bots (the start bot counts) |
| `plot_cap` | max(1..3, plots at start) | `maxPlots` | `buyPlot` returns 0 at that many plots |
| `research_given` | bit from 1,2,3,4,6,7,8 | `unlocks \|= 1 << bit` | already researched |
| `research_locked` | bit from 3..9 (not the given bit) | `lockedUnlocks` | `unlock` of that bit returns 0 (no coins spent, no ticks, as any refused farm op) |
| `stock` | 20, 40 or 60 units of one crop 1..5 (`item`) | `stock` | starting stock |
| `hive` | - | `hive = [x, y]`, x and y in 1..7 | a hive on that tile of the barn plot, built at tick 0 (no research needed) |
`weatherBias` now accepts -2, -1, 0, 1, 2. `serialize` writes `brief` (the world's `BriefState`) only when present; `deserialize` restores it.

### 6.3 Goals
| Goal | Setup | Score (6.5) |
|---|---|---|
| `wealth` | none | net worth |
| `festival` | `goal.quotas` | filled permille |
| `specialist` | `goal.favoured`, `goal.shunned`; `prices` | net worth under that day's prices |
| `orders` | `orderBoost = 1` | coins from deliveries |
| `inherited` | `inherited = 1`, `unlocks \|= 0b111`, `coins = 30` | net worth minus the start |
- **Festival**: daily 2 or 3 distinct items, season 3 or 4. Daily pool: carrot, wheat, clover, pumpkin, berry (+ honey only with the `hive` twist); season adds apple and honey (honey only if the hive research is not locked or a hive twist exists). Locked crops are removed. A quota is `QUOTA_UNIT[item] * (2 + draw(3)) / 2` (rounded down; 1x, 1.5x or 2x), times 2 on a season. `QUOTA_UNIT` = carrot 200, wheat 240, clover 80, pumpkin 100, berry 120, apple 144, honey 10. These are first values; K2 calibrates.
- **Specialist**: favoured is a crop 1..5 (1..6 on a season) that is not locked; shunned is any other crop 1..6. Prices: favoured x3.0, shunned x0.3 of the day's price (the market table when present, else base), floor, at least 1 centicoin.
- **Orders** (`World.brief.orderBoost`): the next order comes `300 + r % 500` ticks later (standard `800 + r % 1200`) and pays `qty * price * 3 + 10` (standard `* 2`). The draws are the same, so only arithmetic changes.
- **Inherited** (`inheritFarm`, stream `rand` from `seed ^ 0x1AE71D5A`): one extra plot at (1, 0). Every tile except the barn, on both plots, draws in order: kind (20), crop (3), age (2000), rate (2), moisture 20..60, nitrogen 5..25, fatigue 20..60. Nitrogen, fatigue and moisture are always set; kind < 7 stays untilled (35%), 7..11 is tilled and empty (25%), 12..19 is planted (40%) with carrot, wheat or clover, `planted = -(age % (2 * stageLen))` (a negative planted tick is how a crop is already growing at tick 0) and rate 1 or 2.

### 6.4 Caps and the goal live on the world
`World.brief` (`BriefState`: `goal`, `maxBots`, `maxPlots`, `lockedUnlocks`, `orderBoost`, `poorSoil`, `drySoil`) is not hashed: only its effects are. Sprout reads `goal`, caps and twists from it (K5). Start-only fields (`plots`, `stock`, `hive`, `inherited`) are not kept.

### 6.5 Scoring (`replayWithGoal(world, actions, toTick, goal, par)`)
Same validation as `replayChunk`; returns `{ score, parTick, netWorth, sold, deposited, orderCoins, mosaic }`. `goal` null is today's behaviour (score = net worth). `replayWithPar` is a wrapper with the same result as before.
- `deposited[i]`: the stock a `deposit` action really added (barn or silo), per item 1..7. `orderCoins`: sum of `deliver` results. `sold` as before.
- wealth and specialist: `netWorth`. orders: `orderCoins`. inherited: `netWorth - netWorth at the start of the replay`. festival: `floor(sum(min(deposited[i], quota[i])) * 1000 / sum(quota))`, 0..1000.
- `parTick`: first tick (tick 0, after every action, after every tick) at which the score is >= par. Festival and orders scores only grow; net worth scores can fall (selling a plot, clearing a silo), so they use "first time at par", never "last".
- `finalOf(scores, parTicks, budget, par)`: `finalScore = sum(scores)`; `finalParTick = sum(parTick ?? budget)` when `finalScore >= par * farms`, else null.
- `describeBrief(brief, kind)`: the village notice (`The village fair wants 300 wheat and 80 pumpkins by sundown.`; seasons say `by the end of the week`) and one short label per twist (`One bot only`, `Drought: no rain`, `Pumpkin research locked`, ...). `GOAL_TITLES` names the goals.

### 6.6 The reroll rule (K2)
A brief is only played if its reference program (one per goal, `packages/lang/examples/brief-<goal>.sprout`) clears a floor on the **visible** farm. `pickBrief(kind, seed, reference)` tries `rerollSeed(seed, 0..8)` in order (`rerollSeed(seed, 0) = seed`; n >= 1 is a murmur3-style mix of `seed ^ imul(n, 0x9E3779B1)`, never 0) and keeps the first draw whose reference score is at least `briefFloor(kind, goal)`; if all nine fall short it keeps the highest (the earliest on a tie). The whole brief is redrawn from the new seed, so the goal can change. The kept seed is stored as the challenge seed, so the visible farm uses it as its world seed. Hidden farm world seeds do not depend on it.
| Floor | wealth | festival (permille) | specialist | orders | inherited |
|---|---|---|---|---|---|
| daily | 300 | 250 | 250 | 250 | 600 |
| season | 500 | 250 | 800 | 500 | 2000 |
`MAX_REROLLS = 8`. Duels copy their source's brief and are never rerolled. Par is then 90% of the reference's mean over the visible and hidden farms (min 1), computed by K3. Numbers: `brain/notes/K2.md`.

### 6.7 What is not here
Seeds and salt (K3), the par calculation (K3, from the K2 reference programs), ratings (K4), the Sprout calls (K5), the client and site (K6, K7). Nothing reads `BRIEF_EPOCH` except `briefActive` and `setupVersionFor`.
