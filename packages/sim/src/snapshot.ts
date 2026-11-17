import { HIVE, ITEM_COUNT, PLOT_SIZE, TILE_INTS } from './rules.ts';
import type { Snapshot, World } from './types.ts';
import { BUILDING, CROP, FATIGUE, MOIST, NITRO, TILLED, honeyAt, settleInts, stageOf } from './tiles.ts';
import { botCost, capacity, netWorth, openOrders, plotCost, plotRefund, siloCost } from './world.ts';
import { weatherAt } from './weather.ts';

export function snapshot(w: World): Snapshot {
  const tmp = new Int32Array(TILE_INTS);
  const tiles: Snapshot['tiles'] = [];
  for (const p of w.plots) {
    for (let dy = 0; dy < PLOT_SIZE; dy++) {
      for (let dx = 0; dx < PLOT_SIZE; dx++) {
        const o = (dy * PLOT_SIZE + dx) * TILE_INTS;
        for (let i = 0; i < TILE_INTS; i++) tmp[i] = p.tiles[o + i]!;
        settleInts(w, tmp, 0, w.tick);
        tiles.push({
          x: p.px * PLOT_SIZE + dx, y: p.py * PLOT_SIZE + dy, tilled: tmp[TILLED]!, crop: tmp[CROP]!,
          stage: stageOf(w, tmp, 0, w.tick), moisture: tmp[MOIST]!, nitrogen: tmp[NITRO]!, fatigue: tmp[FATIGUE]!,
          building: tmp[BUILDING]!, honey: tmp[BUILDING] === HIVE ? Math.max(0, honeyAt(tmp, 0, w.tick)) : 0,
        });
      }
    }
  }
  return {
    tick: w.tick, coins: w.coins, netWorth: netWorth(w), weather: weatherAt(w, w.tick),
    unlocks: w.unlocks, capacity: capacity(w),
    plots: w.plots.map((p) => ({ px: p.px, py: p.py })), tiles,
    bots: w.bots.map((b, i) => {
      let load = 0;
      for (let k = 1; k <= ITEM_COUNT; k++) load += b.load[k]!;
      return {
        x: b.x, y: b.y, busyUntil: b.busyUntil, load, items: Array.from(b.load),
        op: b.busyUntil > w.tick ? (w.lastOp[i] ?? null) : null,
      };
    }),
    stock: w.stock.slice(), orders: openOrders(w), plotCost: plotCost(w), botCost: botCost(w), ...siloFields(w),
  };
}

/** Rules v5 extras; nothing for an older world, so its snapshot is unchanged. */
function siloFields(w: World): Pick<Snapshot, 'siloCost' | 'plotRefund'> {
  return w.siloTick === undefined ? {} : { siloCost: siloCost(w), plotRefund: plotRefund(w) };
}

// ---- Compact view (client screen only). The server and tests keep using snapshot() above. ----

/** Ints per tile in a view: tilled, crop, stage, moisture, nitrogen, fatigue, building, honey (same values as SnapshotTile). */
export const VIEW_TILE_FIELDS = 8;
/** Ints per bot in a view: x, y, busyUntil, load, op (-1 for none), then the items array (ITEM_COUNT + 1 entries). */
export const VIEW_BOT_FIELDS = 5 + ITEM_COUNT + 1;

/** Write the settled tiles of plot `index` into `out` (length PLOT_SIZE² × VIEW_TILE_FIELDS), in snapshot() order. */
export function viewPlot(w: World, index: number, out: Int32Array): void {
  const p = w.plots[index]!;
  const tmp = new Int32Array(TILE_INTS);
  for (let n = 0; n < PLOT_SIZE * PLOT_SIZE; n++) {
    const o = n * TILE_INTS;
    for (let i = 0; i < TILE_INTS; i++) tmp[i] = p.tiles[o + i]!;
    settleInts(w, tmp, 0, w.tick);
    const f = n * VIEW_TILE_FIELDS;
    out[f] = tmp[TILLED]!; out[f + 1] = tmp[CROP]!; out[f + 2] = stageOf(w, tmp, 0, w.tick);
    out[f + 3] = tmp[MOIST]!; out[f + 4] = tmp[NITRO]!; out[f + 5] = tmp[FATIGUE]!; out[f + 6] = tmp[BUILDING]!;
    out[f + 7] = tmp[BUILDING] === HIVE ? Math.max(0, honeyAt(tmp, 0, w.tick)) : 0;
  }
}

/** Write bot `i` into `out` at offset `o` (VIEW_BOT_FIELDS ints), same values as SnapshotBot. */
export function viewBot(w: World, i: number, out: Int32Array, o: number): void {
  const b = w.bots[i]!;
  let load = 0;
  for (let k = 1; k <= ITEM_COUNT; k++) load += b.load[k]!;
  out[o] = b.x; out[o + 1] = b.y; out[o + 2] = b.busyUntil; out[o + 3] = load;
  out[o + 4] = b.busyUntil > w.tick ? (w.lastOp[i] ?? -1) : -1;
  for (let k = 0; k <= ITEM_COUNT; k++) out[o + 5 + k] = b.load[k]!;
}

export type ViewScalars = Pick<Snapshot, 'coins' | 'netWorth' | 'weather' | 'unlocks' | 'capacity' | 'stock' | 'orders' | 'plotCost' | 'botCost' | 'siloCost' | 'plotRefund'>;

/** Everything in a snapshot except tick, plots, tiles and bots. Small, compared by value to detect changes. */
export function viewScalars(w: World): ViewScalars {
  return {
    coins: w.coins, netWorth: netWorth(w), weather: weatherAt(w, w.tick), unlocks: w.unlocks, capacity: capacity(w),
    stock: w.stock.slice(), orders: openOrders(w), plotCost: plotCost(w), botCost: botCost(w), ...siloFields(w),
  };
}
