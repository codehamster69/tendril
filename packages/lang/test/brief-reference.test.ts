// K2: the reference program of each goal copes with every brief (twists included), reaches the par it sets, and the reroll rule holds.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { briefFloor, challengeSetup, createWorld, finalOf, HIDDEN_FARMS, MAX_REROLLS, pickBrief, replayWithGoal, rerollSeed, RULES_VERSION, SETUP_BRIEF } from '@tendril/sim/src/index.ts';
import type { GoalKind } from '@tendril/sim/src/index.ts';
import { createRun } from '../src/engine.ts';

const GOALS: GoalKind[] = ['wealth', 'festival', 'specialist', 'orders', 'inherited'];
const source = (g: GoalKind): string => readFileSync(new URL(`../examples/brief-${g}.sprout`, import.meta.url), 'utf8');
const fnv = (s: string): number => { let h = 0x811c9dc5; for (const b of new TextEncoder().encode(s)) { h ^= b; h = Math.imul(h, 0x01000193); } return (h >>> 0) || 1; };

function play(g: GoalKind, kind: 'daily' | 'season', briefSeed: number, worldSeed: number, par = Number.MAX_SAFE_INTEGER) {
  const cs = challengeSetup(kind, briefSeed, SETUP_BRIEF, null, RULES_VERSION);
  const run = createRun(createWorld({ id: 't', seed: worldSeed }, cs.setup), source(g));
  run.step(cs.ticks);
  const actions = run.pending.filter((a) => a[0] < cs.ticks);
  const errors = run.errors.map((e) => e.message);
  run.close();
  const r = replayWithGoal(createWorld({ id: 't', seed: worldSeed }, cs.setup), actions, cs.ticks, cs.brief!.goal, par);
  return { ...r, errors, goal: cs.brief!.goal.kind, ticks: cs.ticks };
}

describe('reference programs', () => {
  it('run without errors on every goal and twist, and score above the reroll floor most days', () => {
    const seen = new Set<GoalKind>();
    let below = 0, total = 0;
    for (let i = 0; i < 120; i++) {
      const seed = fnv(`tendril-brief:test:d-${i}`);
      const g = challengeSetup('daily', seed, SETUP_BRIEF).brief!.goal.kind;
      const r = play(g, 'daily', seed, seed);
      expect(r.errors, `d-${i} ${g}`).toEqual([]);
      seen.add(g);
      total++;
      if (r.score < briefFloor('daily', g)) below++;
    }
    expect([...seen].sort()).toEqual([...GOALS].sort());
    expect(below / total).toBeLessThan(0.15);
  }, 120_000);

  it('reach 90% of their own mean over the visible and hidden farms (par is reachable by the program that set it)', () => {
    for (const kind of ['daily', 'season'] as const) {
      for (let i = 0; i < (kind === 'daily' ? 15 : 5); i++) {
        const seed = fnv(`tendril-brief:test2:${kind[0]}-${i}`);
        const g = challengeSetup(kind, seed, SETUP_BRIEF).brief!.goal.kind;
        const farms = [seed, ...Array.from({ length: HIDDEN_FARMS[kind] }, (_, h) => fnv(`tendril-brief:test2:${kind[0]}-${i}:h${h + 1}`))];
        const first = farms.map((w) => play(g, kind, seed, w));
        const par = Math.max(1, Math.floor((first.reduce((a, r) => a + r.score, 0) / farms.length) * 90 / 100));
        const again = farms.map((w) => play(g, kind, seed, w, par));
        const f = finalOf(again.map((r) => r.score), again.map((r) => r.parTick), again[0]!.ticks, par);
        expect(f.finalScore, `${kind} ${i} ${g}`).toBeGreaterThanOrEqual(par * farms.length);
        expect(f.finalParTick, `${kind} ${i} ${g}`).not.toBeNull();
      }
    }
  }, 120_000);
});

describe('reroll rule', () => {
  it('derives deterministic, distinct seeds and refuses bad tries', () => {
    const seeds = Array.from({ length: MAX_REROLLS + 1 }, (_, n) => rerollSeed(12345, n));
    expect(seeds[0]).toBe(12345);
    expect(new Set(seeds).size).toBe(MAX_REROLLS + 1);
    expect(seeds).toEqual(Array.from({ length: MAX_REROLLS + 1 }, (_, n) => rerollSeed(12345, n)));
    expect(() => rerollSeed(1, MAX_REROLLS + 1)).toThrow();
  });
  it('keeps the first draw that clears its floor, else the best of nine', () => {
    const calls: number[] = [];
    const ok = pickBrief('daily', 777, (s, b) => { calls.push(s); return briefFloor('daily', b.goal.kind); });
    expect(ok.tries).toBe(1);
    expect(ok.seed).toBe(777);
    const scores = [0, 5, 3, 9, 1, 2, 4, 8, 6];
    let n = 0;
    const worst = pickBrief('daily', 777, () => scores[n++]!);
    expect(n).toBe(MAX_REROLLS + 1);
    expect(worst.seed).toBe(rerollSeed(777, 3));
    expect(worst.score).toBe(9);
    // a day that clears on the third draw stops there
    let m = 0;
    const third = pickBrief('daily', 777, (_s, b) => (++m < 3 ? 0 : briefFloor('daily', b.goal.kind)));
    expect(third.tries).toBe(3);
    expect(third.seed).toBe(rerollSeed(777, 2));
  });
});
