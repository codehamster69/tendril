// Deterministic farm rules (rules version 2). Integers only.
import { CAPACITY, COST, CROPS, OP, OPS, TILE_INTS, botPrice, plotPrice } from './rules.ts';
import { IllegalAction } from './types.ts';
import type { Farm, LogEntry, Order, ScanResult, World } from './types.ts';
import {
  CROP, FATIGUE, MOIST, NITRO, PLANTED, RATE, TILLED, addPlot, findPlot, plotKey,
  settleInts, stageOf, tileOffset,
} from './tiles.ts';
import { rand } from './weather.ts';

export * from './types.ts';
export { forecast, weatherAt, rainTicks, frostTicks } from './weather.ts';
export { tileHash } from './tiles.ts';

const MAX = Number.MAX_SAFE_INTEGER;
const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];

export function createWorld(farm: Farm): World {
  const seed = (farm.seed >>> 0) || 1;
  const w: World = {
    id: farm.id, seed, tick: 0, coins: 0, spent: 0,
    wrng: ((seed ^ 0xA5A5A5A5) >>> 0) || 1, orng: ((seed ^ 0x5EED5EED) >>> 0) || 1,
    nextOrderAt: 200, nextOrderId: 1, stock: [0, 0, 0, 0, 0], weather: [], orders: [],
    bots: [{ x: 0, y: 0, busyUntil: 0, load: new Int32Array(5) }],
    plots: [], plotIndex: new Map(), lastOp: [null],
  };
  addPlot(w, 0, 0);
  return w;
}

export function plotCost(w: World): number { return plotPrice(w.plots.length); }
export function botCost(w: World): number { return botPrice(w.bots.length); }

export function netWorth(w: World): number {
  let n = w.coins + w.spent;
  for (let c = 1; c <= 4; c++) n += w.stock[c]! * CROPS[c]!.price;
  return n;
}

export function tickWorld(w: World): void {
  w.tick++;
  while (w.nextOrderAt <= w.tick) {
    w.orng = rand(w.orng); const crop = 1 + (w.orng % 4);
    w.orng = rand(w.orng); const qty = (5 + (w.orng % 16)) * w.plots.length;
    w.orng = rand(w.orng); const life = 1500 + (w.orng % 1500);
    w.orders.push({
      id: w.nextOrderId++, crop, qty, reward: qty * CROPS[crop]!.price * 2 + 10,
      opensAt: w.nextOrderAt, deadline: w.nextOrderAt + life,
    });
    w.orng = rand(w.orng); w.nextOrderAt += 800 + (w.orng % 1200);
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
  if (op === OP.buyPlot || op === OP.buyBot) {
    if (bot !== -1) bad('farm-level actions use bot -1');
  } else {
    if ((bot as number) < 0 || (bot as number) >= w.bots.length) bad(`no bot ${String(bot)}`);
    if (w.bots[bot as number]!.busyUntil > w.tick) bad(`bot ${String(bot)} is busy`);
  }
  switch (op) {
    case OP.move: inRange(a, 0, 3, 'dir'); break;
    case OP.plant: inRange(a, 1, 4, 'crop'); break;
    case OP.deliver: inRange(a, 1, MAX, 'order id'); break;
    case OP.wait: inRange(a, 1, 1000, 'wait n'); break;
    case OP.sell: inRange(a, 1, 4, 'crop'); inRange(b, 1, MAX, 'units'); break;
    case OP.buyPlot: inRange(a, -COORD, COORD, 'px'); inRange(b, -COORD, COORD, 'py'); break;
  }
  return op as number;
}

function addCoins(w: World, n: number): void {
  if (w.coins + n > MAX) throw new Error('overflow');
  w.coins += n;
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
    if (!owned && adj && w.coins >= cost) { w.coins -= cost; w.spent += cost; addPlot(w, a, b); res = 1; }
    return res;
  }
  if (op === OP.buyBot) {
    const cost = botCost(w);
    if (w.coins >= cost) {
      w.coins -= cost; w.spent += cost;
      w.bots.push({ x: 0, y: 0, busyUntil: T, load: new Int32Array(5) });
      w.lastOp.push(null);
      res = w.bots.length;
    }
    return res;
  }
  const bot = w.bots[botI]!;
  const barn = bot.x === 0 && bot.y === 0;
  const plot = findPlot(w, bot.x, bot.y)!;
  const t = plot.tiles, o = tileOffset(plot, bot.x, bot.y);
  switch (op) {
    case OP.move: {
      const nx = bot.x + DX[a]!, ny = bot.y + DY[a]!;
      if (findPlot(w, nx, ny)) { bot.x = nx; bot.y = ny; res = 1; }
      break;
    }
    case OP.till:
      settleInts(w, t, o, T);
      if (!barn && !t[o + CROP]) { t[o + TILLED] = 1; res = 1; }
      break;
    case OP.plant: {
      settleInts(w, t, o, T);
      if (t[o + TILLED] && !t[o + CROP] && !barn) {
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
      const crop = t[o + CROP]!;
      if (!crop) break;
      const c = CROPS[crop]!;
      const units = stageOf(w, t, o, T) < 3 ? 0 : Math.max(1, (c.yield * (100 - t[o + FATIGUE]!) / 100) | 0);
      let used = 0;
      for (let k = 1; k <= 4; k++) used += bot.load[k]!;
      res = Math.min(units, CAPACITY - used);
      bot.load[crop] = bot.load[crop]! + res;
      t[o + NITRO] = Math.min(100, Math.max(0, t[o + NITRO]! + c.nDelta));
      t[o + FATIGUE] = Math.min(100, Math.max(0, t[o + FATIGUE]! + c.fatigue));
      t[o + CROP] = 0; t[o + PLANTED] = 0; t[o + RATE] = 0; t[o + TILLED] = 0;
      break;
    }
    case OP.deposit:
      if (barn) {
        for (let k = 1; k <= 4; k++) { const n = bot.load[k]!; w.stock[k] = w.stock[k]! + n; res += n; bot.load[k] = 0; }
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
      if (barn && w.stock[a]! >= b) {
        const gain = b * CROPS[a]!.price;
        addCoins(w, gain);
        w.stock[a] = w.stock[a]! - b; res = gain;
      }
      break;
  }
  bot.busyUntil = T + (op === OP.wait ? a : COST[op]!);
  w.lastOp[botI] = op;
  return res;
}

// ---- free queries: settle a COPY of the tile ints ----
const scratch = new Int32Array(TILE_INTS);
export function scanAt(w: World, x: number, y: number): ScanResult | null {
  if (!isInt(x) || !isInt(y)) return null;
  const plot = findPlot(w, x, y);
  if (!plot) return null;
  const o = tileOffset(plot, x, y);
  for (let i = 0; i < TILE_INTS; i++) scratch[i] = plot.tiles[o + i]!;
  settleInts(w, scratch, 0, w.tick);
  return {
    tilled: scratch[TILLED]!, crop: scratch[CROP]!, stage: stageOf(w, scratch, 0, w.tick),
    moisture: scratch[MOIST]!, nitrogen: scratch[NITRO]!, fatigue: scratch[FATIGUE]!, barn: x === 0 && y === 0,
  };
}

export function scan(w: World, bot: number): ScanResult {
  const b = w.bots[bot];
  if (!b) throw new IllegalAction(`no bot ${bot}`);
  return scanAt(w, b.x, b.y)!;
}

export function openOrders(w: World): Order[] { return w.orders.map((o) => ({ ...o })); }

