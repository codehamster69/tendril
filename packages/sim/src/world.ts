// Deterministic farm rules. Integers only: no floats, no Math.random, no Date.
export const DIRS = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] } as const;
export type Dir = keyof typeof DIRS;
export const OPS = ['move', 'till', 'plant', 'harvest', 'wait'] as const;
export type Op = (typeof OPS)[number];
export const COST: Record<Op, number> = { move: 2, till: 3, plant: 2, harvest: 3, wait: 1 };

/** One entry of the action log: at tick `t`, bot `bot` started `op`. */
export interface Action { t: number; bot: number; op: Op; arg?: string }

export class IllegalAction extends Error {}

const F = 3; // ints per tile: tilled, crop (0 none, 1 carrot), growth
export interface Bot { x: number; y: number; busyUntil: number }
export interface World {
  w: number; h: number; tick: number; rng: number; coins: number;
  tiles: Int32Array; bots: Bot[];
}

export function createWorld(w: number, h: number, seed: number, bots = 1): World {
  return {
    w, h, tick: 0, rng: seed >>> 0 || 1, coins: 0,
    tiles: new Int32Array(w * h * F),
    bots: Array.from({ length: bots }, (_, i) => ({ x: i % w, y: 0, busyUntil: 0 })),
  };
}

function rand(world: World): number { // xorshift32
  let x = world.rng;
  x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
  world.rng = x;
  return x;
}

export function stageOf(growth: number): number { return Math.min(3, (growth / 50) | 0); }

export function scan(world: World, bot: number) {
  const b = world.bots[bot]!; const i = (b.y * world.w + b.x) * F;
  return { tilled: world.tiles[i]!, crop: world.tiles[i + 1]!, stage: stageOf(world.tiles[i + 2]!) };
}

/** Apply one action at the current tick. Returns the action's result (0 = failed in-world). */
export function applyAction(world: World, a: Action): number {
  if (a.t !== world.tick) throw new IllegalAction(`action tick ${a.t} != world tick ${world.tick}`);
  const b = world.bots[a.bot];
  if (!b) throw new IllegalAction(`no bot ${a.bot}`);
  if (b.busyUntil > world.tick) throw new IllegalAction(`bot ${a.bot} is busy`);
  if (!OPS.includes(a.op)) throw new IllegalAction(`unknown op ${String(a.op)}`);
  b.busyUntil = world.tick + COST[a.op];
  const i = (b.y * world.w + b.x) * F; const t = world.tiles;
  switch (a.op) {
    case 'move': {
      const d = DIRS[a.arg as Dir];
      if (!d) throw new IllegalAction(`bad direction ${a.arg}`);
      const nx = b.x + d[0], ny = b.y + d[1];
      if (nx < 0 || ny < 0 || nx >= world.w || ny >= world.h) return 0;
      b.x = nx; b.y = ny; return 1;
    }
    case 'till': if (t[i + 1]) return 0; t[i] = 1; return 1;
    case 'plant':
      if (a.arg !== 'carrot') throw new IllegalAction(`unknown crop ${a.arg}`);
      if (!t[i] || t[i + 1]) return 0; t[i + 1] = 1; t[i + 2] = 0; return 1;
    case 'harvest': {
      if (!t[i + 1]) return 0;
      const gain = stageOf(t[i + 2]!) === 3 ? 5 : 0;
      t[i + 1] = 0; t[i + 2] = 0; t[i] = 0; world.coins += gain; return gain;
    }
    case 'wait': return 1;
  }
}

/** Advance the world by one tick (growth). */
export function tickWorld(world: World): void {
  const t = world.tiles;
  for (let i = 0; i < t.length; i += F) if (t[i + 1]) t[i + 2] = t[i + 2]! + 1 + (rand(world) & 1);
  world.tick++;
}

export function hashWorld(world: World): string { // FNV-1a over all state ints
  let h = 0x811c9dc5;
  const mix = (n: number) => { for (let s = 0; s < 32; s += 8) { h ^= (n >>> s) & 0xff; h = Math.imul(h, 0x01000193); } };
  mix(world.w); mix(world.h); mix(world.tick); mix(world.rng); mix(world.coins);
  for (const v of world.tiles) mix(v);
  for (const b of world.bots) { mix(b.x); mix(b.y); mix(b.busyUntil); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Server side: rebuild a run from its action log alone. Throws IllegalAction on any bad move. */
export function replay(w: number, h: number, seed: number, bots: number, endTick: number, log: Action[]): World {
  const world = createWorld(w, h, seed, bots);
  for (const a of log) {
    if (!Number.isInteger(a.t) || a.t < world.tick || a.t >= endTick) throw new IllegalAction(`bad tick ${a.t}`);
    while (world.tick < a.t) tickWorld(world);
    applyAction(world, a);
  }
  while (world.tick < endTick) tickWorld(world);
  return world;
}
