import { describe, expect, it } from 'vitest';
import {
  HIDDEN_FARMS, SETUP_BRIEF, SETUP_VERSION, TWIST_KEYS, UNLOCKS, applyAction, challengeSetup, createWorld, describeBrief, deserialize, drawBrief,
  finalOf, forecast, hashWorld, netWorth, replayChunk, replayWithGoal, replayWithPar, serialize, setupVersionFor, tickWorld, weatherAt, briefActive, BRIEF_EPOCH,
} from '../src/index.ts';
import type { Goal, Setup } from '../src/index.ts';
import { Driver, OP, farm, round } from './helpers.ts';

const seeds = (n: number): number[] => Array.from({ length: n }, (_, i) => (Math.imul(i + 1, 0x9E3779B1) >>> 0) || 1);
const fnv = (s: string): number => { let h = 0x811c9dc5; for (const b of new TextEncoder().encode(s)) { h ^= b; h = Math.imul(h, 0x01000193); } return (h >>> 0) || 1; };

describe('brief generator', () => {
  it('is on from BRIEF_EPOCH and chosen by date', () => {
    expect(BRIEF_EPOCH).toBe('2026-11-18');
    expect(briefActive('2026-11-17')).toBe(false);
    expect(briefActive('2026-11-18')).toBe(true);
    expect(setupVersionFor('2026-11-17')).toBe(SETUP_VERSION);
    expect(setupVersionFor('2026-12-01')).toBe(SETUP_BRIEF);
    expect(HIDDEN_FARMS).toEqual({ daily: 2, season: 4, duel: 0 });
  });

  it('is deterministic per seed and kind, and old versions carry no brief', () => {
    for (const s of seeds(50)) {
      expect(challengeSetup('daily', s, SETUP_BRIEF)).toEqual(challengeSetup('daily', s, SETUP_BRIEF));
      expect(challengeSetup('daily', s, SETUP_VERSION).brief).toBeUndefined();
      expect(challengeSetup('daily', s, 0).brief).toBeUndefined();
    }
  });

  it('keeps every draw inside its bounds (3000 dailies, 3000 seasons)', () => {
    const goalCount: Record<string, number> = {};
    for (const s of seeds(3000)) {
      for (const kind of ['daily', 'season'] as const) {
        const { brief, setup } = drawBrief(kind, s);
        const ticks = kind === 'season' ? 6000 : 3000;
        expect(brief.ticks).toBe(ticks);
        expect(brief.goal.budget).toBe(ticks);
        if (kind === 'season') expect(brief.twists).toHaveLength(2); else expect(brief.twists.length).toBeLessThanOrEqual(2);
        const keys = brief.twists.map((t) => t.key);
        expect(new Set(keys).size).toBe(keys.length);
        expect(keys.every((k) => TWIST_KEYS.includes(k))).toBe(true);
        expect(keys.includes('drought') && keys.includes('dry_soil')).toBe(false);
        expect(keys.includes('drought') && keys.includes('hard_frost')).toBe(false);
        if (brief.goal.kind === 'inherited') expect(keys).not.toContain('land');
        const given = brief.twists.find((t) => t.key === 'research_given'), locked = brief.twists.find((t) => t.key === 'research_locked');
        if (given && locked) expect(given.value).not.toBe(locked.value);
        if (locked) { expect(setup.unlocks === undefined || (setup.unlocks & (1 << locked.value!)) === 0).toBe(true); expect(locked.value).toBeGreaterThanOrEqual(3); }
        const g = brief.goal;
        if (g.kind === 'festival') {
          const items = g.quotas!.map((q, c) => (q > 0 ? c : 0)).filter(Boolean);
          expect(items.length).toBeGreaterThanOrEqual(2); expect(items.length).toBeLessThanOrEqual(kind === 'season' ? 4 : 3);
          for (const c of items) { if (locked && c <= 6) expect(locked.value).not.toBe(c - 1); expect(g.quotas![c]).toBeGreaterThan(0); }
          expect(g.quotas![0]).toBe(0); expect(g.quotas).toHaveLength(8);
          if (kind === 'daily') expect(g.quotas![6]).toBe(0);
          if (g.quotas![7]) expect(kind === 'season' || keys.includes('hive')).toBe(true);
        } else expect(g.quotas).toBeUndefined();
        if (g.kind === 'specialist') { expect(g.favoured).not.toBe(g.shunned); expect(setup.prices).toBeUndefined(); }
        else expect(g.favoured).toBeUndefined();
        const w = createWorld({ id: 't', seed: s }, setup); // every drawn setup is accepted
        expect(w.brief?.goal).toEqual(g);
        const plotCap = brief.twists.find((t) => t.key === 'plot_cap');
        if (plotCap) expect(plotCap.value).toBeGreaterThanOrEqual(w.plots.length);
        goalCount[g.kind] = (goalCount[g.kind] ?? 0) + 1;
        expect(brief.notice.length).toBeGreaterThan(10);
        expect(describeBrief(brief, kind)).toEqual({ notice: brief.notice, labels: brief.labels });
        expect(brief.labels).toHaveLength(brief.twists.length);
      }
    }
    // weights 4/16 and 3/16 over 6000 draws
    expect(goalCount.wealth! / 6000).toBeGreaterThan(0.22); expect(goalCount.wealth! / 6000).toBeLessThan(0.28);
    for (const k of ['festival', 'specialist', 'orders', 'inherited']) { expect(goalCount[k]! / 6000).toBeGreaterThan(0.16); expect(goalCount[k]! / 6000).toBeLessThan(0.21); }
  });

  it('draws 0, 1 and 2 twists on dailies', () => {
    const n = [0, 0, 0];
    for (const s of seeds(2000)) n[drawBrief('daily', s).brief.twists.length]!++;
    expect(n.every((c) => c > 300)).toBe(true);
  });

  it('a duel copied from a season gets the season brief, from a daily the daily brief', () => {
    const s = 777;
    expect(challengeSetup('duel', s, SETUP_BRIEF).brief).toEqual(challengeSetup('daily', s, SETUP_BRIEF).brief);
    expect(challengeSetup('duel', s, SETUP_BRIEF, null, undefined, 'season').brief).toEqual(challengeSetup('season', s, SETUP_BRIEF).brief);
  });

  it('writes the village notice and labels', () => {
    const { brief } = drawBrief('daily', 1);
    expect(brief.notice.endsWith('.')).toBe(true);
    const fest = describeBrief({ goal: { kind: 'festival', budget: 3000, quotas: [0, 0, 300, 0, 80, 0, 0, 0] }, twists: [{ key: 'bot_cap', value: 1 }, { key: 'research_locked', value: 5 }], ticks: 3000, notice: '', labels: [] }, 'daily');
    expect(fest.notice).toBe('The village fair wants 300 wheat and 80 pumpkins by sundown.');
    expect(fest.labels).toEqual(['One bot only', 'Apple research locked']);
  });

  it('composes specialist prices with the base prices or the market table, in whole centicoins', () => {
    let seen = 0;
    for (const s of seeds(400)) {
      const base = challengeSetup('daily', s, SETUP_BRIEF);
      if (base.brief!.goal.kind !== 'specialist') { expect(base.setup.prices).toBeUndefined(); continue; }
      seen++;
      const g = base.brief!.goal;
      const prices = base.setup.prices!;
      const table = [0, 210, 330, 90, 650, 400, 520, 800];
      const market = challengeSetup('daily', s, SETUP_BRIEF, { p: table });
      for (let c = 1; c <= 7; c++) {
        const mult = c === g.favoured ? 3000 : c === g.shunned ? 300 : 1000;
        expect(prices[c]).toBe(Math.max(1, Math.floor([0, 200, 300, 100, 600, 400, 500, 800][c]! * mult / 1000)));
        expect(market.setup.prices![c]).toBe(Math.max(1, Math.floor(table[c]! * mult / 1000)));
      }
      expect(createWorld(farm(s), market.setup).prices).toEqual(market.setup.prices);
    }
    expect(seen).toBeGreaterThan(40);
    expect(challengeSetup('daily', 5, SETUP_BRIEF, { p: [0, 1, 2, 3, 4, 5, 6, 7] }, 5).setup.siloTick).toBe(0);
  });
});

