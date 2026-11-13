import { describe, expect, it } from 'vitest';
import {
  ALGO_VERSION, DAILY_CAP, PLACEMENT_EVENTS, SEASON_CAP, START_RATING, TIERS, rateContest, tierOf, type Standing,
} from '../src/index.ts';
import { ELO_TABLE } from '../src/elo-table.ts';

const field = (n: number, rating = 1500, events = 10): Standing[] =>
  Array.from({ length: n }, (_, i) => ({ id: `u${String(i).padStart(3, '0')}`, place: i + 1, rating, events }));
const rate = (standings: Standing[], weight = 1) => rateContest({ standings, weight, algoVersion: ALGO_VERSION });

describe('constants and table', () => {
  it('has the plan values', () => {
    expect(START_RATING).toBe(1200);
    expect(PLACEMENT_EVENTS).toBe(5);
    expect(TIERS.map((t) => [t.name, t.floor])).toEqual([
      ['Seed', 0], ['Seedling', 1000], ['Shoot', 1200], ['Vine', 1400], ['Bloom', 1600], ['Orchard', 1800], ['Grove', 2000], ['Evergreen', 2300],
    ]);
  });
  it('stored Elo table is whole numbers and matches the formula within 1', () => {
    expect(ELO_TABLE[0]).toBe(500000);
    expect(ELO_TABLE[400]).toBe(909091);
    expect(ELO_TABLE.length).toBe(2401);
    for (let d = 0; d < ELO_TABLE.length; d++) {
      expect(Number.isInteger(ELO_TABLE[d])).toBe(true);
      expect(Math.abs(ELO_TABLE[d]! - 1e6 / (1 + Math.pow(10, -d / 400)))).toBeLessThanOrEqual(1);
    }
  });
});

describe('tierOf', () => {
  it.each([
    [0, 'seed', 0, 1000], [999, 'seed', 0, 1000], [1000, 'seedling', 1000, 1200], [1199, 'seedling', 1000, 1200],
    [1200, 'shoot', 1200, 1400], [1400, 'vine', 1400, 1600], [1799, 'bloom', 1600, 1800], [1800, 'orchard', 1800, 2000],
    [2000, 'grove', 2000, 2300], [2299, 'grove', 2000, 2300], [2300, 'evergreen', 2300, null], [3500, 'evergreen', 2300, null],
  ])('%i', (r, key, floor, next) => {
    expect(tierOf(r)).toMatchObject({ key, floor, next });
  });
});

describe('rateContest fixed vectors', () => {
  it('equal ratings, 8 established, all tied: no change', () => {
    const s = field(8).map((x) => ({ ...x, place: 1 }));
    expect(rate(s).every((c) => c.delta === 0 && c.rating === 1500)).toBe(true);
  });
  it('equal ratings, 10 established, strict order: fixed values, zero-sum', () => {
    const out = rate(field(10));
    expect(out.map((c) => c.performance)).toEqual([1802, 1684, 1615, 1563, 1520, 1481, 1445, 1411, 1376, 1342]);
    expect(out.map((c) => c.delta)).toEqual([49, 28, 15, 7, -1, -7, -13, -20, -26, -32]);
  });
  it('rejects wrong algo version, duplicates and bad input', () => {
    expect(() => rateContest({ standings: field(8), weight: 1, algoVersion: 99 })).toThrow();
    expect(() => rate([...field(8), { id: 'u000', place: 9, rating: 1500, events: 9 }])).toThrow(/duplicate/);
    expect(() => rate([{ id: 'a', place: 1, rating: 1500.5, events: 9 }])).toThrow();
  });
  it('field under 8 is unrated', () => {
    expect(rate(field(7))).toEqual([]);
  });
});

describe('weights and caps', () => {
  it('field-size weight scales a small field gently', () => {
    const small = rate(field(8)).find((c) => c.id === 'u000')!.delta;
    const full = rate(field(30)).find((c) => c.id === 'u000')!.delta;
    expect(small).toBeGreaterThan(0);
    expect(small).toBeLessThan(full / 2);
  });
  it('season counts 1.5x and caps at 200, daily caps at 150', () => {
    const s = field(40, 1500, 10).map((x, i) => (i === 39 ? { ...x, rating: 400, place: 1 } : { ...x, place: i + 2 }));
    const day = rate(s, 1).find((c) => c.id === 'u039')!;
    const season = rate(s, 1.5).find((c) => c.id === 'u039')!;
    expect(day.delta).toBeGreaterThan(100);
    expect(season.delta).toBeGreaterThan(day.delta);
    const huge = field(60, 1500, 10).map((x, i) => (i === 59 ? { ...x, rating: 0, place: 1 } : { ...x, place: i + 2 }));
    const cap = (w: number) => rate(huge, w).find((c) => c.id === 'u059')!.delta;
    expect(cap(1)).toBeLessThanOrEqual(DAILY_CAP + 2);
    expect(cap(1.5)).toBeLessThanOrEqual(SEASON_CAP + 2);
    expect(cap(1.5)).toBeGreaterThan(DAILY_CAP);
  });
  it('placement multiplier boosts early events', () => {
    const mk = (events: number) => field(20, 1200, 10).map((x, i) => (i === 10 ? { ...x, events, rating: 1400 } : { ...x, rating: 1500 }));
    const d = (e: number) => rate(mk(e)).find((c) => c.id === 'u010')!.delta;
    expect(d(0)).toBeGreaterThan(d(2));
    expect(d(2)).toBeGreaterThan(d(4));
    expect(d(4)).toBeGreaterThan(d(5));
  });
});

