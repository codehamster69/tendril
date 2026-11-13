import { describe, expect, it } from 'vitest';
import { ALGO_VERSION, rateContest } from '../src/index.ts';

// R9: characterises the two known ring leaks of the documented algorithm (accepted; see brain/notes/R9.md). If the numbers move, the algorithm moved.
const run = (standings: { id: string; place: number; rating: number; events: number }[]) => rateContest({ standings, weight: 1, algoVersion: ALGO_VERSION });

describe('ring leaks (accepted, documented)', () => {
  const real = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, place: i + 1, rating: 1200, events: 9 }));
  it('established fakes that reached par raise the field-size weight: the same result moves ratings further', () => {
    const fakes = Array.from({ length: 20 }, (_, i) => ({ id: `f${i}`, place: 11 + i, rating: 1200, events: 9 }));
    const alone = run(real).find((c) => c.id === 'r0')!.delta;
    const padded = run([...real, ...fakes]).find((c) => c.id === 'r0')!.delta;
    expect(padded).toBeGreaterThan(alone * 2);
  });
  it('dummy donors: a hero 800 above 40 established dummies still gets a bounded daily lift (zero-sum shift), well under the cap', () => {
    const dummies = Array.from({ length: 40 }, (_, i) => ({ id: `d${i}`, place: 2 + i, rating: 1200, events: 9 }));
    const hero = run([{ id: 'h', place: 1, rating: 2000, events: 9 }, ...dummies]).find((c) => c.id === 'h')!;
    expect(hero.delta).toBeGreaterThan(0);
    expect(hero.delta).toBeLessThan(100);
  });
  it('placement fakes beside 30 established players have no effect on the established', () => {
    const est = Array.from({ length: 30 }, (_, i) => ({ id: `e${i}`, place: i + 1, rating: 1200, events: 9 }));
    const place = Array.from({ length: 50 }, (_, i) => ({ id: `p${i}`, place: 31 + i, rating: 1200, events: 1 }));
    const a = run(est), b = run([...est, ...place]);
    expect(b.filter((c) => c.id.startsWith('e')).map((c) => c.delta)).toEqual(a.map((c) => c.delta));
  });
});
