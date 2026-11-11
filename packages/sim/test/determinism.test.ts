import { describe, expect, it } from 'vitest';
import { createWorld, hashWorld, netWorth, replayChunk } from '../src/index.ts';
import { Driver, farm, script } from './helpers.ts';

describe('determinism', () => {
  it('same seed + log gives same hash, other seed differs', () => {
    const d = new Driver(farm(777));
    script(d, 300);
    expect(d.log.length).toBeGreaterThanOrEqual(300);
    const end = d.w.tick + 50;
    d.advance(50);
    const run = (seed: number) => {
      const w = createWorld(farm(seed));
      replayChunk(w, d.log, end);
      return w;
    };
    const a = run(777), b = run(777);
    expect(hashWorld(a)).toBe(hashWorld(b));
    expect(hashWorld(a)).toBe(hashWorld(d.w));
    expect(netWorth(a)).toBe(netWorth(d.w));
    expect(hashWorld(run(778))).not.toBe(hashWorld(a));
  });
});
