// Deterministic farm rules (rules version 3). Integers only.
import {
  BASE_CAPACITY, BUILDINGS, COMPOST, COST, CROP_COUNT, CROPS, FARM_OPS, HIVE, COMPOSTER, HONEY, HONEY_INTERVAL,
  HONEY_MAX, ITEMS, ITEM_COUNT, OP, OPS, PLOT_SIZE, TILE_INTS, SATCHEL_BIT, SATCHEL_CAPACITY, SILO, SILO_BIT, UNLOCKS, botPrice, plotPrice, siloPrice,
} from './rules.ts';
import { IllegalAction } from './types.ts';
import type { BriefState, Farm, Goal, LogEntry, Order, ScanResult, Setup, World } from './types.ts';
import {
  BUILDING, BUILT, CROP, FATIGUE, MOIST, NITRO, PLANTED, RATE, TILLED, addPlot, findPlot, honeyAt, plotKey,
  removePlot, settleInts, stageOf, tileOffset,
} from './tiles.ts';
import { rand } from './weather.ts';
import { inheritFarm, placeHive } from './start.ts';

export * from './types.ts';
export { forecast, weatherAt, rainTicks, frostTicks } from './weather.ts';
export { tileHash } from './tiles.ts';

const MAX = Number.MAX_SAFE_INTEGER;
/** Items 1..7 (crops and honey) have a market price; compost is worth nothing. */
const MAX_PRICED_ITEM = 7;
const MAX_PRICE = 100_000;
const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];

export function createWorld(farm: Farm, setup?: Setup): World {
  const seed = (farm.seed >>> 0) || 1;
  const w: World = {
    id: farm.id, seed, tick: 0, coins: 0, spent: 0, unlocks: 1,
    wrng: ((seed ^ 0xA5A5A5A5) >>> 0) || 1, orng: ((seed ^ 0x5EED5EED) >>> 0) || 1,
    nextOrderAt: 200, nextOrderId: 1, stock: new Array<number>(ITEM_COUNT).fill(0), weather: [], orders: [],
    bots: [{ x: 0, y: 0, busyUntil: 0, load: new Int32Array(ITEM_COUNT + 1) }],
    plots: [], plotIndex: new Map(), lastOp: [null],
  };
  if (setup) {
    if (setup.coins !== undefined) {
      if (!Number.isSafeInteger(setup.coins) || setup.coins < 0) throw new Error('bad setup coins');
      w.coins = setup.coins;
    }
    if (setup.unlocks !== undefined) {
      if (!Number.isSafeInteger(setup.unlocks) || setup.unlocks < 0 || setup.unlocks >= 1 << UNLOCKS.length) {
        throw new Error('bad setup unlocks');
      }
      w.unlocks = setup.unlocks | 1;
    }
    if (setup.weatherBias !== undefined) {
      if (![-2, -1, 0, 1, 2].includes(setup.weatherBias)) throw new Error('bad setup weatherBias');
      if (setup.weatherBias !== 0) w.weatherBias = setup.weatherBias;
    }
    if (setup.prices !== undefined) w.prices = checkedPrices(setup.prices);
    if (setup.siloTick !== undefined) {
      if (!Number.isSafeInteger(setup.siloTick) || setup.siloTick < 0) throw new Error('bad setup siloTick');
      w.siloTick = setup.siloTick;
    }
  }
  applyBriefSetup(w, setup ?? {});
  return w;
}

