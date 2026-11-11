import { describe, expect, it } from 'vitest';
import { createWorld, hashWorld, replayChunk } from '../src/index.ts';
import { Driver, OP, farm } from './helpers.ts';

describe('performance', () => {
  it('replays 1,000,000 ticks with 20,000 actions in under 2s', () => {
    const d = new Driver(farm(2024));
    d.do(0, OP.move, 1);
    const cycle = [() => d.do(0, OP.till), () => d.do(0, OP.plant, 2), () => d.do(0, OP.water),
      () => d.do(0, OP.harvest), () => d.do(0, OP.wait, 242)];
    for (let i = 0; d.log.length < 20000; i++) cycle[i % 5]!();
    const end = Math.max(1_000_000, d.w.tick + 1);
    d.advance(end - d.w.tick);
    const log = d.log;
    const w = createWorld(farm(2024));
    const t0 = performance.now();
    replayChunk(w, log, end);
    const ms = performance.now() - t0;
    expect(w.tick).toBe(end);
    expect(hashWorld(w)).toBe(hashWorld(d.w));
    expect(ms).toBeLessThan(2000);
  });
});