describe('brief world effects', () => {
  it('absent fields change nothing: a world with an empty or old setup hashes as before', () => {
    for (const s of [1, 99, 12345]) {
      const a = createWorld(farm(s)), b = createWorld(farm(s), {}), c = createWorld(farm(s), { coins: 20, unlocks: 3, weatherBias: -1 });
      expect(hashWorld(a)).toBe(hashWorld(b));
      expect(a.brief).toBeUndefined(); expect(c.brief).toBeUndefined();
      expect(serialize(a)).toBe(serialize(b));
    }
  });

  it('caps and locks return 0 with no other effect', () => {
    const w = createWorld(farm(3), { coins: 100_000, maxBots: 2, maxPlots: 2, lockedUnlocks: 1 << 3 });
    expect(applyAction(w, [0, -1, OP.buyBot])).toBe(2);
    const coins = w.coins;
    expect(applyAction(w, [0, -1, OP.buyBot])).toBe(0);
    expect(w.bots).toHaveLength(2);
    expect(applyAction(w, [0, -1, OP.buyPlot, 1, 0])).toBe(1);
    expect(applyAction(w, [0, -1, OP.buyPlot, 2, 0])).toBe(0);
    expect(w.plots).toHaveLength(2);
    expect(w.coins).toBeLessThan(coins); // only the first plot was paid for
    const before = w.coins;
    expect(applyAction(w, [0, -1, OP.unlock, 3])).toBe(0);
    expect(w.unlocks & (1 << 3)).toBe(0);
    expect(applyAction(w, [0, -1, OP.unlock, 4])).toBe(1);
    expect(w.coins).toBe(before - UNLOCKS[4]!.price);
  });

  it('starting land, stock and hive are placed, and bad ones are refused', () => {
    const w = createWorld(farm(4), { plots: [1, 0, 1, 1], stock: [0, 5, 0, 0, 0, 0, 0, 0], hive: [3, 2] });
    expect(w.plots.map((p) => [p.px, p.py])).toEqual([[0, 0], [1, 0], [1, 1]]);
    expect(w.stock[1]).toBe(5);
    expect(netWorth(w)).toBe(10);
    const hiveOff = (2 * 8 + 3) * 10 + 8;
    expect(w.plots[0]!.tiles[hiveOff]).toBe(1);
    expect(() => createWorld(farm(4), { plots: [2, 0] })).toThrow();
    expect(() => createWorld(farm(4), { plots: [1, 0, 1, 0] })).toThrow();
    expect(() => createWorld(farm(4), { hive: [0, 0] })).toThrow();
    expect(() => createWorld(farm(4), { maxBots: 0 })).toThrow();
  });

  it('drought has no rain, hard frost has more and longer frost', () => {
    const dry = createWorld(farm(8), { weatherBias: 2 }), std = createWorld(farm(8)), hard = createWorld(farm(8), { weatherBias: -2 });
    for (let t = 0; t < 12_000; t += 7) expect(weatherAt(dry, t)).not.toBe('rain');
    expect(forecast(dry, 12_000).every((s) => s.end > s.start)).toBe(true);
    const frost = (w: ReturnType<typeof createWorld>): number => forecast(w, 30_000).filter((s) => s.kind === 'frost').reduce((a, s) => a + s.end - s.start, 0);
    expect(frost(hard)).toBeGreaterThan(frost(std) * 2);
    expect(forecast(dry, 12_000).some((s) => s.kind === 'frost')).toBe(true); // frost still comes in a drought
  });

  it('patches of poor and dry soil come from the world seed, so hidden farms differ', () => {
    const setup: Setup = { poorSoil: 20, drySoil: 30 };
    const a = createWorld(farm(1), setup), b = createWorld(farm(2), setup), plain = createWorld(farm(1));
    expect(Array.from(a.plots[0]!.tiles)).not.toEqual(Array.from(plain.plots[0]!.tiles));
    expect(Array.from(a.plots[0]!.tiles)).not.toEqual(Array.from(b.plots[0]!.tiles));
    const diffs = (x: typeof a): { n: number; m: number } => {
      let n = 0, m = 0;
      for (let o = 0; o < x.plots[0]!.tiles.length; o += 10) { if (x.plots[0]!.tiles[o + 5] !== plain.plots[0]!.tiles[o + 5]) n++; if (x.plots[0]!.tiles[o + 4] !== 50) m++; }
      return { n, m };
    };
    expect(diffs(a).m).toBeGreaterThan(0); expect(diffs(a).m).toBeLessThan(64);
  });

  it('boosted orders come more often and pay more', () => {
    const std = createWorld(farm(6), { unlocks: 0b111111 }), boost = createWorld(farm(6), { unlocks: 0b111111, orderBoost: 1 });
    let n1 = 0, n2 = 0;
    for (let i = 0; i < 6000; i++) { tickWorld(std); tickWorld(boost); n1 = std.nextOrderId - 1; n2 = boost.nextOrderId - 1; }
    expect(n2).toBeGreaterThan(n1 * 1.5);
    const o = boost.orders[0]!;
    expect(o.reward % 1).toBe(0);
    expect(o.reward).toBe(o.qty * [0, 2, 3, 1, 6, 4, 5][o.crop]! * 3 + 10);
  });

  it('the inherited farm is half-planted and tired, differs per world seed, and scores relative to its start', () => {
    const a = createWorld(farm(1), { inherited: 1, unlocks: 7, coins: 30 }), b = createWorld(farm(2), { inherited: 1, unlocks: 7, coins: 30 });
    expect(a.plots).toHaveLength(2);
    const stats = (w: typeof a): { planted: number; tilled: number; fatigue: number } => {
      let planted = 0, tilled = 0, fatigue = 0, n = 0;
      for (const p of w.plots) for (let o = 0; o < p.tiles.length; o += 10) { if (p.tiles[o + 1]) planted++; if (p.tiles[o]) tilled++; fatigue += p.tiles[o + 6]!; n++; }
      return { planted, tilled, fatigue: fatigue / n };
    };
    const sa = stats(a);
    expect(sa.planted).toBeGreaterThan(20); expect(sa.tilled).toBeGreaterThan(sa.planted); expect(sa.fatigue).toBeGreaterThan(20);
    expect(hashWorld(a)).not.toBe(hashWorld(b));
    expect(netWorth(a)).toBe(30);
    // a crop that is already growing at tick 0 can be harvested early
    const d = new Driver(farm(1), { inherited: 1, unlocks: 7, coins: 30, goal: { kind: 'inherited', budget: 3000 } });
    expect(d.w.brief?.goal?.kind).toBe('inherited');
    expect(hashWorld(d.w)).toBe(hashWorld(a));
  });

  it('survives serialize and deserialize with its brief state', () => {
    const { setup } = challengeSetup('daily', 4242, SETUP_BRIEF, null, 5);
    const w = createWorld(farm(9), { ...setup, maxBots: 2, lockedUnlocks: 8, orderBoost: 1, poorSoil: 10, weatherBias: 2 });
    for (let i = 0; i < 500; i++) tickWorld(w);
    const back = deserialize(serialize(w));
    expect(back.brief).toEqual(w.brief);
    expect(back.weatherBias).toBe(2);
    expect(hashWorld(back)).toBe(hashWorld(w));
  });

  it('hidden farms: the same brief on another world seed gives another world and the same goal', () => {
    for (const s of seeds(40)) {
      const { setup, brief } = challengeSetup('daily', s, SETUP_BRIEF, null, 5);
      const a = createWorld({ id: 'v', seed: s }, setup), h1 = createWorld({ id: 'h1', seed: fnv(`h1:${s}`) }, setup);
      expect(h1.brief?.goal).toEqual(brief!.goal);
      expect(h1.brief?.goal).toEqual(a.brief?.goal);
      expect(hashWorld(a)).not.toBe(hashWorld(h1));
      expect(h1.plots).toHaveLength(a.plots.length);
      if (setup.hive) expect(h1.plots[0]!.tiles[(setup.hive[1] * 8 + setup.hive[0]) * 10 + 8]).toBe(1);
    }
  });
});

