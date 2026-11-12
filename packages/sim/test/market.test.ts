import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MARKET, MARKET_EPOCH, applyAction, baseMarket, blendedTarget, challengeSetup, createWorld, dailyNumber, dailyRulesVersion, dailySeed,
  daysUntilMarket, deserialize, tickWorld, hashWorld, isMarketTable, marketActive, marketPrices, netWorth, nextMarket, nextMultipliers, observedShares,
  price, rawTarget, replayChunk, replayStats, replayWithPar, serialize, ITEMS, OP, RULES_VERSION, BASE_RULES_VERSION, SUPPORTED_RULES_VERSIONS,
} from '../src/index.ts';
import type { MarketRow, MarketTable } from '../src/index.ts';
// The reference implementation E1a simulated the month with. The TypeScript port must agree with it exactly.
// @ts-expect-error plain JS without types
import * as ref from '../../../brain/notes/E1a-market-sim.mjs';
import { Driver, farm, round, script } from './helpers.ts';

const BASE_P = [0, 200, 300, 100, 600, 400, 500, 800];
const rng = (seed: number) => () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };

/** A world with a stocked barn: everything sellable without farming. */
function stocked(prices?: number[]) {
  const w = createWorld(farm(7), prices ? { prices } : undefined);
  for (let i = 1; i <= 7; i++) w.stock[i] = 10;
  return w;
}