/** The Setup fields of daily briefs (SIM_SPEC section 6). Called by createWorld only when a setup is given; fields that are absent do nothing. */
function applyBriefSetup(w: World, setup: Setup): void {
  const st: BriefState = {};
  const int = (v: unknown, lo: number, hi: number, what: string): number => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < lo || v > hi) throw new Error(`bad setup ${what}`);
    return v;
  };
  if (setup.goal !== undefined) st.goal = checkedGoal(setup.goal);
  if (setup.maxBots !== undefined) st.maxBots = int(setup.maxBots, 1, 1000, 'maxBots');
  if (setup.maxPlots !== undefined) st.maxPlots = int(setup.maxPlots, 1, 1000, 'maxPlots');
  if (setup.lockedUnlocks !== undefined) st.lockedUnlocks = int(setup.lockedUnlocks, 0, (1 << UNLOCKS.length) - 1, 'lockedUnlocks');
  if (setup.orderBoost !== undefined) st.orderBoost = int(setup.orderBoost, 0, 1, 'orderBoost');
  if (setup.poorSoil !== undefined) st.poorSoil = int(setup.poorSoil, 0, 50, 'poorSoil');
  if (setup.drySoil !== undefined) st.drySoil = int(setup.drySoil, 0, 50, 'drySoil');
  if (st.goal?.quotas) st.deposited = new Array<number>(ITEM_COUNT).fill(0);
  for (const k of Object.keys(st) as (keyof BriefState)[]) if (!st[k]) delete st[k]; // zero means off
  if (Object.keys(st).length) w.brief = st;
  addPlot(w, 0, 0);
  if (setup.plots !== undefined) {
    const ps = setup.plots;
    if (!Array.isArray(ps) || ps.length % 2 !== 0 || ps.length > 16) throw new Error('bad setup plots');
    for (let i = 0; i < ps.length; i += 2) {
      const px = int(ps[i], -1000, 1000, 'plots'), py = int(ps[i + 1], -1000, 1000, 'plots');
      const adj = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => w.plotIndex.has(plotKey(px + dx!, py + dy!)));
      if (w.plotIndex.has(plotKey(px, py)) || !adj) throw new Error('bad setup plots');
      addPlot(w, px, py);
    }
  }
  if (setup.inherited) inheritFarm(w);
  if (setup.hive !== undefined) placeHive(w, setup.hive[0], setup.hive[1]);
  if (setup.stock !== undefined) {
    if (!Array.isArray(setup.stock) || setup.stock.length !== ITEM_COUNT) throw new Error('bad setup stock');
    for (let i = 1; i <= MAX_PRICED_ITEM; i++) w.stock[i] = int(setup.stock[i], 0, 100_000, 'stock');
  }
}

function checkedGoal(g: Goal): Goal {
  const kinds = ['wealth', 'festival', 'specialist', 'orders', 'inherited'];
  if (typeof g !== 'object' || g === null || !kinds.includes(g.kind) || !Number.isSafeInteger(g.budget) || g.budget < 1) throw new Error('bad setup goal');
  if (g.quotas !== undefined && (!Array.isArray(g.quotas) || g.quotas.length !== ITEM_COUNT || !g.quotas.every((q) => Number.isSafeInteger(q) && q >= 0))) throw new Error('bad setup goal');
  const item = (v: number | undefined): boolean => v === undefined || (Number.isSafeInteger(v) && v >= 1 && v <= MAX_PRICED_ITEM);
  if (!item(g.favoured) || !item(g.shunned)) throw new Error('bad setup goal');
  return g;
}

/** Centicoin price of an item in this world (1/100 coin): the day's table when there is one, else the base price. Compost and unknown items: 0. */
export function price(w: World, i: number): number {
  if (!Number.isInteger(i) || i < 1 || i > MAX_PRICED_ITEM) return 0;
  return w.prices ? w.prices[i]! : ITEMS[i]!.price * 100;
}

function checkedPrices(p: unknown): number[] {
  if (!Array.isArray(p) || p.length !== ITEM_COUNT) throw new Error('bad setup prices');
  const out = new Array<number>(ITEM_COUNT).fill(0);
  for (let i = 1; i <= MAX_PRICED_ITEM; i++) {
    const v = p[i];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > MAX_PRICE) throw new Error('bad setup prices');
    out[i] = v;
  }
  return out;
}

