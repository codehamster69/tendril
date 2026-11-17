// Silo tuning table (brief L1, brain/notes/L1-silos.md). Not a test; prints a table.
// From workspace root: node --experimental-strip-types packages/sim/scripts/silo-tuning.ts
// Every farm runs the same simple program: each bot walks its share of the tiles, harvests ripe wheat, replants, and when
// full walks to the nearest store (barn or silo), deposits and sells. Coins per 1000 ticks are measured from tick 3000 to 13000.
import { applyAction, createWorld, scanAt, tickWorld } from '../src/index.ts';
import type { LogEntry, World } from '../src/index.ts';
import { OP, PLOT_SIZE, SILO, SILO_BASE, SILO_RESEARCH, UNLOCKS, siloPrice } from '../src/rules.ts';

const WHEAT = 2, WARM = 3000, END = 13_000;

function run(side: number, silos: [number, number][], bots: number): number {
  const w: World = createWorld({ id: 'tune', seed: 4242 }, { coins: 10_000_000, unlocks: (1 << UNLOCKS.length) - 1, siloTick: 0 });
  for (let py = 0; py < side; py++) for (let px = 0; px < side; px++) if (px || py) do1(w, [0, -1, OP.buyPlot, px, py]);
  for (let i = 1; i < bots; i++) do1(w, [0, -1, OP.buyBot]);
  const W = side * PLOT_SIZE;
  const isSilo = new Set(silos.map(([x, y]) => x + ',' + y));
  // Place silos with bot 0, teleport-free: walk there and build. Done before the clock starts counting.
  for (const [x, y] of silos) { walk(w, 0, x, y); act(w, 0, OP.build, SILO); }
  const tiles: [number, number][] = [];
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) if ((x || y) && !isSilo.has(x + ',' + y)) tiles.push([x, y]);
  // Contiguous share per bot, in row order of plots so each bot works one area.
  tiles.sort((a, b) => (Math.floor(a[1] / PLOT_SIZE) * side + Math.floor(a[0] / PLOT_SIZE)) - (Math.floor(b[1] / PLOT_SIZE) * side + Math.floor(b[0] / PLOT_SIZE)) || a[1] - b[1] || a[0] - b[0]);
  const share = Math.ceil(tiles.length / bots);
  const next = new Array<number>(bots).fill(0);
  const stores: [number, number][] = [[0, 0], ...silos];
  let coinsAtWarm = 0;
  while (w.tick < END) {
    if (w.tick === WARM) coinsAtWarm = w.coins;
    for (let b = 0; b < bots; b++) {
      const bot = w.bots[b]!;
      if (bot.busyUntil > w.tick) continue;
      let load = 0;
      for (let k = 1; k < bot.load.length; k++) load += bot.load[k]!;
      if (load >= 30) {
        let best = stores[0]!, bd = Infinity;
        for (const s of stores) { const d = Math.abs(s[0] - bot.x) + Math.abs(s[1] - bot.y); if (d < bd) { bd = d; best = s; } }
        if (bd) { step(w, b, best[0], best[1]); continue; }
        do1(w, [w.tick, b, OP.deposit]);
        continue;
      }
      const mine = tiles.slice(b * share, (b + 1) * share);
      if (!mine.length) { do1(w, [w.tick, b, OP.wait, 10]); continue; }
      const [tx, ty] = mine[next[b]! % mine.length]!;
      if (bot.x !== tx || bot.y !== ty) { step(w, b, tx, ty); continue; }
      const s = scanAt(w, tx, ty)!;
      if (s.crop && s.stage >= 3) { do1(w, [w.tick, b, OP.harvest]); continue; }
      if (!s.crop && !s.tilled) { do1(w, [w.tick, b, OP.till]); continue; }
      if (!s.crop) { do1(w, [w.tick, b, OP.plant, WHEAT]); next[b]!++; continue; }
      next[b]!++; // growing: move on
      do1(w, [w.tick, b, OP.wait, 1]);
    }
    // Sell at once wherever stock lands (a silo sells like the barn); counts the same as walking back to sell.
    if (w.stock[WHEAT]! > 0) { w.coins += w.stock[WHEAT]! * 3; w.stock[WHEAT] = 0; }
    tickWorld(w);
  }
  return Math.round((w.coins - coinsAtWarm) / ((END - WARM) / 1000));
}

function do1(w: World, e: LogEntry): number { e[0] = w.tick; return applyAction(w, e); }
function act(w: World, b: number, op: number, a?: number): void {
  while (w.bots[b]!.busyUntil > w.tick) tickWorld(w);
  do1(w, a === undefined ? [0, b, op] : [0, b, op, a]);
}
function step(w: World, b: number, tx: number, ty: number): void {
  const bot = w.bots[b]!;
  const dir = bot.x < tx ? 1 : bot.x > tx ? 3 : bot.y < ty ? 2 : 0;
  do1(w, [w.tick, b, OP.move, dir]);
}
function walk(w: World, b: number, tx: number, ty: number): void {
  const bot = w.bots[b]!;
  while (bot.x !== tx || bot.y !== ty) { while (bot.busyUntil > w.tick) tickWorld(w); step(w, b, tx, ty); }
}

/** Silo spots: farm centre for 1, halves for 2, quadrant centres for 4, every plot centre for "all". */
function spots(side: number, k: number | 'all'): [number, number][] {
  const W = side * PLOT_SIZE, c = (f: number): number => Math.floor(W * f);
  if (k === 0) return [];
  if (k === 1) return [[c(0.5), c(0.5)]];
  if (k === 2) return [[c(0.25), c(0.5)], [c(0.75), c(0.5)]];
  if (k === 4) return [[c(0.25), c(0.25)], [c(0.75), c(0.25)], [c(0.25), c(0.75)], [c(0.75), c(0.75)]];
  const out: [number, number][] = [];
  for (let py = 0; py < side; py++) for (let px = 0; px < side; px++) out.push([px * PLOT_SIZE + 4, py * PLOT_SIZE + 4]);
  return out;
}
const totalCost = (n: number): number => { let c = 0; for (let i = 0; i < n; i++) c += siloPrice(i); return c; };

console.log(`SILO_BASE ${SILO_BASE}, research ${SILO_RESEARCH}. Coins per 1000 ticks, ticks ${WARM}-${END}; bots = plots / 2 (at least 2).`);
console.log('| plots | bots | silos | silo cost | coins/1000 | gain vs 0 | payback ticks (silos + research) |');
console.log('|---|---|---|---|---|---|---|');
for (const plots of [4, 9, 16, 36]) {
  const side = Math.round(Math.sqrt(plots)), bots = Math.max(2, Math.floor(plots / 2));
  const base = run(side, [], bots);
  for (const k of [0, 1, 2, 4, 'all'] as const) {
    const s = spots(side, k);
    if (k === 'all' && plots <= 4) continue;
    const rate = k === 0 ? base : run(side, s, bots);
    const cost = totalCost(s.length);
    const gain = rate - base;
    const payback = s.length === 0 ? '' : gain > 0 ? String(Math.round((cost + SILO_RESEARCH) / gain * 1000)) : 'never';
    console.log(`| ${plots} | ${bots} | ${k === 'all' ? `${s.length} (all)` : k} | ${cost} | ${rate} | ${k === 0 ? '' : gain} | ${payback} |`);
  }
}
