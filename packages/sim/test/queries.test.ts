import { describe, expect, it } from 'vitest';
import {
  forecast, hashWorld, openOrders, scan, scanAt, snapshot, weatherAt, plotCost, botCost, netWorth,
} from '../src/index.ts';
import { Driver, farm, script } from './helpers.ts';

describe('queries are pure', () => {
  it('do not change the hash', () => {
    const d = new Driver(farm(55));
    script(d, 120);
    d.advance(6000);
    const h = hashWorld(d.w);
    scan(d.w, 0); scanAt(d.w, 2, 0); scanAt(d.w, 99, 99); snapshot(d.w);
    const f = forecast(d.w, 100000);
    weatherAt(d.w, 50000); weatherAt(d.w, d.w.tick); openOrders(d.w);
    expect(f.length).toBeGreaterThan(10);
    expect(hashWorld(d.w)).toBe(h);
  });
  it('forecast and weatherAt agree, snapshot is consistent', () => {
    const d = new Driver(farm(55));
    d.advance(1500);
    for (const s of forecast(d.w, 3000)) {
      expect(s.end).toBeGreaterThan(d.w.tick);
      expect(s.start).toBeLessThan(d.w.tick + 3000);
      expect(weatherAt(d.w, s.start)).toBe(s.kind);
      expect(weatherAt(d.w, s.end - 1)).toBe(s.kind);
      expect(weatherAt(d.w, s.end)).toBe('clear');
    }
    const s = snapshot(d.w);
    expect(s.tiles.length).toBe(64);
    expect(s.netWorth).toBe(netWorth(d.w));
    expect(s.plotCost).toBe(plotCost(d.w));
    expect(s.botCost).toBe(botCost(d.w));
    expect(s.bots[0]!.op).toBeNull();
    expect(s.tiles[0]).toMatchObject({ x: 0, y: 0, moisture: scanAt(d.w, 0, 0)!.moisture });
  });
});