describe('rules v4: prices as an input', () => {
  it('versions', () => {
    expect(RULES_VERSION).toBe(4);
    expect(BASE_RULES_VERSION).toBe(3);
    expect(SUPPORTED_RULES_VERSIONS).toEqual([3, 4]);
  });

  it('a world without prices plays exactly as v3 and base prices in centicoins equal the v3 numbers', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((i) => price(createWorld(farm()), i))).toEqual([200, 300, 100, 600, 400, 500, 800, 0]);
    const replayed = createWorld(farm(99)), plain = new Driver(farm(99)), withBase = new Driver(farm(99), { prices: BASE_P });
    script(plain, 40); replayChunk(withBase.w, plain.log, plain.w.tick + 1); replayChunk(replayed, plain.log, plain.w.tick + 1);
    expect(netWorth(withBase.w)).toBe(netWorth(replayed));
    expect(withBase.w.coins).toBe(replayed.coins);
    expect(hashWorld(withBase.w)).not.toBe(hashWorld(replayed)); // the table is part of the state
  });

  it('floors every sale and every valuation; a sale may pay 0 coins but still takes the stock', () => {
    const p = [0, 199, 99, 150, 1, 100000, 250, 801];
    const w = stocked(p);
    const sell = (item: number, n: number): number => { while (w.bots[0]!.busyUntil > w.tick) tickWorld(w); return applyAction(w, [w.tick, 0, OP.sell, item, n]); };
    expect(sell(1, 1)).toBe(1);        // floor(199/100)
    expect(sell(2, 1)).toBe(0);        // floor(99/100): legal, the stock still goes
    expect(w.stock[2]).toBe(9);
    expect(sell(3, 3)).toBe(4);        // floor(450/100)
    expect(sell(4, 10)).toBe(0);       // floor(10/100)
    expect(sell(5, 10)).toBe(10000);
    expect(sell(6, 10)).toBe(25);
  });

  it('selling in pieces never gains over selling at once or over the valuation', () => {
    const p = [0, 199, 99, 150, 1, 333, 250, 801];
    const whole = stocked(p), pieces = stocked(p);
    const start = netWorth(whole);
    const sell = (w: ReturnType<typeof stocked>, i: number, n: number): void => { while (w.bots[0]!.busyUntil > w.tick) tickWorld(w); applyAction(w, [w.tick, 0, OP.sell, i, n]); };
    for (let i = 1; i <= 7; i++) sell(whole, i, 10);
    for (let i = 1; i <= 7; i++) for (let k = 0; k < 10; k++) sell(pieces, i, 1);
    expect(whole.coins).toBe(start);
    expect(pieces.coins).toBeLessThanOrEqual(whole.coins);
    expect(netWorth(whole)).toBe(start);
  });

  it('net worth values stock at the day\'s prices', () => {
    const w = stocked([0, 400, 300, 100, 600, 400, 500, 800]);
    expect(netWorth(w)).toBe(10 * (4 + 3 + 1 + 6 + 4 + 5 + 8));
    expect(netWorth(stocked())).toBe(10 * (2 + 3 + 1 + 6 + 4 + 5 + 8));
  });

  it('orders keep paying the base price (the documented hedge)', () => {
    const base = createWorld(farm(5)), market = createWorld(farm(5), { prices: [0, 400, 600, 200, 1200, 800, 1000, 1600] });
    for (const w of [base, market]) for (let i = 0; i < 400; i++) { w.tick++; }
    // order generation is the same stream whatever the table
    const a = new Driver(farm(5)), b = new Driver(farm(5), { prices: [0, 400, 600, 200, 1200, 800, 1000, 1600] });
    a.advance(2000); b.advance(2000);
    expect(b.w.orders).toEqual(a.w.orders);
  });

  it('rejects bad tables', () => {
    const bad: unknown[] = [[0, 1, 1, 1, 1, 1, 1], [0, 0, 1, 1, 1, 1, 1, 1], [0, 1, 1, 1, 1, 1, 1, 100001], [0, 1.5, 1, 1, 1, 1, 1, 1], 'x', [0, 1, 1, 1, 1, 1, 1, NaN]];
    for (const prices of bad) expect(() => createWorld(farm(), { prices: prices as number[] })).toThrow('bad setup prices');
    expect(() => createWorld(farm(), { prices: [0, 1, 1, 1, 1, 1, 1, 100000] })).not.toThrow();
  });

  it('price() is 0 for compost and out-of-range items', () => {
    const w = createWorld(farm(), { prices: [0, 1, 2, 3, 4, 5, 6, 7] });
    expect([0, 1, 7, 8, 9, -1, 1.5].map((i) => price(w, i))).toEqual([0, 1, 7, 0, 0, 0, 0]);
  });

  it('serialize round-trips with and without prices and dispatches the version by data', () => {
    const plain = new Driver(farm(3)); script(plain, 30);
    const s3 = serialize(plain.w);
    expect(JSON.parse(s3).rulesVersion).toBe(3);
    expect(JSON.parse(s3).prices).toBeUndefined();
    expect(hashWorld(deserialize(s3))).toBe(hashWorld(plain.w));
    const mk = new Driver(farm(3), { prices: [0, 220, 270, 90, 640, 410, 460, 900] }); script(mk, 30);
    const s4 = serialize(mk.w);
    expect(JSON.parse(s4).rulesVersion).toBe(4);
    const back = deserialize(s4);
    expect(back.prices).toEqual(mk.w.prices);
    expect(hashWorld(back)).toBe(hashWorld(mk.w));
    expect(netWorth(back)).toBe(netWorth(mk.w));
    expect(() => deserialize(JSON.stringify({ ...JSON.parse(s4), rulesVersion: 3 }))).toThrow();
    expect(() => deserialize(JSON.stringify({ ...JSON.parse(s3), rulesVersion: 4 }))).toThrow();
    expect(() => deserialize(JSON.stringify({ ...JSON.parse(s3), rulesVersion: 5 }))).toThrow('unsupported rules version');
    expect(() => deserialize(JSON.stringify({ ...JSON.parse(s4), prices: [0, 0, 1, 1, 1, 1, 1, 1] }))).toThrow('bad prices');
  });

  it('replays: a market log replays to the same hash in chunks (client) and in one go (server)', () => {
    const setup = { prices: [0, 150, 450, 80, 900, 200, 700, 400] };
    const d = new Driver(farm(21), setup); script(d, 60); d.advance(1);
    const end = d.w.tick;
    const whole = createWorld(farm(21), setup); replayChunk(whole, d.log, end);
    expect(hashWorld(whole)).toBe(hashWorld(d.w));
    const half = createWorld(farm(21), setup); const mid = Math.floor(end / 2);
    replayChunk(half, d.log.filter((e) => e[0] < mid), mid);
    const resumed = deserialize(serialize(half));
    replayChunk(resumed, d.log.filter((e) => e[0] >= mid), end);
    expect(hashWorld(resumed)).toBe(hashWorld(d.w));
  });
});

