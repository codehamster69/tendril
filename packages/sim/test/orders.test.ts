import { describe, expect, it } from 'vitest';
import { CROPS, netWorth, openOrders } from '../src/index.ts';
import { Driver, OP } from './helpers.ts';

describe('orders', () => {
  it('appear, scale with plots, expire', () => {
    const a = new Driver(), b = new Driver();
    b.w.coins = 10000;
    b.do(-1, OP.buyPlot, 1, 0); b.do(-1, OP.buyPlot, 2, 0);
    expect(b.w.plots.length).toBe(3);
    a.advance(200); b.advance(200 - b.w.tick);
    expect(a.w.orders.length).toBe(1);
    expect(b.w.orders[0]!.qty).toBe(3 * a.w.orders[0]!.qty);
    expect(b.w.orders[0]!.crop).toBe(a.w.orders[0]!.crop);
    expect(a.w.orders[0]!.qty % 1).toBe(0);
    const seen = new Set<number>();
    for (let t = 200; t < 20000; t++) {
      a.advance(1);
      for (const o of a.w.orders) { seen.add(o.id); expect(o.deadline).toBeGreaterThanOrEqual(a.w.tick); }
    }
    expect(seen.size).toBeGreaterThan(8);
    const open = new Set(openOrders(a.w).map((o) => o.id));
    expect([...seen].some((id) => !open.has(id))).toBe(true);
    expect(a.w.orders.length).toBeLessThan(seen.size);
  });
  it('orders exist after 5000 ticks', () => {
    const d = new Driver();
    d.advance(5000);
    expect(d.w.orders.length).toBeGreaterThan(0);
    expect(d.w.nextOrderId).toBeGreaterThan(3);
  });
  it('deliver pays the reward and removes the order', () => {
    const d = new Driver();
    d.advance(200);
    const o = d.w.orders[0]!;
    expect(o.reward).toBe(o.qty * CROPS[o.crop]!.price * 2 + 10);
    d.w.stock[o.crop] = o.qty + 3;
    const nw = netWorth(d.w);
    expect(d.do(0, OP.deliver, o.id)).toBe(o.reward);
    expect(d.w.coins).toBe(o.reward);
    expect(d.w.stock[o.crop]).toBe(3);
    expect(d.w.orders.find((x) => x.id === o.id)).toBeUndefined();
    expect(netWorth(d.w)).toBe(nw - o.qty * CROPS[o.crop]!.price + o.reward);
    d.advance(3);
    expect(d.do(0, OP.deliver, o.id)).toBe(0);      // gone
  });
});
