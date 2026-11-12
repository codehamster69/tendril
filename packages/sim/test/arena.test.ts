import { describe, expect, it } from 'vitest';
import {
  DAILY_EPOCH, DAILY_PAR, DAILY_TICKS, SEASON_TICKS, IllegalAction, challengeSetup, createWorld, dailyNumber, farmMosaic, hashWorld,
  netWorth, replayChunk, replayWithPar,
} from '../src/index.ts';
import { Driver, OP, farm, script } from './helpers.ts';

function recorded(seed = 31337) {
  const d = new Driver(farm(seed));
  script(d, 200);
  const end = d.w.tick + 20;
  d.advance(20);
  return { d, end };
}

describe('farmMosaic', () => {
  it('fresh farm is a barn on untilled ground', () => {
    const m = farmMosaic(createWorld(farm()));
    expect(m).toHaveLength(64);
    expect(m).toBe('B' + '0'.repeat(63));
  });
  it('shows tilled, crops, hive and composter row by row, and does not change the world', () => {
    const d = new Driver(farm(7), { coins: 1000, unlocks: 0b111111111 });
    d.do(0, OP.move, 1); d.do(0, OP.till);               // (1,0) tilled and empty
    d.do(0, OP.move, 1); d.do(0, OP.till); d.do(0, OP.plant, 2); // (2,0) wheat
    d.do(0, OP.move, 1); d.do(0, OP.build, 1);            // (3,0) hive
    d.do(0, OP.move, 1); d.do(0, OP.build, 2);            // (4,0) composter
    const before = hashWorld(d.w);
    const m = farmMosaic(d.w);
    expect(m.slice(0, 8)).toBe('Bt2hc000');
    expect(m.slice(8)).toBe('0'.repeat(56));
    expect(hashWorld(d.w)).toBe(before);
  });
});

describe('replayWithPar', () => {
  it('matches replayChunk exactly and is repeatable', () => {
    const { d, end } = recorded();
    const a = createWorld(farm(31337)), b = createWorld(farm(31337)), c = createWorld(farm(31337));
    replayChunk(a, d.log, end);
    const r1 = replayWithPar(b, d.log, end, 1), r2 = replayWithPar(c, d.log, end, 1);
    expect(hashWorld(b)).toBe(hashWorld(a));
    expect(r1.netWorth).toBe(netWorth(a));
    expect(r1.mosaic).toBe(farmMosaic(a));
    expect(r2).toEqual(r1);
  });
  it('parTick is the first tick net worth reached par', () => {
    const { d, end } = recorded();
    const final = netWorth(d.w);
    expect(final).toBeGreaterThan(0);
    // Independent oracle: step a fresh world through the log and look at net worth after every tick/action.
    const par = Math.max(1, Math.floor(final / 2));
    const w = createWorld(farm(31337));
    const replay = replayWithPar(w, d.log, end, par);
    let first: number | null = null;
    const o = new Driver(farm(31337));
    const seen = (): void => { if (first === null && netWorth(o.w) >= par) first = o.w.tick; };
    for (const e of d.log) {
      while (o.w.tick < e[0]) { o.advance(1); seen(); }
      o.do(e[1], e[2], e[3], e[4]); seen();
    }
    while (o.w.tick < end) { o.advance(1); seen(); }
    expect(first).not.toBeNull();
    expect(replay.parTick).toBe(first);
    expect(replay.parTick!).toBeGreaterThan(0);
    expect(replayWithPar(createWorld(farm(31337)), d.log, end, final).parTick).toBeLessThanOrEqual(end);
  });
  it('is null when par is out of reach and 0 when par is 0', () => {
    const { d, end } = recorded();
    expect(replayWithPar(createWorld(farm(31337)), d.log, end, netWorth(d.w) + 1).parTick).toBeNull();
    expect(replayWithPar(createWorld(farm(31337)), [], 50, 0).parTick).toBe(0);
  });
  it('rejects bad logs like replayChunk', () => {
    const w = () => createWorld(farm());
    expect(() => replayWithPar(w(), [[5, 0, OP.till]], 5, 10)).toThrow(IllegalAction);
    expect(() => replayWithPar(w(), [[3, 0, OP.till], [2, 0, OP.till]], 10, 10)).toThrow(IllegalAction);
    expect(() => replayWithPar(w(), [], -1, 10)).toThrow(IllegalAction);
    expect(() => replayWithPar(w(), [], 10, 1.5)).toThrow(IllegalAction);
    expect(() => replayWithPar(w(), ['x' as never], 10, 10)).toThrow(IllegalAction);
  });
});

describe('dailyNumber and constants', () => {
  it('counts UTC days from the epoch', () => {
    expect(DAILY_EPOCH).toBe('2026-12-01');
    expect(dailyNumber('2026-12-01')).toBe(1);
    expect(dailyNumber('2026-12-02')).toBe(2);
    expect(dailyNumber('2026-12-31')).toBe(31);
    expect(dailyNumber('2027-01-01')).toBe(32);
    expect(dailyNumber('2028-03-01')).toBe(dailyNumber('2028-02-28') + 2); // leap year
    expect(dailyNumber('2026-11-30')).toBe(0);
  });
  it('rejects bad dates', () => {
    for (const bad of ['2026-1-1', '2026-02-30', '2026-13-01', 'tomorrow', '']) expect(() => dailyNumber(bad)).toThrow();
  });
  it('par is a positive integer', () => { expect(Number.isSafeInteger(DAILY_PAR) && DAILY_PAR > 0).toBe(true); });
});

describe('challengeSetup', () => {
  it('returns the standard farm for every kind, and builds an identical world to no setup', () => {
    for (const kind of ['daily', 'season', 'duel'] as const) {
      const cs = challengeSetup(kind, 99);
      expect(cs.ticks).toBe(kind === 'season' ? SEASON_TICKS : DAILY_TICKS);
      expect(hashWorld(createWorld(farm(99), cs.setup))).toBe(hashWorld(createWorld(farm(99))));
    }
  });
  it('is pure and validates input', () => {
    expect(challengeSetup('daily', 5)).toEqual(challengeSetup('daily', 5));
    expect(() => challengeSetup('x' as never, 1)).toThrow();
    expect(() => challengeSetup('daily', 1.5)).toThrow();
  });
});
