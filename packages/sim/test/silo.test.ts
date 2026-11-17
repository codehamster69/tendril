import { describe, expect, it } from 'vitest';
import {
  RULES_VERSION, SILO, SILO_BASE, SILO_BIT, SILO_EPOCH, SILO_EPOCH_MS, UNLOCKS, canSellPlot, challengeSetup, createWorld, dailyRulesVersion, deserialize,
  endlessSiloTick, hashWorld, netWorth, plotPrice, plotRefund, replayChunk, rulesHaveMarket, scanAt, seasonRulesVersion, serialize, siloCost,
  siloCount, siloPrice, snapshot, tickWorld, withEndlessSilos,
} from '../src/index.ts';
import type { Setup } from '../src/index.ts';
import { Driver, OP, farm, script } from './helpers.ts';

const ALL = (1 << UNLOCKS.length) - 1;
const RICH: Setup = { coins: 1_000_000, unlocks: ALL, siloTick: 0 };
const EAST = 1, W = 3; // move directions: 0 north, 1 east, 2 south, 3 west

/** Bot 0 walks east `n` tiles from wherever it stands. */
const east = (d: Driver, n: number): void => { for (let i = 0; i < n; i++) d.do(0, OP.move, EAST); };

describe('rules v5: switched on by data and date', () => {
  it('a world without siloTick refuses silo research, silos and sellPlot with result 0 and changes nothing else', () => {
    const d = new Driver(farm(3), { coins: 100_000, unlocks: ALL & ~(1 << SILO_BIT) });
    expect(d.do(-1, OP.unlock, SILO_BIT)).toBe(0);
    expect(d.do(-1, OP.buyPlot, 1, 0)).toBe(1);
    const before = d.w.coins;
    east(d, 1);
    d.w.unlocks |= 1 << SILO_BIT; // even with the research bit forced on
    expect(d.do(0, OP.build, SILO)).toBe(0);
    d.do(0, OP.move, W);
    expect(d.do(-1, OP.sellPlot, 1, 0)).toBe(0);
    expect(d.w.coins).toBe(before);
    expect(d.w.plots.length).toBe(2);
    expect(snapshot(d.w).siloCost).toBeUndefined();
  });

  it('an Endless farm gets silos at the first tick at or after SILO_EPOCH', () => {
    expect(SILO_EPOCH).toBe('2026-12-15');
    expect(SILO_EPOCH_MS).toBe(Date.parse('2026-12-15T00:00:00Z'));
    expect(endlessSiloTick(SILO_EPOCH_MS - 1000)).toBe(10);
    expect(endlessSiloTick(SILO_EPOCH_MS - 1050)).toBe(11);
    expect(endlessSiloTick(SILO_EPOCH_MS + 5)).toBe(0);
    const d = new Driver(farm(4), { coins: 10_000 });
    withEndlessSilos(d.w, SILO_EPOCH_MS - 30 * 100);
    expect(d.w.siloTick).toBe(30);
    expect(d.do(-1, OP.unlock, SILO_BIT)).toBe(0); // tick 0: too early
    d.advance(30);
    expect(d.do(-1, OP.unlock, SILO_BIT)).toBe(1);
  });

  it('the switch is not part of the hash, so stamping an Endless world leaves every older hash alone', () => {
    const plain = new Driver(farm(9));
    script(plain, 30);
    const stamped = createWorld(farm(9));
    withEndlessSilos(stamped, 0);
    replayChunk(stamped, plain.log, plain.w.tick + 1);
    tickWorld(plain.w);
    expect(hashWorld(stamped)).toBe(hashWorld(plain.w));
  });

  it('dailies and seasons from SILO_EPOCH are v5; seasons carry no market', () => {
    expect(dailyRulesVersion('2026-12-15')).toBe(5);
    expect(seasonRulesVersion('2026-12-14')).toBe(3);
    expect(seasonRulesVersion('2026-12-15')).toBe(5);
    expect(rulesHaveMarket(5, 'daily')).toBe(true);
    expect(rulesHaveMarket(5, 'season')).toBe(false);
    expect(rulesHaveMarket(4, 'duel')).toBe(true);
    expect(rulesHaveMarket(3, 'daily')).toBe(false);
    expect(challengeSetup('daily', 7, 1, null, RULES_VERSION).setup.siloTick).toBe(0);
    expect(challengeSetup('daily', 7, 1, null, 4).setup.siloTick).toBeUndefined();
    expect(challengeSetup('daily', 7, 1).setup.siloTick).toBeUndefined();
  });
});