describe('replayStats', () => {
  it('counts units that really left the stock, not orders and not failed sales', () => {
    const d = new Driver(farm(11)); script(d, 40);
    const sold = replayStats(createWorld(farm(11)), d.log, d.w.tick + 1);
    expect(sold).toHaveLength(8);
    const sells = d.log.filter((e) => e[2] === OP.sell);
    expect(sold[1]).toBeGreaterThan(0);
    expect(sold[1]).toBeLessThanOrEqual(sells.reduce((n, e) => n + (e[4] ?? 0), 0));
    expect(sold.slice(2)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('ignores a sale the barn rule refuses and a sale of more than the stock', () => {
    const w = createWorld(farm(1));
    w.stock[1] = 5;
    const sold = replayStats(w, [[0, 0, OP.sell, 1, 9], [1, 0, OP.sell, 1, 5], [2, 0, OP.sell, 1, 1]], 5);
    expect(sold[1]).toBe(5);
  });

  it('also counts under a table, and is returned by replayWithPar', () => {
    const w = createWorld(farm(1), { prices: [0, 1, 1, 1, 1, 1, 1, 1] });
    w.stock[2] = 4;
    const r = replayWithPar(w, [[0, 0, OP.sell, 2, 4]], 3, 0);
    expect(r.sold[2]).toBe(4);
    expect(r.netWorth).toBe(0);                                   // 4 wheat sold at 0.01 each pay 0
  });
});

describe('market table: pure helpers', () => {
  const player = (a: number[]): number[] => [0, ...a];

  it('observed shares: each player counts equally, under 10 players is null', () => {
    const nine = Array.from({ length: 9 }, () => player([10, 0, 0, 0, 0, 0, 0]));
    expect(observedShares(nine)).toEqual({ n: 9, sh: null });
    const ten = [...nine, player([0, 10, 0, 0, 0, 0, 0])];
    expect(observedShares(ten).sh).toEqual([0, 900, 100, 0, 0, 0, 0, 0]);
    // a dormant player (sold nothing) is not counted
    expect(observedShares([...ten, player([0, 0, 0, 0, 0, 0, 0])]).n).toBe(10);
  });

  it('a whale cannot move the shares beyond one player\'s weight', () => {
    const crowd = Array.from({ length: 19 }, () => player([10, 10, 10, 10, 10, 10, 10]));
    const quiet = observedShares([...crowd, player([1, 0, 0, 0, 0, 0, 0])]).sh!;
    const whale = observedShares([...crowd, player([1e9, 0, 0, 0, 0, 0, 0])]).sh!;
    expect(whale[1]! - quiet[1]!).toBeLessThanOrEqual(Math.floor(1000 / 20) + 1);
    for (let c = 1; c <= 7; c++) expect(quiet[c]! - whale[c]!).toBeLessThanOrEqual(Math.floor(142 / 20) + 1);
  });

  it('blended target: BASE_SHARE under 7 valid days, nulls skipped, window of 14', () => {
    const flat = (v: number): number[] => [0, v, v, v, v, v, v, v];
    expect(blendedTarget([])).toEqual([0, ...MARKET.BASE_SHARE.slice(1)]);
    expect(blendedTarget(Array(14).fill(null))).toEqual([0, ...MARKET.BASE_SHARE.slice(1)]);
    const six = Array.from({ length: 6 }, () => flat(500));
    expect(blendedTarget(six)).toEqual([0, ...MARKET.BASE_SHARE.slice(1)]);                         // 6 valid: still fixed
    expect(blendedTarget([...six, null, null])[1]).toBe(MARKET.BASE_SHARE[1]);                      // nulls do not count
    const seven = [...six, flat(500)];
    expect(blendedTarget(seven)[1]).toBe(Math.floor((194 + 500) / 2));                              // 7 valid: half and half
    const mixed = [flat(100), null, flat(300), ...Array(5).fill(flat(200))];
    expect(blendedTarget(mixed)[3]).toBe(Math.floor((388 + Math.floor((100 + 300 + 1000) / 7)) / 2));
    // only the first 14 rows count
    expect(blendedTarget([...Array(14).fill(flat(100)), ...Array(20).fill(flat(900))])[2]).toBe(Math.floor((129 + 100) / 2));
    expect(Math.min(...blendedTarget([flat(0), flat(0), flat(0), flat(0), flat(0), flat(0), flat(0)]).slice(1))).toBeGreaterThanOrEqual(1);
  });

  it('raw target: neutral without shares, 1000 at the target, band edges', () => {
    const tgt = [0, 200, 200, 200, 100, 100, 100, 100];
    expect(rawTarget(null, tgt)).toEqual([0, 1000, 1000, 1000, 1000, 1000, 1000, 1000]);
    expect(rawTarget([0, 200, 0, 600, 100, 100, 100, 100], tgt).slice(1)).toEqual([1000, 2000, 500, 1000, 1000, 1000, 1000]);
    expect(rawTarget([0, 100, 400, 400, 100, 100, 100, 100], tgt)[1]).toBe(1333);                  // rho 500 -> 2e6/1500
  });

  it('baseline table and prices', () => {
    const b = baseMarket();
    expect(b.m).toEqual([0, 1000, 1000, 1000, 1000, 1000, 1000, 1000]);
    expect(b.p).toEqual(BASE_P);
    expect(b).toMatchObject({ sh: null, n: 0, from: null });
    expect(marketPrices([0, 500, 2000, 1000, 1000, 1000, 1000, 1000]).slice(1, 3)).toEqual([100, 600]);
    expect(marketPrices([0, 999, 1001, 1234, 1, 1, 1, 1])[1]).toBe(Math.floor(2 * 999 / 10));
    expect(isMarketTable(b)).toBe(true);
    expect(isMarketTable({ ...b, p: [...b.p].map((x) => x + 1) })).toBe(false);
    expect(isMarketTable({ ...b, m: [0, 400, 1000, 1000, 1000, 1000, 1000, 1000] })).toBe(false);
    expect(isMarketTable(null)).toBe(false);
  });

  it('nextMarket: no earlier row starts from base, fewer than 10 players stays neutral', () => {
    const few = Array.from({ length: 9 }, () => player([5, 0, 0, 0, 0, 0, 0]));
    const t = nextMarket(few, []);
    expect(t).toMatchObject({ n: 9, sh: null, from: null });
    expect(t.m).toEqual(baseMarket().m);
    const yesterday: MarketRow = { id: 'd-2026-12-08', m: [0, 1200, 900, 1000, 1000, 1000, 1000, 1000], t: [0, 1500, 800, 1000, 1000, 1000, 1000, 1000], sh: null };
    const stay = nextMarket(few, [yesterday]);
    // no new data: 3 parts neutral, 2 parts yesterday's raw target, 1 neutral, stepped from yesterday's multipliers
    expect(stay.from).toBe('d-2026-12-08');
    expect(stay.t).toEqual(baseMarket().t);
    expect(stay.m[1]).toBe(1200 + Math.max(-250, Math.min(250, Math.floor((3 * 1000 + 2 * 1500 + 1000) / 6) - 1200)));
  });

  it('property: 10,000 random days stay in the band, move at most 25 points and stay neutral under 10 players', () => {
    const r = rng(2026);
    let prev: MarketRow | null = null, prev2: MarketRow | null = null;
    const history: MarketRow[] = [];
    for (let day = 0; day < 10_000; day++) {
      const n = Math.floor(r() * 30);
      const sold = Array.from({ length: n }, () => player(Array.from({ length: 7 }, () => (r() < 0.3 ? 0 : Math.floor(r() * (r() < 0.05 ? 1e7 : 300))))));
      const earlier = [prev, prev2, ...history.slice(-13, -2).reverse()];
      const t: MarketTable = nextMarket(sold, earlier);
      expect(t.m.length).toBe(8);
      for (let c = 1; c <= 7; c++) {
        expect(t.m[c]).toBeGreaterThanOrEqual(MARKET.LO);
        expect(t.m[c]).toBeLessThanOrEqual(MARKET.HI);
        expect(Math.abs(t.m[c]! - (prev?.m[c] ?? 1000))).toBeLessThanOrEqual(MARKET.STEP);
        expect(t.p[c]).toBeGreaterThanOrEqual(1);
        if (t.sh === null) expect(t.t[c]).toBe(1000);
      }
      if (t.n < MARKET.MIN_PLAYERS) expect(t.sh).toBeNull();
      expect(isMarketTable(t)).toBe(true);
      prev2 = prev; prev = { id: `d${day}`, m: t.m, t: t.t, sh: t.sh }; history.push(prev);
    }
  });

  it('agrees with the E1a reference simulation on 400 random days', () => {
    const r = rng(77);
    const hist: (number[] | null)[] = [];                   // newest last, as the reference wants
    let m = [0, ...Array(7).fill(1000)], h1: number[] | null = null, h2: number[] | null = null;
    const rows: MarketRow[] = [];
    for (let day = 0; day < 400; day++) {
      const n = day % 37 < 6 ? Math.floor(r() * 10) : 10 + Math.floor(r() * 80);
      const sold = Array.from({ length: n }, () => { const s = Array(8).fill(0); for (let c = 1; c <= 7; c++) s[c] = r() < 0.2 ? 0 : Math.floor(r() * 200 * (c === 3 ? 4 : 1)); return s as number[]; });
      const refShare = ref.observedShare(sold);
      hist.push(refShare);
      const refRaw = ref.rawTarget(refShare, ref.blendedTarget(hist));
      const refM = ref.nextMult(m, refRaw, h1, h2);
      const mine = nextMarket(sold, rows.slice().reverse().slice(0, 13));
      expect(mine.sh).toEqual(refShare);
      expect(mine.t).toEqual(refRaw);
      expect(mine.m).toEqual(refM);
      expect(mine.p).toEqual(ref.centi(refM));
      h2 = h1; h1 = refRaw; m = refM;
      rows.push({ m: mine.m, t: mine.t, sh: mine.sh });
    }
  });

  it('nextMultipliers: three days of 3:2:1 smoothing, capped step', () => {
    const up = [0, 2000, 2000, 2000, 2000, 2000, 2000, 2000], base = baseMarket().m;
    expect(nextMultipliers(base, up)[1]).toBe(1250);                         // avg 1500 -> capped to +250
    expect(nextMultipliers(base, up, up, up)[1]).toBe(1250);                 // avg 2000 -> still capped
    expect(nextMultipliers([0, 1900, 1, 1, 1, 1, 1, 1], up, up, up)[1]).toBe(2000);
  });
});

describe('goldens (new, v4)', () => {
  it('a fixed month of tables', () => {
    // 12 days of 40 players whose mix follows the day\'s prices a little; the full chain of stored rows.
    const r = rng(4242);
    const rows: MarketRow[] = [];
    const out: string[] = [];
    let table = baseMarket();
    rows.push({ id: 'd-0', m: table.m, t: table.t, sh: table.sh });
    for (let d = 1; d <= 12; d++) {
      const sold = Array.from({ length: 40 }, () => { const s = Array(8).fill(0); for (let c = 1; c <= 7; c++) s[c] = Math.floor((MARKET.BASE_SHARE[c]! * (table.m[c]! / 1000) ** 3) * (0.5 + r()) * 0.5); return s as number[]; });
      table = nextMarket(sold, rows.slice().reverse().slice(0, 13));
      rows.push({ id: `d-${d}`, m: table.m, t: table.t, sh: table.sh });
      out.push(`${d}:${table.m.slice(1).join(',')}`);
    }
    expect(out).toMatchSnapshot();
  });

  it('a v4 run: hash and net worth', () => {
    const setup = challengeSetup('daily', dailySeed('2026-12-08'), 1, baseMarket()).setup;
    const d = new Driver(farm(dailySeed('2026-12-08')), setup);
    script(d, 80);
    expect({ tick: d.w.tick, hash: hashWorld(d.w), worth: netWorth(d.w) }).toMatchSnapshot();
  });
});

describe('MARKET_EPOCH and challengeSetup', () => {
  it('the winner bot announces the opening on the same date', () => {
    const bot = readFileSync(new URL('../../../scripts/daily-post.mjs', import.meta.url), 'utf8');
    expect(bot).toContain(`MARKET_EPOCH = '${MARKET_EPOCH}'`);
  });

  it('dailies before the epoch are v3, from it on v4', () => {
    expect(MARKET_EPOCH).toBe('2026-12-08');
    expect(dailyRulesVersion('2026-12-07')).toBe(3);
    expect(dailyRulesVersion('2026-12-08')).toBe(4);
    expect(dailyRulesVersion('2026-12-09')).toBe(4);
    expect(dailyRulesVersion('2027-02-01')).toBe(4);
    expect(marketActive('2026-12-01')).toBe(false);
    expect(daysUntilMarket('2026-12-01')).toBe(7);
    expect(daysUntilMarket('2026-12-08')).toBe(0);
    expect(daysUntilMarket('2026-12-20')).toBe(0);
    expect(() => marketActive('2026-02-31')).toThrow();
    expect(dailyNumber('2026-12-08')).toBe(8);
  });

  it('adds prices to the setup without disturbing the modifiers, for every setup version', () => {
    const market = nextMarket([], [{ m: [0, 1250, 1000, 750, 1000, 1000, 1000, 1000], t: baseMarket().t, sh: null }]);
    for (const version of [0, 1]) {
      const plain = challengeSetup('daily', 12345, version), withMarket = challengeSetup('daily', 12345, version, market);
      expect(withMarket.ticks).toBe(plain.ticks);
      expect(withMarket.modifiers).toEqual(plain.modifiers);
      expect(withMarket.setup).toEqual({ ...plain.setup, prices: market.p });
      expect(plain.setup.prices).toBeUndefined();
    }
    expect(challengeSetup('daily', 12345, 1, null)).toEqual(challengeSetup('daily', 12345, 1));
    expect(() => challengeSetup('season', 1, 1, market)).toThrow('seasons have no market');
    // duels copy a daily's table
    expect(challengeSetup('duel', 12345, 1, market).setup.prices).toEqual(market.p);
  });

  it('a market daily: the same log scores differently from the base daily', () => {
    const seed = 11; // a plain farm that sells carrots (setup version 0)
    const high = { ...baseMarket(), p: marketPrices([0, 1250, 1000, 1000, 1000, 1000, 1000, 1000]) };
    const a = new Driver(farm(seed), challengeSetup('daily', seed, 0).setup); script(a, 50);
    const b = new Driver(farm(seed), challengeSetup('daily', seed, 0, high).setup);
    replayChunk(b.w, a.log, a.w.tick + 1);
    const plain = createWorld(farm(seed), challengeSetup('daily', seed, 0).setup); replayChunk(plain, a.log, a.w.tick + 1);
    expect(netWorth(b.w)).toBeGreaterThan(netWorth(plain));
    expect(ITEMS[1]!.price).toBe(2);
    void round;
  });
});