describe('field rules', () => {
  it('established changes sum to zero', () => {
    const s = field(50, 1300, 10).map((x, i) => ({ ...x, rating: 1000 + ((i * 37) % 700) }));
    const out = rate(s);
    expect(out.reduce((t, c) => t + c.delta, 0)).toBe(0);
  });
  it('once 30 established exist, placement accounts are not in the field', () => {
    const real = field(30, 1500, 10).map((x, i) => ({ ...x, rating: 1300 + i * 10 }));
    const withFakes: Standing[] = [
      ...real,
      ...Array.from({ length: 40 }, (_, i) => ({ id: `z${i}`, place: 31 + i, rating: 1200, events: 0 })),
    ];
    const a = rate(real);
    const b = rate(withFakes).filter((c) => c.id.startsWith('u'));
    expect(b).toEqual(a);
  });
  it('under 30 established, placement accounts are in the field', () => {
    const real = field(10, 1500, 10);
    const more = [...real, ...Array.from({ length: 5 }, (_, i) => ({ id: `z${i}`, place: 11 + i, rating: 1200, events: 0 }))];
    expect(rate(more).filter((c) => c.id.startsWith('u'))).not.toEqual(rate(real));
  });
  it('ties share the average place', () => {
    const tied = field(10).map((x, i) => ({ ...x, place: i < 2 ? 1 : i }));
    const out = rate(tied);
    const a = out.find((c) => c.id === 'u000')!, b = out.find((c) => c.id === 'u001')!;
    expect(a).toEqual({ ...b, id: 'u000' });
  });
  it('beating weak accounts is worth almost nothing (field already at full weight)', () => {
    const rivals: Standing[] = Array.from({ length: 39 }, (_, i) => ({ id: `r${i}`, place: 2 + i, rating: 1800, events: 20 }));
    const base: Standing[] = [{ id: 'hero', place: 1, rating: 1800, events: 20 }, ...rivals];
    const weak = Array.from({ length: 50 }, (_, i) => ({ id: `w${i}`, place: 41 + i, rating: 600, events: 20 }));
    const d0 = rate(base).find((c) => c.id === 'hero')!.delta;
    const d1 = rate([...base, ...weak]).find((c) => c.id === 'hero')!.delta;
    expect(Math.abs(d1 - d0)).toBeLessThan(10);
  });
});

describe('determinism', () => {
  const mixed = (): Standing[] => {
    let a = 12345;
    const rnd = () => ((a = (Math.imul(a, 1103515245) + 12345) >>> 0) / 4294967296);
    return Array.from({ length: 300 }, (_, i) => ({
      id: `p${i}`, place: 1 + Math.floor(i / 2), rating: 800 + Math.floor(rnd() * 1200), events: Math.floor(rnd() * 12),
    }));
  };
  it('input order does not matter', () => {
    const s = mixed();
    const base = JSON.stringify(rate(s));
    const rev = [...s].reverse();
    const shuf = [...s].sort((x, y) => ((x.id.length * 7 + x.rating) % 13) - ((y.id.length * 7 + y.rating) % 13) || y.rating - x.rating);
    expect(JSON.stringify(rate(rev))).toBe(base);
    expect(JSON.stringify(rate(shuf))).toBe(base);
  });
  it('repeat runs are identical and do not mutate input', () => {
    const s = mixed();
    const copy = JSON.stringify(s);
    const a = JSON.stringify(rate(s));
    for (let i = 0; i < 5; i++) expect(JSON.stringify(rate(s))).toBe(a);
    expect(JSON.stringify(s)).toBe(copy);
  });
  it('golden digest of a 300-player contest', () => {
    let h = 2166136261;
    for (const ch of JSON.stringify(rate(mixed()))) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    expect(h).toBe(GOLDEN);
  });
});

describe('speed', () => {
  it('rates 10,000 players well under a second', () => {
    const s: Standing[] = Array.from({ length: 10000 }, (_, i) => ({
      id: `p${i}`, place: i + 1, rating: 600 + ((i * 7919) % 1800), events: 10,
    }));
    const t = performance.now();
    const out = rate(s);
    const ms = performance.now() - t;
    expect(out).toHaveLength(10000);
    expect(ms).toBeLessThan(1000);
  });
});

const GOLDEN = 4011394413;