describe('silos', () => {
  it('need the research, cost 300 * k * k and add to spent', () => {
    const d = new Driver(farm(5), { coins: 100_000, unlocks: 1, siloTick: 0 });
    east(d, 1);
    expect(d.do(0, OP.build, SILO)).toBe(0); // not researched
    expect(d.do(-1, OP.unlock, SILO_BIT)).toBe(1);
    expect(UNLOCKS[SILO_BIT]!.name).toBe('silo');
    const worth = netWorth(d.w);
    expect(SILO_BASE).toBe(500);
    expect(siloCost(d.w)).toBe(500);
    expect(d.do(0, OP.build, SILO)).toBe(1);
    expect(d.w.coins).toBe(100_000 - UNLOCKS[SILO_BIT]!.price - 500);
    expect(netWorth(d.w)).toBe(worth);
    expect(siloCount(d.w)).toBe(1);
    expect(siloCost(d.w)).toBe(2000);
    east(d, 1);
    expect(d.do(0, OP.build, SILO)).toBe(1);
    expect(siloCost(d.w)).toBe(4500);
    expect([siloPrice(0), siloPrice(1), siloPrice(3)]).toEqual([500, 2000, 8000]);
    expect(scanAt(d.w, 1, 0)!.building).toBe(SILO);
    expect(snapshot(d.w).siloCost).toBe(4500);
  });

  it('cannot go on the barn, a tilled tile or another building', () => {
    const d = new Driver(farm(5), RICH);
    expect(d.do(0, OP.build, SILO)).toBe(0); // barn tile
    east(d, 1);
    d.do(0, OP.till);
    expect(d.do(0, OP.build, SILO)).toBe(0);
    east(d, 1);
    expect(d.do(0, OP.build, 1)).toBe(1);
    expect(d.do(0, OP.build, SILO)).toBe(0);
  });

  it('take deposits and sales like the barn into one shared stock; orders still go to the barn', () => {
    const d = new Driver(farm(6), RICH);
    east(d, 2);
    d.do(0, OP.build, SILO);
    d.w.bots[0]!.load[1] = 10; // ten carrots, as if just harvested
    expect(d.do(0, OP.deposit)).toBe(10);
    expect(d.w.stock[1]).toBe(10);
    const coins = d.w.coins;
    expect(d.do(0, OP.sell, 1, 4)).toBe(8);
    expect(d.w.coins).toBe(coins + 8);
    expect(d.w.stock[1]).toBe(6);
    // Not a store: an empty tile one step on.
    east(d, 1);
    d.w.bots[0]!.load[1] = 3;
    expect(d.do(0, OP.deposit)).toBe(0);
    expect(d.do(0, OP.sell, 1, 1)).toBe(0);
    // Delivery stays barn-only.
    d.do(0, OP.move, W);
    d.w.stock[1] = 10_000;
    while (!d.w.orders.length) tickWorld(d.w);
    const id = d.w.orders[0]!.id;
    d.w.stock[d.w.orders[0]!.crop] = 10_000;
    expect(d.do(0, OP.deliver, id)).toBe(0);
  });

  it('clearing a silo pays back half the newest silo price; net worth drops by the other half', () => {
    const d = new Driver(farm(7), RICH);
    east(d, 1); d.do(0, OP.build, SILO);
    east(d, 1); d.do(0, OP.build, SILO);
    const coins = d.w.coins, worth = netWorth(d.w), spent = d.w.spent;
    expect(d.do(0, OP.clear)).toBe(1);
    expect(d.w.coins).toBe(coins + 1000);
    expect(d.w.spent).toBe(spent - 2000);
    expect(netWorth(d.w)).toBe(worth - 1000);
    expect(siloCount(d.w)).toBe(1);
    expect(siloCost(d.w)).toBe(2000);
  });

  it('a build and clear loop always loses coins and net worth', () => {
    const d = new Driver(farm(8), RICH);
    east(d, 1);
    let coins = d.w.coins, worth = netWorth(d.w);
    for (let i = 0; i < 20; i++) {
      expect(d.do(0, OP.build, SILO)).toBe(1);
      expect(d.do(0, OP.clear)).toBe(1);
      expect(d.w.coins).toBeLessThan(coins);
      expect(netWorth(d.w)).toBeLessThan(worth);
      coins = d.w.coins; worth = netWorth(d.w);
    }
  });
});

