import { describe, expect, it } from 'vitest';
import { IllegalAction, applyAction, hashWorld, scan, tickWorld } from '../src/index.ts';
import type { LogEntry, World } from '../src/index.ts';
import { CROP_UNLOCKS, Driver, OP, farm } from './helpers.ts';

function illegal(w: World, e: unknown): void {
  const h = hashWorld(w);
  expect(() => applyAction(w, e as LogEntry)).toThrow(IllegalAction);
  expect(hashWorld(w)).toBe(h);
}
const raw = (w: World, x: number, y: number, i: number) => w.plots[0]!.tiles[(y * 8 + x) * 10 + i]!;
const east = (d: Driver) => d.do(0, OP.move, 1);
const sandbox = () => new Driver(farm(), { unlocks: CROP_UNLOCKS });

describe('common illegal cases', () => {
  const d = sandbox();
  const w = d.w;
  it('rejects bad envelope', () => {
    illegal(w, [1, 0, OP.wait, 1]);          // wrong tick
    illegal(w, [0.5, 0, OP.wait, 1]);
    illegal(w, [0, 1, OP.wait, 1]);          // no such bot
    illegal(w, [0, -1, OP.wait, 1]);         // -1 for bot op
    illegal(w, [0, 0, OP.buyPlot, 1, 0]);    // bot 0 for farm op
    illegal(w, [0, 0, 16]);                  // unknown op
    illegal(w, [0, 0, -1]);
    illegal(w, [0, 0.5, OP.till]);
    illegal(w, [0, 0]);
  });
  it('rejects a busy bot', () => {
    d.do(0, OP.wait, 5);
    illegal(w, [0, 0, OP.till]);
    for (let i = 0; i < 5; i++) tickWorld(w);
  });
});

describe('move', () => {
  it('steps, fails on unowned land, illegal args', () => {
    const d = sandbox();
    expect(d.do(0, OP.move, 0)).toBe(0);           // north of barn unowned
    expect(d.w.bots[0]!.y).toBe(0);
    expect(d.do(0, OP.move, 1)).toBe(1);
    expect(d.w.bots[0]!.x).toBe(1);
    expect(d.w.bots[0]!.busyUntil).toBe(d.w.tick + 2);
    d.advance(2);
    for (const a of [4, -1, 1.5, undefined]) illegal(d.w, a === undefined ? [d.w.tick, 0, OP.move] : [d.w.tick, 0, OP.move, a]);
  });
  it('plot edge', () => {
    const d = sandbox();
    for (let i = 0; i < 7; i++) expect(d.do(0, OP.move, 1)).toBe(1);
    expect(d.do(0, OP.move, 1)).toBe(0);
  });
});

describe('till / plant / water', () => {
  it('till', () => {
    const d = sandbox();
    expect(d.do(0, OP.till)).toBe(0);              // barn
    east(d);
    expect(d.do(0, OP.till)).toBe(1);
    expect(raw(d.w, 1, 0, 0)).toBe(1);
    expect(d.w.bots[0]!.busyUntil).toBe(d.w.tick + 3);
    d.do(0, OP.plant, 1);
    expect(d.do(0, OP.till)).toBe(0);              // crop present
  });
  it('plant', () => {
    const d = sandbox();
    expect(d.do(0, OP.plant, 1)).toBe(0);          // barn
    east(d);
    expect(d.do(0, OP.plant, 1)).toBe(0);          // not tilled
    d.do(0, OP.till);
    illegal(d.w, [d.w.tick + 0, 0, OP.plant, 5]);
    d.advance(3);
    illegal(d.w, [d.w.tick, 0, OP.plant, 0]);
    illegal(d.w, [d.w.tick, 0, OP.plant]);
    expect(d.do(0, OP.plant, 4)).toBe(1);          // pumpkin
    expect(raw(d.w, 1, 0, 3)).toBe(2);             // rate 2, moisture 50>=40
    expect(raw(d.w, 1, 0, 4)).toBe(25);            // drink 25
    expect(d.do(0, OP.plant, 4)).toBe(0);          // already a crop
    d.do(0, OP.harvest);                           // unripe: clears
    d.do(0, OP.till);
    expect(d.do(0, OP.plant, 4)).toBe(1);
    expect(raw(d.w, 1, 0, 3)).toBe(1);             // moisture 25 < 40 -> rate 1
  });
  it('water', () => {
    const d = sandbox();
    east(d);
    expect(d.do(0, OP.water)).toBe(1);
    expect(raw(d.w, 1, 0, 4)).toBe(80);
    d.do(0, OP.water); d.do(0, OP.water);
    expect(raw(d.w, 1, 0, 4)).toBe(100);
    expect(scan(d.w, 0).moisture).toBe(100);
  });
});