export function plotCost(w: World): number { return plotPrice(w.plots.length); }
/** Rules v5: silo rules apply at the world's current tick. */
export function silosActive(w: World): boolean { return w.siloTick !== undefined && w.tick >= w.siloTick; }
/** Silos standing on the farm (rules v5). Counted from the tiles, so it is never stored twice. */
export function siloCount(w: World): number {
  let n = 0;
  if (w.siloTick === undefined) return 0;
  for (const p of w.plots) for (let o = BUILDING; o < p.tiles.length; o += TILE_INTS) if (p.tiles[o] === SILO) n++;
  return n;
}
/** Price of the next silo: siloPrice(silos owned). */
export function siloCost(w: World): number { return siloPrice(siloCount(w)); }
/** Coins `sellPlot` pays now: half the price paid for the most recent plot (0 with only the barn plot). */
export function plotRefund(w: World): number { return w.plots.length > 1 ? Math.floor(plotPrice(w.plots.length - 1) / 2) : 0; }
/** Why the plot at (px, py) cannot be sold now (rules v5), or null when it can: owned, not the barn plot, on the edge, no bot on it, and the rest stays connected. */
export function sellPlotRefusal(w: World, px: number, py: number): string | null {
  const at = `Plot (${px}, ${py})`;
  if (!silosActive(w)) return 'Selling plots is not switched on for this farm yet.';
  if (px === 0 && py === 0) return 'The barn plot cannot be sold.';
  if (w.plotIndex.get(plotKey(px, py)) === undefined) return `${at} is not one of your plots. Use plots() to list yours.`;
  let edge = false;
  for (let d = 0; d < 4; d++) if (!w.plotIndex.has(plotKey(px + DX[d]!, py + DY[d]!))) edge = true;
  if (!edge) return `${at} is surrounded by your other plots. Only a plot with a free side can be sold.`;
  const onIt = w.bots.filter((b) => Math.floor(b.x / PLOT_SIZE) === px && Math.floor(b.y / PLOT_SIZE) === py).length;
  if (onIt > 0) return `${at} has ${onIt === 1 ? 'a bot' : `${onIt} bots`} on it. Move ${onIt === 1 ? 'it' : 'them'} off first.`;
  // Every other plot must still reach the barn plot through owned plots.
  const seen = new Set<string>([plotKey(0, 0)]);
  const queue: number[] = [0, 0];
  for (let q = 0; q < queue.length; q += 2) {
    for (let d = 0; d < 4; d++) {
      const nx = queue[q]! + DX[d]!, ny = queue[q + 1]! + DY[d]!;
      const k = plotKey(nx, ny);
      if ((nx === px && ny === py) || seen.has(k) || !w.plotIndex.has(k)) continue;
      seen.add(k); queue.push(nx, ny);
    }
  }
  return seen.size === w.plots.length - 1 ? null : `${at} connects other plots to the barn. Sell a plot at the end of a branch instead.`;
}
/** True when the plot at (px, py) may be sold now. */
export function canSellPlot(w: World, px: number, py: number): boolean { return sellPlotRefusal(w, px, py) === null; }
export function botCost(w: World): number { return botPrice(w.bots.length); }
export function isUnlocked(w: World, bit: number): boolean {
  return Number.isInteger(bit) && bit >= 0 && bit < UNLOCKS.length && (w.unlocks & (1 << bit)) !== 0;
}
export function capacity(w: World): number { return isUnlocked(w, SATCHEL_BIT) ? SATCHEL_CAPACITY : BASE_CAPACITY; }

export function netWorth(w: World): number {
  let n = w.coins + w.spent;
  for (let i = 1; i <= MAX_PRICED_ITEM; i++) n += Math.floor(w.stock[i]! * price(w, i) / 100);
  return n;
}

export function tickWorld(w: World): void {
  w.tick++;
  while (w.nextOrderAt <= w.tick) {
    const pool: number[] = [];
    for (let c = 1; c <= CROP_COUNT; c++) if (w.unlocks & (1 << (c - 1))) pool.push(c);
    w.orng = rand(w.orng); const crop = pool[w.orng % pool.length]!;
    w.orng = rand(w.orng); const qty = (5 + (w.orng % 16)) * w.plots.length;
    w.orng = rand(w.orng); const life = 1500 + (w.orng % 1500);
    const boost = w.brief?.orderBoost; // briefs (SIM_SPEC 6.3): same draws, richer and more frequent
    w.orders.push({
      id: w.nextOrderId++, crop, qty, reward: boost ? qty * CROPS[crop]!.price * 3 + 10 : qty * CROPS[crop]!.price * 2 + 10,
      opensAt: w.nextOrderAt, deadline: w.nextOrderAt + life,
    });
    w.orng = rand(w.orng); w.nextOrderAt += boost ? 300 + (w.orng % 500) : 800 + (w.orng % 1200);
  }
  const os = w.orders;
  for (let i = 0; i < os.length; i++) {
    if (os[i]!.deadline < w.tick) {
      let j = i;
      for (let k = i; k < os.length; k++) if (os[k]!.deadline >= w.tick) os[j++] = os[k]!;
      os.length = j;
      break;
    }
  }
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n);
const bad = (m: string): never => { throw new IllegalAction(m); };
const inRange = (n: unknown, lo: number, hi: number, what: string): number => {
  if (!isInt(n) || n < lo || n > hi) bad(`${what} must be an integer in [${lo}, ${hi}]`);
  return n as number;
};
const COORD = 1_000_000_000;

