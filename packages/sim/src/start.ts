// Start-of-challenge world building for daily briefs (SIM_SPEC section 6). Pure; used only by createWorld when a Setup field asks for it.
import { CROPS, HIVE, PLOT_SIZE, TILE_INTS } from './rules.ts';
import type { World } from './types.ts';
import { BUILDING, BUILT, CROP, FATIGUE, MOIST, NITRO, PLANTED, RATE, TILLED, addPlot } from './tiles.ts';
import { rand } from './weather.ts';

/** Own salt: the inherited farm's stream is `rand` from `seed ^ INHERIT_SALT` (0 -> 1). */
const INHERIT_SALT = 0x1AE71D5A;

/** A pre-built hive on tile (x, y) of the barn plot. Throws on the barn tile or a tile off the plot. */
export function placeHive(w: World, x: number, y: number): void {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= PLOT_SIZE || y >= PLOT_SIZE || (x === 0 && y === 0)) throw new Error('bad setup hive');
  const o = (y * PLOT_SIZE + x) * TILE_INTS;
  const t = w.plots[0]!.tiles;
  t[o + TILLED] = 0; t[o + CROP] = 0; t[o + PLANTED] = 0; t[o + RATE] = 0;
  t[o + BUILDING] = HIVE; t[o + BUILT] = w.tick;
}

/**
 * The inherited farm (SIM_SPEC 6.4): one extra plot east of the barn, then every tile of both plots (not the barn) drawn from the
 * world seed: 35% untouched, 25% tilled and empty, 40% planted with carrot, wheat or clover part-way through its growth.
 * All tiles are tired (fatigue 20..60) and short of nitrogen (5..25). Planted ticks are negative: that is how a crop is already growing at tick 0.
 */
export function inheritFarm(w: World): void {
  let s = ((w.seed ^ INHERIT_SALT) >>> 0) || 1;
  const next = (n: number): number => { s = rand(s); return (s >>> 8) % n; };
  addPlot(w, 1, 0);
  for (const p of w.plots) {
    for (let dy = 0; dy < PLOT_SIZE; dy++) {
      for (let dx = 0; dx < PLOT_SIZE; dx++) {
        const o = (dy * PLOT_SIZE + dx) * TILE_INTS;
        const barn = p.px === 0 && p.py === 0 && dx === 0 && dy === 0;
        const kind = next(20), crop = 1 + next(3), age = next(2000), rate = 1 + next(2), moist = 20 + next(41);
        const nitro = 5 + next(21), fatigue = 20 + next(41);
        if (barn || p.tiles[o + BUILDING]) continue;
        p.tiles[o + NITRO] = nitro; p.tiles[o + FATIGUE] = fatigue; p.tiles[o + MOIST] = moist;
        if (kind < 7) continue;
        p.tiles[o + TILLED] = 1;
        if (kind < 12) continue;
        const c = CROPS[crop]!;
        p.tiles[o + CROP] = crop; p.tiles[o + RATE] = rate;
        p.tiles[o + PLANTED] = -(age % (2 * c.stageLen));
      }
    }
  }
}
