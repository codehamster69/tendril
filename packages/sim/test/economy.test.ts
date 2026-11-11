import { describe, expect, it } from 'vitest';
import { applyAction, botCost, netWorth, plotCost, scan } from '../src/index.ts';
import { Driver, OP } from './helpers.ts';

describe('economy', () => {
  it('cost formulas', () => {
    const d = new Driver();
    d.w.coins = 100000;
    expect(plotCost(d.w)).toBe(150);
    expect(botCost(d.w)).toBe(80);
    d.do(-1, OP.buyPlot, 1, 0);
    expect(plotCost(d.w)).toBe(600);
    d.do(-1, OP.buyPlot, 2, 0);
    expect(plotCost(d.w)).toBe(1350);
    d.do(-1, OP.buyBot);
    expect(botCost(d.w)).toBe(320);
    d.do(-1, OP.buyBot);
    expect(botCost(d.w)).toBe(720);
    expect(d.w.spent).toBe(150 + 600 + 80 + 320);
    expect(netWorth(d.w)).toBe(d.w.coins + d.w.spent);
  });
  it('adjacency including negative plots, and movement onto bought land', () => {
    const d = new Driver();
    d.w.coins = 100000;
    expect(d.do(0, OP.move, 3)).toBe(0);            // west of barn is unowned
    expect(d.do(-1, OP.buyPlot, -2, 0)).toBe(0);    // not adjacent
    expect(d.do(-1, OP.buyPlot, -1, 0)).toBe(1);
    d.advance(2);
    expect(d.do(0, OP.move, 3)).toBe(1);
    expect(d.w.bots[0]!.x).toBe(-1);
    expect(scan(d.w, 0).barn).toBe(false);
    expect(d.do(-1, OP.buyPlot, -1, -1)).toBe(1);   // north of (-1,0)
    expect(d.do(-1, OP.buyPlot, 0, -1)).toBe(1);
    d.advance(2);
    for (let i = 0; i < 7; i++) { d.do(0, OP.move, 3); }
    expect(d.w.bots[0]!.x).toBe(-8);
    expect(d.do(0, OP.move, 3)).toBe(0);            // plot (-2,0) unowned
    expect(d.do(0, OP.move, 0)).toBe(1);            // y -1 in plot (-1,-1)
    expect(d.w.bots[0]!.y).toBe(-1);
  });
  it('bought bot appears at barn and acts the same tick', () => {
    const d = new Driver();
    d.w.coins = 500;
    d.do(0, OP.wait, 50);
    expect(d.do(-1, OP.buyBot)).toBe(2);
    expect(d.w.bots[1]).toMatchObject({ x: 0, y: 0, busyUntil: 0 });
    expect(applyAction(d.w, [d.w.tick, 1, OP.move, 1])).toBe(1);
    expect(d.w.bots[1]!.x).toBe(1);
  });
});
