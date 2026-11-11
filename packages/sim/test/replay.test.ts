import { describe, expect, it } from 'vitest';
import {
  IllegalAction, createWorld, deserialize, hashWorld, netWorth, replayChunk, serialize,
} from '../src/index.ts';
import { Driver, OP, farm, script } from './helpers.ts';

function recorded() {
  const d = new Driver(farm(31337));
  script(d, 200);
  d.w.coins += 0;
  const end = d.w.tick + 20;
  d.advance(20);
  return { d, end };
}

describe('replayChunk', () => {
  it('fresh replay matches', () => {
    const { d, end } = recorded();
    const w = createWorld(farm(31337));
    replayChunk(w, d.log, end);
    expect(w.tick).toBe(end);
    expect(hashWorld(w)).toBe(hashWorld(d.w));
    expect(netWorth(w)).toBe(netWorth(d.w));
  });
  it('two chunks with serialize/deserialize between', () => {
    const { d, end } = recorded();
    const mid = d.log[Math.floor(d.log.length / 2)]![0] + 1;
    const first = d.log.filter((e) => e[0] < mid), second = d.log.filter((e) => e[0] >= mid);
    const w1 = createWorld(farm(31337));
    replayChunk(w1, first, mid);
    const w2 = deserialize(serialize(w1));
    expect(hashWorld(w2)).toBe(hashWorld(w1));
    replayChunk(w2, second, end);
    expect(hashWorld(w2)).toBe(hashWorld(d.w));
    expect(deserialize(serialize(w2)).lastOp).toEqual(w2.lastOp);
  });
  it('rejects a busy-bot action and bad ticks', () => {
    const w = () => createWorld(farm(1));
    expect(() => replayChunk(w(), [[0, 0, OP.move, 1], [1, 0, OP.till]], 10)).toThrow(IllegalAction);
    expect(() => replayChunk(w(), [[5, 0, OP.wait, 1], [4, 0, OP.wait, 1]], 10)).toThrow(IllegalAction);
    expect(() => replayChunk(w(), [[10, 0, OP.wait, 1]], 10)).toThrow(IllegalAction);
    expect(() => replayChunk(w(), [[1.5, 0, OP.wait, 1]], 10)).toThrow(IllegalAction);
    expect(() => replayChunk(w(), [], -1)).toThrow(IllegalAction);
    const x = w(); x.tick = 5;
    expect(() => replayChunk(x, [[4, 0, OP.wait, 1]], 10)).toThrow(IllegalAction);
  });
});