describe('replayWithGoal and finalOf', () => {
  const run = (setup: Setup, rounds: number): { d: Driver; goal: Goal | null } => {
    const d = new Driver(farm(11), setup);
    for (let i = 0; i < rounds; i++) round(d);
    return { d, goal: setup.goal ?? null };
  };

  it('goal null is exactly replayWithPar and replayChunk', () => {
    const { d } = run({ coins: 20 }, 4);
    const toTick = d.w.tick + 50;
    const a = createWorld(farm(11), { coins: 20 }), b = createWorld(farm(11), { coins: 20 }), c = createWorld(farm(11), { coins: 20 });
    const g = replayWithGoal(a, d.log, toTick, null, 60), p = replayWithPar(b, d.log, toTick, 60);
    replayChunk(c, d.log, toTick);
    expect(g.score).toBe(p.netWorth); expect(g.netWorth).toBe(p.netWorth);
    expect({ netWorth: g.netWorth, sold: g.sold, parTick: g.parTick, mosaic: g.mosaic }).toEqual(p);
    expect(hashWorld(a)).toBe(hashWorld(c)); expect(hashWorld(b)).toBe(hashWorld(c));
  });

  it('festival counts deposits as filled permille, monotone, and keeps the first-par tick', () => {
    const goal: Goal = { kind: 'festival', budget: 3000, quotas: [0, 20, 0, 0, 0, 0, 0, 0] };
    const { d } = run({ goal }, 6);
    const toTick = d.w.tick + 10;
    const r = replayWithGoal(createWorld(farm(11), { goal }), d.log, toTick, goal, 500);
    expect(r.deposited[1]).toBeGreaterThan(20);
    expect(r.score).toBe(1000);
    expect(r.parTick).not.toBeNull();
    const live = createWorld(farm(11), { goal });
    const rr = replayWithGoal(live, d.log, toTick, goal, 500);
    expect(live.brief?.deposited).toEqual(rr.deposited);
    expect(createWorld(farm(11), { goal: { kind: 'wealth', budget: 3000 } }).brief?.deposited).toBeUndefined();
    const partial = replayWithGoal(createWorld(farm(11), { goal }), d.log.slice(0, 40), toTick, goal, 1);
    expect(partial.score).toBeGreaterThanOrEqual(0); expect(partial.score).toBeLessThanOrEqual(1000);
    expect(partial.score).toBe(Math.floor(Math.min(20, partial.deposited[1]!) * 1000 / 20));
    // selling afterwards does not lower the score: deposits are what count
    let prev = -1;
    for (const k of [10, 20, 30, 40, d.log.length]) {
      const x = replayWithGoal(createWorld(farm(11), { goal }), d.log.slice(0, k), toTick, goal, 1);
      expect(x.score).toBeGreaterThanOrEqual(prev); prev = x.score;
    }
  });

  it('orders score counts delivery coins only; inherited scores net worth gained', () => {
    const w = createWorld(farm(11), { unlocks: 0b111111, orderBoost: 1, goal: { kind: 'orders', budget: 3000 } });
    for (let i = 0; i < 400; i++) tickWorld(w);
    const ord = w.orders[0]!;
    w.stock[ord.crop] = ord.qty;
    const log: [number, number, number, number][] = [[w.tick, 0, OP.deliver, ord.id]];
    const w2 = createWorld(farm(11), { unlocks: 0b111111, orderBoost: 1 });
    // deliver needs the bot at the barn, where it starts; stock is set up the same way via a prefix replay
    for (let i = 0; i < 400; i++) tickWorld(w2);
    w2.stock[ord.crop] = ord.qty;
    const r = replayWithGoal(w2, log, w2.tick + 5, { kind: 'orders', budget: 3000 }, 1);
    expect(r.orderCoins).toBe(ord.reward);
    expect(r.score).toBe(ord.reward);
    expect(r.parTick).toBe(400);
    const inh = createWorld(farm(11), { inherited: 1, unlocks: 7, coins: 30 });
    const r2 = replayWithGoal(inh, [], 100, { kind: 'inherited', budget: 3000 }, 1);
    expect(r2.score).toBe(0);
    expect(r2.parTick).toBeNull();
  });

  it('finalOf sums scores and par ticks, counting a missed farm as the budget', () => {
    expect(finalOf([100, 80, 90], [500, 700, 600], 3000, 80)).toEqual({ finalScore: 270, finalParTick: 1800 });
    expect(finalOf([100, 80, 90], [500, null, 600], 3000, 80)).toEqual({ finalScore: 270, finalParTick: 4100 });
    expect(finalOf([100, 30, 90], [500, null, 600], 3000, 80)).toEqual({ finalScore: 220, finalParTick: null });
    expect(() => finalOf([1], [1, 2], 3000, 1)).toThrow();
  });
});