/** Validate everything; mutates nothing. Returns the op index. */
function validate(w: World, e: LogEntry): number {
  if (!Array.isArray(e) || e.length < 3) bad('malformed entry');
  const [t, bot, op, a, b] = e;
  if (!isInt(t)) bad('t must be an integer');
  if (t !== w.tick) bad(`action tick ${t} != world tick ${w.tick}`);
  if (!isInt(op) || op < 0 || op >= OPS.length) bad(`unknown op ${String(op)}`);
  if (!isInt(bot)) bad('bot must be an integer');
  if (FARM_OPS.includes(op as number)) {
    if (bot !== -1) bad('farm-level actions use bot -1');
  } else {
    if ((bot as number) < 0 || (bot as number) >= w.bots.length) bad(`no bot ${String(bot)}`);
    if (w.bots[bot as number]!.busyUntil > w.tick) bad(`bot ${String(bot)} is busy`);
  }
  switch (op) {
    case OP.move: inRange(a, 0, 3, 'dir'); break;
    case OP.plant: inRange(a, 1, CROP_COUNT, 'crop'); break;
    case OP.deliver: inRange(a, 1, MAX, 'order id'); break;
    case OP.wait: inRange(a, 1, 1000, 'wait n'); break;
    case OP.sell: inRange(a, 1, ITEM_COUNT - 1, 'item'); inRange(b, 1, MAX, 'units'); break;
    case OP.buyPlot: inRange(a, -COORD, COORD, 'px'); inRange(b, -COORD, COORD, 'py'); break;
    case OP.build: inRange(a, 1, BUILDINGS.length - 1, 'building'); break;
    case OP.sellPlot: inRange(a, -COORD, COORD, 'px'); inRange(b, -COORD, COORD, 'py'); break;
    case OP.unlock: inRange(a, 0, UNLOCKS.length - 1, 'research'); break;
  }
  return op as number;
}

function addCoins(w: World, n: number): void {
  if (w.coins + n > MAX) throw new Error('overflow');
  w.coins += n;
}

function pay(w: World, n: number): void { w.coins -= n; w.spent += n; }

function carried(load: Int32Array): number {
  let used = 0;
  for (let k = 1; k <= ITEM_COUNT; k++) used += load[k]!;
  return used;
}

function hivesAround(w: World, x: number, y: number): number {
  let h = 0;
  for (let d = 0; d < 4; d++) {
    const nx = x + DX[d]!, ny = y + DY[d]!;
    const p = findPlot(w, nx, ny);
    if (p && p.tiles[tileOffset(p, nx, ny) + BUILDING] === HIVE) h++;
  }
  return h;
}

