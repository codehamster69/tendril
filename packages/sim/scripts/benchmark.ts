// Explicit, sequential performance gate; never imported by the correctness suite.
// From workspace root: node --experimental-strip-types packages/sim/scripts/benchmark.ts
import { ok, strictEqual } from 'node:assert';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  createLuaRun, createWorld, deserialize, hashWorld, netWorth, replayChunk, serialize,
} from '../src/local.ts';
import { Driver, OP, farm } from '../test/helpers.ts';
import { assertSameWorld } from '../test/replay-helpers.ts';

const measurements: { name: string; ms: number; budgetMs?: number; pass: boolean }[] = [];
function timing(name: string, ms: number, budgetMs?: number): void {
  const pass = budgetMs === undefined || ms < budgetMs;
  const result = { name, ms: Math.round(ms * 100) / 100, budgetMs, pass };
  measurements.push(result);
  console.log(JSON.stringify(result));
}

console.log(`Performance command: node --experimental-strip-types packages/sim/scripts/benchmark.ts (node ${process.version}; no retries)`);

const d = new Driver(farm(2024));
d.do(0, OP.move, 1);
const cycle = [() => d.do(0, OP.till), () => d.do(0, OP.plant, 2), () => d.do(0, OP.water),
  () => d.do(0, OP.harvest), () => d.do(0, OP.wait, 242)];
for (let i = 0; d.log.length < 20_000; i++) cycle[i % 5]!();
const end = Math.max(1_000_000, d.w.tick + 1);
d.advance(end - d.w.tick);
const replay = createWorld(farm(2024));
const replayStart = performance.now();
replayChunk(replay, d.log, end);
timing('replay: 1,000,000 ticks / 20,000 actions', performance.now() - replayStart, 2000);
strictEqual(replay.tick, end);
assertSameWorld(replay, d.w, 'benchmark replay');

const example = (name: string) => readFileSync(new URL(`../examples/${name}.lua`, import.meta.url), 'utf8');
const starterStart = performance.now();
const starter = await createLuaRun(createWorld(farm(7)), example('starter'));
try {
  starter.step(100_000);
  const starterFirst = starter.takeLog();
  starter.step(100_000);
  const starterSecond = starter.takeLog();
  timing('starter: 200,000 ticks (reference, not gated)', performance.now() - starterStart);
  strictEqual(starter.errors.length, 0);
  const starterReplay = createWorld(farm(7));
  replayChunk(starterReplay, [...starterFirst, ...starterSecond], 200_000);
  assertSameWorld(starterReplay, starter.world, 'benchmark starter full replay');
  const starterChunked = createWorld(farm(7));
  replayChunk(starterChunked, starterFirst, 100_000);
  const starterCheckpoint = deserialize(serialize(starterChunked));
  replayChunk(starterCheckpoint, starterSecond, 200_000);
  assertSameWorld(starterCheckpoint, starter.world, 'benchmark starter checkpoint/chunk replay');

  const expanderStart = performance.now();
  const expander = await createLuaRun(createWorld(farm(7)), example('expander'));
  try {
    expander.step(100_000);
    const first = expander.takeLog();
    expander.step(100_000);
    const second = expander.takeLog();
    timing('expander: 200,000 ticks (including engine startup)', performance.now() - expanderStart, 20_000);
    strictEqual(expander.errors.length, 0);
    ok(expander.world.plots.length > 1);
    ok(expander.world.bots.length > 1);
    ok(netWorth(expander.world) > netWorth(starter.world));
    const full = createWorld(farm(7));
    replayChunk(full, [...first, ...second], 200_000);
    assertSameWorld(full, expander.world, 'benchmark expander full replay');
    const chunked = createWorld(farm(7));
    replayChunk(chunked, first, 100_000);
    const checkpoint = deserialize(serialize(chunked));
    replayChunk(checkpoint, second, 200_000);
    assertSameWorld(checkpoint, expander.world, 'benchmark expander checkpoint/chunk replay');
    console.log(JSON.stringify({ correctness: 'PASS', hash: hashWorld(full), worth: netWorth(full),
      plots: full.plots.length, bots: full.bots.length, actions: first.length + second.length }));
  } finally {
    expander.close();
  }
} finally {
  starter.close();
}
const pass = measurements.every((result) => result.pass);
console.log(`Performance gate: ${pass ? 'PASS' : 'FAIL'} (strict original budgets; no retries)`);
if (!pass) process.exitCode = 1;
