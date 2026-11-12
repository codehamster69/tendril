// Test helper: runs a shipped example for a number of ticks and reports farm health.
// Usage: measureExample(source, [50_000, 100_000, 200_000]).
// Print a table for every example: HEALTH=1 pnpm exec vitest run test/example-health.test.ts
import { createRun } from '../src/index.ts';
import { createWorld, snapshot } from '@tendril/sim/src/index.ts';

export interface Health {
  tick: number; netWorth: number; plots: number; bots: number;
  moisture: number; nitrogen: number; fatigue: number; ripeUnharvested: number; errors: number;
}

export function measureExample(source: string, checkpoints: number[], seed = 7): Health[] {
  const run = createRun(createWorld({ id: 'health', seed }), source);
  const out: Health[] = [];
  for (const target of checkpoints) {
    while (run.world.tick < target) run.step(Math.min(10_000, target - run.world.tick));
    run.takeLog();
    const s = snapshot(run.world), n = s.tiles.length || 1;
    const avg = (f: (t: (typeof s.tiles)[number]) => number) => Math.round(s.tiles.reduce((a, t) => a + f(t), 0) / n);
    out.push({
      tick: target, netWorth: s.netWorth, plots: s.plots.length, bots: s.bots.length,
      moisture: avg((t) => t.moisture), nitrogen: avg((t) => t.nitrogen), fatigue: avg((t) => t.fatigue),
      ripeUnharvested: s.tiles.filter((t) => t.crop > 0 && t.stage >= 3).length, errors: run.errors.length,
    });
  }
  run.close();
  return out;
}

