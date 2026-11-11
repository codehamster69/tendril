// Tile storage, lazy settle and growth.
import { CROPS, PLOT_SIZE, TILE_INTS } from './rules.ts';
import type { Plot, World } from './types.ts';
import { firstEndAfter, frostTicks, rainTicks, ensureWeather } from './weather.ts';

export const TILLED = 0, CROP = 1, PLANTED = 2, RATE = 3, MOIST = 4, NITRO = 5, FATIGUE = 6, UPDATED = 7;

export function tileHash(seed: number, x: number, y: number): number {
  let h = seed | 0;
  h = Math.imul(h ^ (x | 0), 0x9E3779B1);
  h = Math.imul(h ^ (y | 0), 0x85EBCA6B);
  h ^= h >>> 15;
  return h >>> 0;
}

export function plotKey(px: number, py: number): string { return px + ',' + py; }

export function addPlot(w: World, px: number, py: number): Plot {
  const tiles = new Int32Array(PLOT_SIZE * PLOT_SIZE * TILE_INTS);
  for (let dy = 0; dy < PLOT_SIZE; dy++) {
    for (let dx = 0; dx < PLOT_SIZE; dx++) {
      const o = (dy * PLOT_SIZE + dx) * TILE_INTS;
      tiles[o + MOIST] = 50;
      tiles[o + NITRO] = 30 + (tileHash(w.seed, px * PLOT_SIZE + dx, py * PLOT_SIZE + dy) % 21);
      tiles[o + UPDATED] = w.tick;
    }
  }
  const plot: Plot = { px, py, tiles };
  w.plotIndex.set(plotKey(px, py), w.plots.length);
  w.plots.push(plot);
  return plot;
}

export function findPlot(w: World, x: number, y: number): Plot | undefined {
  const i = w.plotIndex.get(plotKey(Math.floor(x / PLOT_SIZE), Math.floor(y / PLOT_SIZE)));
  return i === undefined ? undefined : w.plots[i];
}

export function tileOffset(p: Plot, x: number, y: number): number {
  return ((y - p.py * PLOT_SIZE) * PLOT_SIZE + (x - p.px * PLOT_SIZE)) * TILE_INTS;
}

/** growth (capped at 3 stages) of the planted crop at tick T, given tile ints `a` at offset `o`. */
export function growthAt(w: World, a: Int32Array, o: number, T: number): number {
  const c = CROPS[a[o + CROP]!]!;
  const planted = a[o + PLANTED]!;
  const g = a[o + RATE]! * (T - planted - (c.hardy ? 0 : frostTicks(w, planted, T)));
  return Math.min(3 * c.stageLen, g);
}

export function stageOf(w: World, a: Int32Array, o: number, T: number): number {
  const crop = a[o + CROP]!;
  if (!crop) return 0;
  return Math.min(3, (growthAt(w, a, o, T) / CROPS[crop]!.stageLen) | 0);
}

/** Bring a tile (ints `a` at offset `o`) from its `updated` tick to T. */
export function settleInts(w: World, a: Int32Array, o: number, T: number): void {
  const upd = a[o + UPDATED]!;
  if (T <= upd) return;
  const rt = rainTicks(w, upd, T);
  if (rt) a[o + MOIST] = Math.min(100, a[o + MOIST]! + 2 * rt);
  const crop = a[o + CROP]!;
  if (!crop) {
    const d = Math.floor(T / 16) - Math.floor(upd / 16);
    if (d) a[o + FATIGUE] = Math.max(0, a[o + FATIGUE]! - d);
  } else {
    const c = CROPS[crop]!;
    if (!c.hardy) {
      ensureWeather(w, T);
      for (let i = firstEndAfter(w, upd); i < w.weather.length; i++) {
        const s = w.weather[i]!;
        if (s.start > T) break;
        if (s.kind !== 'frost' || s.start <= upd) continue;
        if (growthAt(w, a, o, s.start) < c.stageLen) {
          a[o + CROP] = 0; a[o + PLANTED] = 0; a[o + RATE] = 0;
          break;
        }
        break; // growth is non-decreasing: once past stage 0, later frosts cannot kill
      }
    }
  }
  a[o + UPDATED] = T;
}
