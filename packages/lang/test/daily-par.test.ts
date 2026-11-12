// F1: par comes from the bundled reference program, so the reference must reach it every day.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DAILY_EPOCH, MODIFIER_BOUNDS, PAR_MIN, BASE_RULES_VERSION, SETUP_VERSION, challengeSetup, createWorld, dailySeed, parFromReference, replayWithPar,
} from '@tendril/sim/src/index.ts';
import { createRun } from '../src/index.ts';
import { verifySource } from '../src/verify.ts';

const reference = readFileSync(new URL('../examples/daily.sprout', import.meta.url), 'utf8');
const addDays = (date: string, n: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe('365 days of generated dailies', () => {
  it('the reference program reaches the par derived from itself every day, and every day is playable', () => {
    const worths: number[] = [];
    const lengths = new Set<number>();
    for (let n = 0; n < 365; n++) {
      const date = addDays(DAILY_EPOCH, n);
      const seed = dailySeed(date);
      const cs = challengeSetup('daily', seed);
      lengths.add(cs.ticks);
      const id = `d-${date}`;
      const verdict = verifySource({ source: reference, challengeId: id, kind: 'daily', seed, ticks: cs.ticks, rulesVersion: BASE_RULES_VERSION, setupVersion: SETUP_VERSION });
      expect(verdict.ok, date).toBe(true);
      if (!verdict.ok) continue;
      const run = createRun(createWorld({ id, seed }, cs.setup), reference);
      run.step(cs.ticks);
      const actions = run.pending.filter((a) => a[0] < cs.ticks);
      run.close();
      const par = parFromReference(verdict.netWorth);
      const replay = replayWithPar(createWorld({ id, seed }, cs.setup), actions, cs.ticks, par);
      expect(replay.netWorth, date).toBe(verdict.netWorth);
      expect(replay.parTick, `${date}: reference reaches par ${par}`).not.toBeNull();
      expect(par, date).toBeGreaterThanOrEqual(PAR_MIN);
      worths.push(verdict.netWorth);
    }
    // Every tick budget is drawn, and no day starves the reference: the worst day still earns a real par.
    expect([...lengths].sort()).toEqual([...MODIFIER_BOUNDS.ticks].sort());
    expect(Math.min(...worths)).toBeGreaterThan(100);
  }, 120_000);
});