/** Apply one action at the current tick. Returns its result (0 = failed in-world). Throws IllegalAction. */
export function applyAction(w: World, e: LogEntry): number {
  const op = validate(w, e);
  const botI = e[1];
  const a = e[3]!, b = e[4]!;
  const T = w.tick;
  let res = 0;
  if (op === OP.buyPlot) {
    const owned = w.plotIndex.has(plotKey(a, b));
    const adj = w.plotIndex.has(plotKey(a + 1, b)) || w.plotIndex.has(plotKey(a - 1, b))
      || w.plotIndex.has(plotKey(a, b + 1)) || w.plotIndex.has(plotKey(a, b - 1));
    const cost = plotCost(w);
    if (w.brief?.maxPlots !== undefined && w.plots.length >= w.brief.maxPlots) return 0;
    if (!owned && adj && w.coins >= cost) { pay(w, cost); addPlot(w, a, b); res = 1; }
    return res;
  }
  if (op === OP.buyBot) {
    const cost = botCost(w);
    if (w.brief?.maxBots !== undefined && w.bots.length >= w.brief.maxBots) return 0;
    if (w.coins >= cost) {
      pay(w, cost);
      w.bots.push({ x: 0, y: 0, busyUntil: T, load: new Int32Array(ITEM_COUNT + 1) });
      w.lastOp.push(null);
      res = w.bots.length;
    }
    return res;
  }
  if (op === OP.unlock) {
    const price = UNLOCKS[a]!.price;
    if (a === SILO_BIT && !silosActive(w)) return 0;
    if (w.brief?.lockedUnlocks && (w.brief.lockedUnlocks & (1 << a))) return 0;
    if (!isUnlocked(w, a) && w.coins >= price) { pay(w, price); w.unlocks |= 1 << a; res = 1; }
    return res;
  }
  if (op === OP.sellPlot) {
    if (!canSellPlot(w, a, b)) return 0;
    const plot = w.plots[w.plotIndex.get(plotKey(a, b))!]!;
    // Silos on the plot are lost: their price leaves `spent` (no coins back), newest price first, as when cleared.
    let silos = siloCount(w);
    for (let o = BUILDING; o < plot.tiles.length; o += TILE_INTS) {
      if (plot.tiles[o] === SILO) { silos--; w.spent -= siloPrice(silos); }
    }
    const paid = plotPrice(w.plots.length - 1);
    res = Math.floor(paid / 2);
    w.spent -= paid;
    addCoins(w, res);
    removePlot(w, a, b);
    return res;
  }
  const bot = w.bots[botI]!;
  const barn = bot.x === 0 && bot.y === 0;
  const plot = findPlot(w, bot.x, bot.y)!;
  const t = plot.tiles, o = tileOffset(plot, bot.x, bot.y);
  /** Deposit and sell work here: the barn, or a silo (rules v5). */
  const store = barn || t[o + BUILDING] === SILO;
  switch (op) {
    case OP.move: {
      const nx = bot.x + DX[a]!, ny = bot.y + DY[a]!;
      if (findPlot(w, nx, ny)) { bot.x = nx; bot.y = ny; res = 1; }
      break;
    }
    case OP.till:
      settleInts(w, t, o, T);
      if (!barn && !t[o + CROP] && !t[o + BUILDING]) { t[o + TILLED] = 1; res = 1; }
      break;
    case OP.plant: {
      settleInts(w, t, o, T);
      if (isUnlocked(w, a - 1) && t[o + TILLED] && !t[o + CROP] && !t[o + BUILDING] && !barn) {
        const c = CROPS[a]!;
        t[o + RATE] = t[o + MOIST]! >= c.thirst && t[o + NITRO]! >= c.hunger ? 2 : 1;
        t[o + MOIST] = Math.max(0, t[o + MOIST]! - c.drink);
        t[o + CROP] = a; t[o + PLANTED] = T; res = 1;
      }
      break;
    }
    case OP.water:
      settleInts(w, t, o, T);
      t[o + MOIST] = Math.min(100, t[o + MOIST]! + 30); res = 1;
      break;
    case OP.harvest: {
      settleInts(w, t, o, T);
      const free = capacity(w) - carried(bot.load);
      if (t[o + BUILDING] === HIVE) {
        t[o + BUILT] = Math.max(t[o + BUILT]!, T - HONEY_MAX * HONEY_INTERVAL);
        res = Math.min(honeyAt(t, o, T), free);
        bot.load[HONEY] = bot.load[HONEY]! + res;
        t[o + BUILT] = t[o + BUILT]! + res * HONEY_INTERVAL;
        break;
      }
      const crop = t[o + CROP]!;
      if (!crop) break;
      const c = CROPS[crop]!;
      const stage = stageOf(w, t, o, T);
      if (c.perennial && stage < 3) break;
      let units = 0;
      if (stage >= 3) {
        const base = Math.max(1, (c.yield * (100 - t[o + FATIGUE]!) / 100) | 0);
        units = base + ((base * 25 * hivesAround(w, bot.x, bot.y) / 100) | 0);
      }
      res = Math.min(units, free);
      bot.load[crop] = bot.load[crop]! + res;
      t[o + NITRO] = Math.min(100, Math.max(0, t[o + NITRO]! + c.nDelta));
      t[o + FATIGUE] = Math.min(100, Math.max(0, t[o + FATIGUE]! + c.fatigue));
      if (c.perennial) {
        t[o + PLANTED] = T;
        t[o + RATE] = t[o + MOIST]! >= c.thirst && t[o + NITRO]! >= c.hunger ? 2 : 1;
      } else {
        t[o + CROP] = 0; t[o + PLANTED] = 0; t[o + RATE] = 0; t[o + TILLED] = 0;
      }
      break;
    }
    case OP.deposit:
      if (store) {
        for (let k = 1; k < COMPOST; k++) {
          const n = bot.load[k]!; w.stock[k] = w.stock[k]! + n; res += n; bot.load[k] = 0;
          if (w.brief?.deposited) w.brief.deposited[k] = w.brief.deposited[k]! + n;
        }
      }
      break;
    case OP.deliver: {
      if (!barn) break;
      const idx = w.orders.findIndex((x) => x.id === a);
      const ord = w.orders[idx];
      if (ord && w.stock[ord.crop]! >= ord.qty) {
        addCoins(w, ord.reward);
        w.stock[ord.crop] = w.stock[ord.crop]! - ord.qty;
        w.orders.splice(idx, 1);
        res = ord.reward;
      }
      break;
    }
    case OP.wait: res = 1; break;
    case OP.sell:
      if (store && w.stock[a]! >= b) {
        const gain = Math.floor(b * price(w, a) / 100);
        addCoins(w, gain);
        w.stock[a] = w.stock[a]! - b; res = gain;
      }
      break;
    case OP.build: {
      settleInts(w, t, o, T);
      const kind = BUILDINGS[a]!;
      if (a === SILO && !silosActive(w)) break;
      const cost = a === SILO ? siloCost(w) : kind.price;
      if (isUnlocked(w, kind.unlock) && w.coins >= cost && !barn && !t[o + TILLED] && !t[o + CROP]
        && !t[o + BUILDING]) {
        pay(w, cost);
        t[o + BUILDING] = a; t[o + BUILT] = T; res = 1;
      }
      break;
    }
    case OP.clear:
      settleInts(w, t, o, T);
      if (t[o + BUILDING] === SILO) {
        // Half the newest silo's price back; the full price leaves `spent`, so net worth drops by the other half.
        const paid = siloPrice(siloCount(w) - 1);
        w.spent -= paid;
        addCoins(w, Math.floor(paid / 2));
      }
      if (!barn && (t[o + CROP] || t[o + BUILDING] || t[o + TILLED])) {
        t[o + CROP] = 0; t[o + PLANTED] = 0; t[o + RATE] = 0; t[o + TILLED] = 0; t[o + BUILDING] = 0; t[o + BUILT] = 0;
        res = 1;
      }
      break;
    case OP.compost: {
      if (t[o + BUILDING] !== COMPOSTER) break;
      let produce = 0;
      for (let k = 1; k <= CROP_COUNT; k++) produce += bot.load[k]!;
      const made = Math.floor(produce / 4);
      let left = made * 4;
      for (let k = 1; k <= CROP_COUNT && left > 0; k++) {
        const take = Math.min(left, bot.load[k]!);
        bot.load[k] = bot.load[k]! - take; left -= take;
      }
      bot.load[COMPOST] = bot.load[COMPOST]! + made;
      res = made;
      break;
    }
    case OP.fertilize:
      settleInts(w, t, o, T);
      if (!barn && !t[o + BUILDING] && bot.load[COMPOST]! >= 1) {
        bot.load[COMPOST] = bot.load[COMPOST]! - 1;
        t[o + NITRO] = Math.min(100, t[o + NITRO]! + 25);
        t[o + FATIGUE] = Math.max(0, t[o + FATIGUE]! - 20);
        res = 1;
      }
      break;
  }
  bot.busyUntil = T + (op === OP.wait ? a : COST[op]!);
  w.lastOp[botI] = op;
  return res;
}

