import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, deserialize, hashWorld, serialize } from '@tendril/sim/src/index.ts';
import { createRun } from '@tendril/lang/src/index.ts';
import { dryRows, dryRun, dryRunSync, dryVerdict } from './dry-run-core.ts';

// A farm that has already been running for a while: some land tilled and planted.
const grown = (): string => {
  const w = createWorld({ id: 'farm', seed: 7 });
  const run = createRun(w, 'move east\ntill\nplant carrot\n');
  run.step(500);
  run.close();
  return serialize(w);
};

const farmer = [
  'while true:',
  '    for each x in [1, 2, 3]:',
  '        go_to x, 0',
  '        if scan().ripe:',
  '            harvest',
  '        if scan().empty:',
  '            till',
  '            plant carrot',
  '    go_to barn',
  '    deposit',
  '    sell carrot, all',
  '    wait 20',
].join('\n');
const pacer = 'while true:\n    move east\n    move west\n';

describe('dry run', () => {
  it('leaves the saved farm untouched and is deterministic', () => {
    const world = grown();
    const hash = hashWorld(deserialize(world));
    const a = dryRunSync({ world, before: pacer, after: farmer, ticks: 2000 });
    const b = dryRunSync({ world, before: pacer, after: farmer, ticks: 2000 });
    assert.deepEqual(a, b);
    assert.equal(hashWorld(deserialize(world)), hash);
    assert.equal(a.startTick, 500);
  });

  it('measures real effects: a farming program earns, a pacing one walks', () => {
    const r = dryRunSync({ world: grown(), before: pacer, after: farmer, ticks: 3000 });
    assert.ok(r.before && r.after);
    assert.equal(r.before.coinsPer1000, 0);
    assert.ok(r.before.walkShare > 0.95, `pacer walks ${r.before.walkShare}`);
    assert.ok(r.after.coinsPer1000 > 0, `farmer earns ${r.after.coinsPer1000}`);
    assert.ok(r.after.harvests > 0 && r.after.sales > 0);
    assert.ok(r.after.walkShare > 0 && r.after.walkShare < r.before.walkShare);
    assert.equal(r.after.crashes, 0);
    assert.equal(r.after.ticks, 3000);
    const rows = dryRows(r);
    assert.equal(rows[0]!.better, true); // coins
    assert.equal(rows[3]!.better, true); // less walking
    assert.match(dryVerdict(r), /faster/);
  });

  it('counts the plots a program buys', () => {
    const world = (() => { const w = createWorld({ id: 'farm', seed: 3 }); w.coins = 5000; return serialize(w); })();
    const r = dryRunSync({ world, before: null, after: 'buy_plot 1, 0\n', ticks: 100 });
    assert.equal(r.before!.plots.end, 1);
    assert.equal(r.after!.plots.end, 2);
    assert.ok(r.after!.coinsPer1000 < 0, 'land costs coins');
  });

  it('reports bots that crash, with the line', () => {
    const r = dryRunSync({ world: grown(), before: farmer, after: 'move east\nitems = [1]\nsay items[5]\n', ticks: 200 });
    assert.equal(r.after!.crashes, 1);
    assert.equal(r.after!.firstCrash!.line, 3);
    assert.equal(r.before!.crashes, 0);
    assert.match(dryVerdict(r), /stops on an error/);
    assert.match(dryRows(r)[4]!.hint ?? '', /^Line 3:/);
  });

  it('does not run code that does not compile', () => {
    const r = dryRunSync({ world: grown(), before: farmer, after: 'while true\n    move east\n', ticks: 500 });
    assert.equal(r.after, null);
    assert.ok(r.diagnostics.some((d) => d.severity === 'error'));
    assert.ok(r.before && r.before.ticks === 500);
    assert.match(dryVerdict(r), /errors/);
  });

  it('reports progress over both runs and rejects silly spans', () => {
    const it = dryRun({ world: grown(), before: pacer, after: farmer, ticks: 1000 });
    const seen: [number, number][] = [];
    for (let r = it.next(); !r.done; r = it.next()) seen.push(r.value);
    assert.deepEqual(seen.at(-1), [2000, 2000]);
    assert.ok(seen.every(([d, t], i) => t === 2000 && (i === 0 || d > seen[i - 1]![0])));
    assert.throws(() => dryRunSync({ world: grown(), before: null, after: farmer, ticks: 0 }));
    assert.throws(() => dryRunSync({ world: grown(), before: null, after: farmer, ticks: 50_000 }));
  });
});
