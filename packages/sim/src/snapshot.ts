import { PLOT_SIZE, TILE_INTS } from './rules.ts';
import type { Snapshot, World } from './types.ts';
import { CROP, FATIGUE, MOIST, NITRO, TILLED, settleInts, stageOf } from './tiles.ts';
import { botCost, netWorth, openOrders, plotCost } from './world.ts';
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
        });
      }
    }
  }
  return {
    tick: w.tick, coins: w.coins, netWorth: netWorth(w), weather: weatherAt(w, w.tick),
    plots: w.plots.map((p) => ({ px: p.px, py: p.py })), tiles,
    bots: w.bots.map((b, i) => ({
      x: b.x, y: b.y, busyUntil: b.busyUntil, load: b.load[1]! + b.load[2]! + b.load[3]! + b.load[4]!,
      op: b.busyUntil > w.tick ? (w.lastOp[i] ?? null) : null,
    })),
    stock: w.stock.slice(), orders: openOrders(w), plotCost: plotCost(w), botCost: botCost(w),
  };
}