// ---- free queries: settle a COPY of the tile ints ----
export function scanAt(w: World, x: number, y: number): ScanResult | null {
  if (!isInt(x) || !isInt(y)) return null;
  const plot = findPlot(w, x, y);
  if (!plot) return null;
  const o = tileOffset(plot, x, y);
  const s = plot.tiles.slice(o, o + 10);
  settleInts(w, s, 0, w.tick);
  return {
    tilled: s[TILLED]!, crop: s[CROP]!, stage: stageOf(w, s, 0, w.tick),
    moisture: s[MOIST]!, nitrogen: s[NITRO]!, fatigue: s[FATIGUE]!, barn: x === 0 && y === 0,
    building: s[BUILDING]!, honey: s[BUILDING] === HIVE ? Math.max(0, honeyAt(s, 0, w.tick)) : 0,
  };
}

export function scan(w: World, bot: number): ScanResult {
  const b = w.bots[bot];
  if (!b) throw new IllegalAction(`no bot ${bot}`);
  return scanAt(w, b.x, b.y)!;
}

export function openOrders(w: World): Order[] { return w.orders.map((o) => ({ ...o })); }

/** FNV-1a 32-bit over UTF-8 of `tendril-daily:` + date; 0 -> 1. */
export function dailySeed(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must be YYYY-MM-DD');
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode('tendril-daily:' + date)) { h ^= byte; h = Math.imul(h, 0x01000193); }
  return (h >>> 0) || 1;
}