describe('sellPlot', () => {
  /** Barn plot plus a row of plots east: (1,0) .. (n,0). */
  function row(n: number, setup: Setup = RICH): Driver {
    const d = new Driver(farm(11), setup);
    for (let px = 1; px <= n; px++) expect(d.do(-1, OP.buyPlot, px, 0)).toBe(1);
    return d;
  }

  it('pays half the newest plot price and removes the plot; net worth drops by the other half', () => {
    const d = row(3);
    const coins = d.w.coins, worth = netWorth(d.w), spent = d.w.spent;
    expect(plotRefund(d.w)).toBe(Math.floor(plotPrice(3) / 2));
    expect(d.do(-1, OP.sellPlot, 3, 0)).toBe(675);
    expect(d.w.coins).toBe(coins + 675);
    expect(d.w.spent).toBe(spent - 1350);
    expect(netWorth(d.w)).toBe(worth - 675);
    expect(d.w.plots.map((p) => [p.px, p.py])).toEqual([[0, 0], [1, 0], [2, 0]]);
    expect(d.w.plotIndex.get('2,0')).toBe(2);
    expect(d.w.plotIndex.has('3,0')).toBe(false);
  });

  it('refuses the barn plot, plots not owned, plots that would cut the farm in two, inner plots and plots with a bot', () => {
    const d = row(3);
    expect(canSellPlot(d.w, 0, 0)).toBe(false);
    expect(canSellPlot(d.w, 5, 0)).toBe(false);
    expect(canSellPlot(d.w, 1, 0)).toBe(false); // would cut (2,0) and (3,0) off
    expect(d.do(-1, OP.sellPlot, 2, 0)).toBe(0);
    // A 3x3 block around the barn: (0,0) is the barn; (1,1) has all four neighbours and is not on the edge.
    const b = new Driver(farm(12), RICH);
    for (const [x, y] of [[1, 0], [2, 0], [1, 1], [0, 1], [2, 1], [0, 2], [1, 2], [2, 2]]) expect(b.do(-1, OP.buyPlot, x, y)).toBe(1);
    expect(canSellPlot(b.w, 1, 1)).toBe(false);
    expect(canSellPlot(b.w, 2, 2)).toBe(true);
    // A bot standing on the plot.
    east(d, 8 * 3);
    expect(d.do(-1, OP.sellPlot, 3, 0)).toBe(0);
    d.do(0, OP.move, W);
    expect(d.do(-1, OP.sellPlot, 3, 0)).toBeGreaterThan(0);
  });

  it('loses buildings on the plot; a silo there leaves spent without paying coins', () => {
    const d = row(1);
    east(d, 8); d.do(0, OP.build, SILO);
    east(d, 1); d.do(0, OP.build, 1);
    for (let i = 0; i < 9; i++) d.do(0, OP.move, W);
    const coins = d.w.coins, spent = d.w.spent;
    expect(d.do(-1, OP.sellPlot, 1, 0)).toBe(75);
    expect(d.w.coins).toBe(coins + 75);
    expect(d.w.spent).toBe(spent - 150 - 500);
    expect(siloCount(d.w)).toBe(0);
    expect(siloCost(d.w)).toBe(500);
    // Buying it back gives fresh soil with no buildings.
    expect(d.do(-1, OP.buyPlot, 1, 0)).toBe(1);
    expect(scanAt(d.w, 8, 0)!.building).toBe(0);
    expect(scanAt(d.w, 9, 0)!.building).toBe(0);
  });

  it('a buy and sell loop always loses coins and net worth', () => {
    const d = row(4);
    let coins = d.w.coins, worth = netWorth(d.w);
    for (let i = 0; i < 25; i++) {
      expect(d.do(-1, OP.sellPlot, 4, 0)).toBeGreaterThan(0);
      expect(d.do(-1, OP.buyPlot, 4, 0)).toBe(1);
      expect(d.w.coins).toBeLessThan(coins);
      expect(netWorth(d.w)).toBeLessThan(worth);
      coins = d.w.coins; worth = netWorth(d.w);
    }
  });

  it('orders already issued keep their size', () => {
    const d = row(3);
    while (!d.w.orders.length) tickWorld(d.w);
    const qty = d.w.orders[0]!.qty;
    d.do(-1, OP.sellPlot, 3, 0);
    d.do(-1, OP.sellPlot, 2, 0);
    expect(d.w.orders[0]!.qty).toBe(qty);
  });
});

describe('rules v5 determinism', () => {
  function play(): Driver {
    const d = new Driver(farm(21), { coins: 50_000, unlocks: ALL, siloTick: 0 });
    d.do(-1, OP.buyPlot, 1, 0); d.do(-1, OP.buyPlot, 2, 0);
    east(d, 3); d.do(0, OP.build, SILO);
    script(d, 60);
    d.do(-1, OP.sellPlot, 2, 0);
    east(d, 9); d.do(0, OP.build, SILO); d.do(0, OP.clear);
    d.advance(50);
    return d;
  }

  it('replays to the same hash, twice, and through serialize', () => {
    const a = play(), b = play();
    expect(hashWorld(a.w)).toBe(hashWorld(b.w));
    const replayed = createWorld(farm(21), { coins: 50_000, unlocks: ALL, siloTick: 0 });
    replayChunk(replayed, a.log, a.w.tick);
    expect(hashWorld(replayed)).toBe(hashWorld(a.w));
    expect(netWorth(replayed)).toBe(netWorth(a.w));
    const s = serialize(a.w);
    expect(JSON.parse(s).rulesVersion).toBe(5);
    const back = deserialize(s);
    expect(back.siloTick).toBe(0);
    expect(hashWorld(back)).toBe(hashWorld(a.w));
    expect(serialize(back)).toBe(s);
    expect(() => deserialize(JSON.stringify({ ...JSON.parse(s), siloTick: undefined }))).toThrow('silo tick');
    expect(() => deserialize(JSON.stringify({ ...JSON.parse(s), rulesVersion: 3 }))).toThrow();
  });

  it('a v5 world with a market table round-trips too', () => {
    const prices = [0, 250, 300, 100, 600, 400, 500, 800];
    const w = createWorld(farm(22), { prices, siloTick: 0 });
    const back = deserialize(serialize(w));
    expect(back.prices).toEqual(prices);
    expect(back.siloTick).toBe(0);
  });
});
