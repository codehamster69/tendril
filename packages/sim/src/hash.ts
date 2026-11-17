import { BASE_RULES_VERSION, ITEM_COUNT, MARKET_RULES_VERSION, PLOT_SIZE, RULES_VERSION, SUPPORTED_RULES_VERSIONS, TILE_INTS } from './rules.ts';
import type { BriefState, Bot, Order, Plot, Segment, World } from './types.ts';
import { plotKey } from './tiles.ts';
import { ensureWeather } from './weather.ts';

const TWO32 = 4294967296;

export function hashWorld(w: World): string {
  ensureWeather(w, w.tick); // schedule is a pure function of the seed
  let h = 0x811c9dc5;
  const mix = (n: number): void => {
    const lo = n >>> 0, hi = Math.floor(n / TWO32) >>> 0;
    for (let s = 0; s < 32; s += 8) { h ^= (lo >>> s) & 0xff; h = Math.imul(h, 0x01000193); }
    for (let s = 0; s < 32; s += 8) { h ^= (hi >>> s) & 0xff; h = Math.imul(h, 0x01000193); }
  };
  mix(w.tick); mix(w.coins); mix(w.spent); mix(w.unlocks); mix(w.orng); mix(w.nextOrderAt); mix(w.nextOrderId);
  for (let c = 1; c < ITEM_COUNT; c++) mix(w.stock[c]!);
  if (w.prices) for (let c = 1; c < ITEM_COUNT; c++) mix(w.prices[c]!); // rules v4 only; absent leaves every v3 hash unchanged
  for (const s of w.weather) {
    if (s.start > w.tick) break;
    mix(s.kind === 'rain' ? 1 : 2); mix(s.start); mix(s.end);
  }
  for (const o of w.orders) { mix(o.id); mix(o.crop); mix(o.qty); mix(o.reward); mix(o.opensAt); mix(o.deadline); }
  for (const b of w.bots) {
    mix(b.x); mix(b.y); mix(b.busyUntil);
    for (let c = 1; c <= ITEM_COUNT; c++) mix(b.load[c]!);
  }
  for (const p of w.plots) { mix(p.px); mix(p.py); for (let i = 0; i < p.tiles.length; i++) mix(p.tiles[i]!); }
  // w.siloTick is deliberately not mixed (SIM_SPEC 5.6): silos and sold plots already show in tiles, plots, coins and spent.
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function serialize(w: World): string {
  return JSON.stringify({
    rulesVersion: w.siloTick !== undefined ? RULES_VERSION : w.prices ? MARKET_RULES_VERSION : BASE_RULES_VERSION, id: w.id, seed: w.seed, tick: w.tick, coins: w.coins, spent: w.spent, unlocks: w.unlocks, wrng: w.wrng, orng: w.orng,
    nextOrderAt: w.nextOrderAt, nextOrderId: w.nextOrderId, stock: w.stock, weather: w.weather, orders: w.orders,
    bots: w.bots.map((b) => ({ x: b.x, y: b.y, busyUntil: b.busyUntil, load: Array.from(b.load) })),
    plots: w.plots.map((p) => ({ px: p.px, py: p.py, tiles: Array.from(p.tiles) })),
    lastOp: w.lastOp,
    ...(w.weatherBias ? { weatherBias: w.weatherBias } : {}),
    ...(w.prices ? { prices: w.prices } : {}),
    ...(w.siloTick !== undefined ? { siloTick: w.siloTick } : {}),
    ...(w.brief ? { brief: w.brief } : {}),
  });
}

export function deserialize(s: string): World {
  const d = JSON.parse(s) as {
    rulesVersion: number; id: string; seed: number; tick: number; coins: number; spent: number; unlocks: number; wrng: number; orng: number;
    nextOrderAt: number; nextOrderId: number; stock: number[]; weather: Segment[]; orders: Order[];
    bots: { x: number; y: number; busyUntil: number; load: number[] }[];
    plots: { px: number; py: number; tiles: number[] }[]; lastOp: (number | null)[]; weatherBias?: number; prices?: number[]; siloTick?: number; brief?: BriefState;
  };
  if (!SUPPORTED_RULES_VERSIONS.includes(d.rulesVersion)) throw new Error(`unsupported rules version ${String(d.rulesVersion)}`);
  // Version 3 never has a table and version 4 always has one (dispatch by data, SIM_SPEC 4.1). Version 5 has silo rules and may have a table.
  if (d.rulesVersion !== RULES_VERSION && (d.rulesVersion === MARKET_RULES_VERSION) !== (d.prices !== undefined)) throw new Error('rules version does not match the price table');
  if ((d.rulesVersion === RULES_VERSION) !== (d.siloTick !== undefined)) throw new Error('rules version does not match the silo tick');
  if (d.siloTick !== undefined && (!Number.isSafeInteger(d.siloTick) || d.siloTick < 0)) throw new Error('bad silo tick');
  if (d.prices !== undefined && (d.prices.length !== ITEM_COUNT || !d.prices.every((v, i) => i === 0 ? v === 0 : Number.isSafeInteger(v) && v >= 1 && v <= 100_000))) throw new Error('bad prices');
  const bots: Bot[] = d.bots.map((b) => {
    if (b.load.length !== ITEM_COUNT + 1) throw new Error('bad bot');
    return { x: b.x, y: b.y, busyUntil: b.busyUntil, load: Int32Array.from(b.load) };
  });
  const plots: Plot[] = d.plots.map((p) => {
    if (p.tiles.length !== PLOT_SIZE * PLOT_SIZE * TILE_INTS) throw new Error('bad plot');
    return { px: p.px, py: p.py, tiles: Int32Array.from(p.tiles) };
  });
  const plotIndex = new Map<string, number>();
  plots.forEach((p, i) => plotIndex.set(plotKey(p.px, p.py), i));
  return {
    id: d.id, seed: d.seed, tick: d.tick, coins: d.coins, spent: d.spent, unlocks: d.unlocks, wrng: d.wrng, orng: d.orng,
    nextOrderAt: d.nextOrderAt, nextOrderId: d.nextOrderId, stock: d.stock, weather: d.weather, orders: d.orders,
    bots, plots, plotIndex, lastOp: d.lastOp,
    ...(d.weatherBias && Math.abs(d.weatherBias) <= 2 ? { weatherBias: d.weatherBias } : {}),
    ...(d.prices ? { prices: d.prices } : {}),
    ...(d.siloTick !== undefined ? { siloTick: d.siloTick } : {}),
    ...(d.brief ? { brief: d.brief } : {}),
  };
}
