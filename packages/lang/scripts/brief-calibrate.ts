// K2 calibration: runs the reference program of each goal on N brief seeds x (1 visible + hidden) farms and reports score ranges.
// Usage: node --experimental-transform-types packages/lang/scripts/brief-calibrate.ts [daily|season] [count] [goal]
// Seeds are fnv1a32("tendril-brief:<salt>:<id>") with a preview salt, so they are not the live ones.
import { readFileSync } from 'node:fs';
import { challengeSetup, createWorld, HIDDEN_FARMS, replayWithGoal, SETUP_BRIEF, RULES_VERSION } from '@tendril/sim/src/index.ts';
import type { GoalKind } from '@tendril/sim/src/index.ts';
import { createRun } from '../src/engine.ts';

const kind = (process.argv[2] ?? 'daily') as 'daily' | 'season';
const count = Number(process.argv[3] ?? (kind === 'daily' ? 100 : 30));
const only = process.argv[4] as GoalKind | undefined;
const salt = process.env.SALT ?? 'calibrate';
const fnv = (s: string): number => { let h = 0x811c9dc5; for (const b of new TextEncoder().encode(s)) { h ^= b; h = Math.imul(h, 0x01000193); } return (h >>> 0) || 1; };
const src = (g: GoalKind): string => readFileSync(new URL(process.env.PROG ? `../examples/${process.env.PROG}.sprout` : `../examples/brief-${g}.sprout`, import.meta.url), 'utf8');

export interface FarmResult { score: number; parTick: number | null }
export function runFarm(source: string, k: 'daily' | 'season', id: string, briefSeed: number, seed: number): FarmResult & { goal: GoalKind } {
  const cs = challengeSetup(k, briefSeed, SETUP_BRIEF, null, RULES_VERSION);
  const world = createWorld({ id, seed }, cs.setup);
  const run = createRun(world, source);
  run.step(cs.ticks);
  const actions = run.pending.filter((a) => a[0] < cs.ticks);
  run.close();
  const r = replayWithGoal(createWorld({ id, seed }, cs.setup), actions, cs.ticks, cs.brief!.goal, Number.MAX_SAFE_INTEGER);
  return { score: r.score, parTick: r.parTick, goal: cs.brief!.goal.kind };
}

const rows = new Map<GoalKind, { means: number[]; visible: number[]; naive: number; spread: number }>();
const naiveSrc = readFileSync(new URL('../examples/daily.sprout', import.meta.url), 'utf8');
const start = Date.now();
for (let i = 0; i < count; i++) {
  const id = `${kind === 'daily' ? 'd' : 's'}-${i}`;
  const seed = fnv(`tendril-brief:${salt}:${id}`);
  const g = challengeSetup(kind, seed, SETUP_BRIEF).brief!.goal.kind;
  if (only && g !== only) continue;
  const scores: number[] = [];
  for (let f = 0; f <= HIDDEN_FARMS[kind]; f++) scores.push(runFarm(src(g), kind, id, seed, f === 0 ? seed : fnv(`tendril-brief:${salt}:${id}:h${f}`)).score);
  if (process.env.VERBOSE) { const b = challengeSetup(kind, seed, SETUP_BRIEF).brief!; console.log(`${id} ${g} ${b.goal.quotas ? 'q=' + b.goal.quotas.slice(1).join('/') : ''} [${b.labels.join('; ')}] scores ${scores.join(' ')}`); }
  const row = rows.get(g) ?? { means: [], visible: [], naive: 0, spread: 0 };
  const mean = Math.floor(scores.reduce((a, b) => a + b, 0) / scores.length);
  let naiveSum = 0;
  for (let f = 0; f <= HIDDEN_FARMS[kind]; f++) naiveSum += runFarm(naiveSrc, kind, id, seed, f === 0 ? seed : fnv(`tendril-brief:${salt}:${id}:h${f}`)).score;
  if (Math.floor(naiveSum / scores.length) >= Math.max(1, Math.floor(mean * 0.9))) row.naive++;
  if (Math.max(...scores) > 2 * Math.max(1, Math.min(...scores))) row.spread++;
  row.means.push(Math.floor(scores.reduce((a, b) => a + b, 0) / scores.length));
  row.visible.push(scores[0]!);
  rows.set(g, row);
}
const q = (xs: number[], p: number): number => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;
console.log(`# ${kind} x ${count} seeds, salt ${salt} (${((Date.now() - start) / 1000).toFixed(0)}s)`);
console.log('goal        n   min   p10   median   p90   max   | par range | trivial: first program (daily.sprout) reaches par | hidden farm >2x apart');
for (const [g, r] of rows) {
  const m = r.means;
  const par = (x: number): number => Math.max(1, Math.floor(x * 0.9));
  const trivial = m.filter((x) => x <= 5).length;
  console.log(`${g.padEnd(10)} ${String(m.length).padStart(3)} ${[0, 0.1, 0.5, 0.9, 0.999].map((p) => String(q(m, p)).padStart(6)).join(' ')}   par range ${par(q(m, 0))}..${par(q(m, 0.999))}, ref<=5: ${trivial}, trivial ${r.naive}/${m.length}, spread ${r.spread}/${m.length}`);
}
// Share of visible farms under each candidate reroll floor (the floors live in packages/sim/src/brief.ts).
if (process.env.FLOORS) for (const [g, r] of rows) console.log(`${g}: visible scores <floor ${process.env.FLOORS}: ${r.visible.filter((x) => x < Number(process.env.FLOORS)).length}/${r.visible.length}; lowest 5: ${[...r.visible].sort((a, b) => a - b).slice(0, 5).join(' ')}`);
