import { describe, expect, it } from 'vitest';
import { createWorld, hashWorld } from '@tendril/sim/src/index.ts';
import { API, createRun } from '../src/index.ts';
import type { BriefFields } from '../src/brief.ts';

// K1 adds these fields to the world; until it merges they are stubbed onto a plain world.
const briefWorld = (fields: BriefFields) => Object.assign(createWorld({ id: 'brief', seed: 5 }, { coins: 5000, unlocks: 511 }), fields);
const probe = 'say goal()\nsay budget()\nsay twists()\nsay quota(carrot)\nsay quota(pumpkin)\nsay bot_cap()\nsay plot_cap()\nsay bot_cap() is none';
const both = (fields: BriefFields | null, source = probe) => {
  const outs = (['reference', 'compiled'] as const).map((engine) => {
    const world = fields ? briefWorld(fields) : createWorld({ id: 'brief', seed: 5 }, { coins: 5000, unlocks: 511 });
    const r = createRun(world, source, { engine }); r.step(50);
    const out = { text: r.output.map((o) => o.text), errors: r.errors.map((e) => e.message), hash: hashWorld(r.world) };
    r.close(); return out;
  });
  expect(outs[1]).toEqual(outs[0]);
  return outs[0]!;
};

describe('brief queries', () => {
  it('are listed as free queries', () => {
    for (const name of ['goal', 'quota', 'budget', 'twists', 'bot_cap', 'plot_cap']) {
      const e = API.find((a) => a.name === name); expect(e?.kind).toBe('query'); expect(e?.ticks).toBe(0);
    }
  });
  it('return neutral values with no brief', () => {
    const r = both(null);
    expect(r.errors).toEqual([]);
    expect(r.text).toEqual(['wealth', '0', '[]', '0', '0', 'none', 'none', 'true']);
  });
  it('read the brief on both engines', () => {
    const r = both({ goal: { kind: 'festival', budget: 3000, quotas: [0, 10, 0, 0, 4, 0, 0, 0] }, botCap: 3, twistKeys: ['drought', 'bot_cap'], deposited: [0, 4, 0, 0, 1, 0, 0, 0] });
    expect(r.errors).toEqual([]);
    expect(r.text).toEqual(['festival', '3000', '[drought, bot_cap]', '6', '3', '3', 'none', 'false']);
  });
  it('never go below zero once a quota is filled', () => {
    const r = both({ goal: { kind: 'festival', budget: 3000, quotas: [0, 2, 0, 0, 0, 0, 0, 0] }, deposited: [0, 9, 0, 0, 0, 0, 0, 0] }, 'say quota(carrot)');
    expect(r.text).toEqual(['0']);
  });
  it('reject an unknown item and cost no ticks', () => {
    const r = both(null, 'say quota(north)\nsay tick()');
    expect(r.errors.length).toBeGreaterThan(0);
  });
  it('are reserved words like every built-in', () => {
    expect(() => createRun(createWorld({ id: 'brief', seed: 5 }), 'goal = 3', { engine: 'reference' })).toThrow('not a built-in');
  });
  it('do not change the world hash', () => {
    expect(both(null, 'say goal()').hash).toBe(both(null, 'say 1').hash);
  });
});