describe('harvest / deposit', () => {
  it('no crop, unripe, ripe, capacity', () => {
    const d = sandbox();
    east(d);
    expect(d.do(0, OP.harvest)).toBe(0);
    d.do(0, OP.till); d.do(0, OP.plant, 1);
    expect(d.do(0, OP.harvest)).toBe(0);           // unripe, still clears
    expect(raw(d.w, 1, 0, 1)).toBe(0);
    expect(raw(d.w, 1, 0, 0)).toBe(0);
    // ripe pumpkin: rate 2 -> 225 ticks, before the first frost (>= 300)
    d.do(0, OP.till); d.do(0, OP.plant, 4);
    d.advance(230);
    expect(scan(d.w, 0).stage).toBe(3);
    const f = scan(d.w, 0).fatigue;
    const units = Math.max(1, (20 * (100 - f)) / 100 | 0);
    expect(units).toBeLessThan(20);                // carrot fatigue still lingers
    expect(d.do(0, OP.harvest)).toBe(units);
    expect(d.w.bots[0]!.load[4]).toBe(units);
    east(d);
    d.do(0, OP.till); d.do(0, OP.plant, 2);        // wheat, ripe in 135
    d.advance(140);
    expect(d.do(0, OP.harvest)).toBe(20 - units);  // capacity 20
    expect(d.w.bots[0]!.load[2]).toBe(20 - units);
  });
  it('clover fixes nitrogen, clamps fatigue', () => {
    const d = sandbox();
    east(d);
    d.do(0, OP.till); d.do(0, OP.plant, 3);
    d.advance(120);
    const n0 = raw(d.w, 1, 0, 5);
    expect(d.do(0, OP.harvest)).toBe(1);
    expect(raw(d.w, 1, 0, 5)).toBe(Math.min(100, n0 + 20));
    expect(raw(d.w, 1, 0, 6)).toBe(0);
  });
  it('deposit', () => {
    const d = sandbox();
    east(d);
    d.do(0, OP.till); d.do(0, OP.plant, 2); d.advance(140);
    expect(d.do(0, OP.harvest)).toBe(8);
    expect(d.do(0, OP.deposit)).toBe(0);           // not on barn
    d.do(0, OP.move, 3);
    expect(d.do(0, OP.deposit)).toBe(8);
    expect(d.w.stock[2]).toBe(8);
    expect(d.w.bots[0]!.load[2]).toBe(0);
    expect(d.w.bots[0]!.busyUntil).toBe(d.w.tick + 1);
  });
});

describe('deliver / wait / sell', () => {
  it('deliver in-world failures and illegal', () => {
    const d = sandbox();
    d.advance(200);
    const o = d.w.orders[0]!;
    expect(d.do(0, OP.deliver, o.id)).toBe(0);     // stock short
    expect(d.do(0, OP.deliver, 9999)).toBe(0);
    d.do(0, OP.move, 1);
    d.w.stock[o.crop] = o.qty;
    expect(d.do(0, OP.deliver, o.id)).toBe(0);     // not on barn
    d.advance(2);
    illegal(d.w, [d.w.tick, 0, OP.deliver]);
    illegal(d.w, [d.w.tick, 0, OP.deliver, 0]);
  });
  it('wait', () => {
    const d = sandbox();
    expect(d.do(0, OP.wait, 7)).toBe(1);
    expect(d.w.bots[0]!.busyUntil).toBe(7);
    d.advance(7);
    illegal(d.w, [7, 0, OP.wait, 0]);
    illegal(d.w, [7, 0, OP.wait, 1001]);
    illegal(d.w, [7, 0, OP.wait]);
    expect(d.do(0, OP.wait, 1000)).toBe(1);
  });
  it('sell', () => {
    const d = sandbox();
    d.w.stock[4] = 5;
    expect(d.do(0, OP.sell, 4, 6)).toBe(0);        // short
    expect(d.do(0, OP.sell, 4, 2)).toBe(12);
    expect(d.w.coins).toBe(12);
    expect(d.w.stock[4]).toBe(3);
    d.advance(1);
    illegal(d.w, [d.w.tick, 0, OP.sell, 4, 0]);
    illegal(d.w, [d.w.tick, 0, OP.sell, 8, 1]);    // compost is not sellable
    illegal(d.w, [d.w.tick, 0, OP.sell, 4]);
    d.do(0, OP.move, 1);
    d.advance(2);
    expect(d.do(0, OP.sell, 4, 1)).toBe(0);        // not on barn
  });
  it('overflow throws Error and leaves state', () => {
    const d = sandbox();
    d.w.stock[4] = 10;
    d.w.coins = Number.MAX_SAFE_INTEGER - 1;
    expect(() => d.do(0, OP.sell, 4, 1)).toThrow('overflow');
    expect(d.w.stock[4]).toBe(10);
  });
});

describe('buyPlot / buyBot', () => {
  it('buyPlot', () => {
    const d = sandbox();
    expect(d.do(-1, OP.buyPlot, 1, 0)).toBe(0);    // coins
    d.w.coins = 10000;
    expect(d.do(-1, OP.buyPlot, 0, 0)).toBe(0);    // owned
    expect(d.do(-1, OP.buyPlot, 1, 1)).toBe(0);    // diagonal
    expect(d.do(-1, OP.buyPlot, 1, 0)).toBe(1);
    expect(d.w.plots.length).toBe(2);
    expect(d.w.coins).toBe(10000 - 150);
    expect(d.w.spent).toBe(150);
    expect(d.w.bots[0]!.busyUntil).toBe(0);
    illegal(d.w, [d.w.tick, 0, OP.buyPlot, 2, 0]);
    illegal(d.w, [d.w.tick, -1, OP.buyPlot, 2]);
    illegal(d.w, [d.w.tick, -1, OP.buyPlot, 2.5, 0]);
  });
  it('buyBot', () => {
    const d = sandbox();
    expect(d.do(-1, OP.buyBot)).toBe(0);
    d.w.coins = 1000;
    expect(d.do(-1, OP.buyBot)).toBe(2);
    expect(d.w.coins).toBe(920);
    expect(d.w.spent).toBe(80);
    illegal(d.w, [d.w.tick, 0, OP.buyBot]);
  });
});
