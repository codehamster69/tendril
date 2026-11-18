import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RULES_VERSION, SETUP_BRIEF, challengeSetup } from '@tendril/sim/src/index.ts';
import { farmSeedFor, playLocal } from '../src/arena-cli.ts';
import type { Challenge } from '../src/arena-cli.ts';

const example = fileURLToPath(new URL('../examples/daily.sprout', import.meta.url));
const SEED = 4242;
const base: Challenge = { id: 'd-2026-12-09', kind: 'daily', number: 9, seed: SEED, ticks: 3000, par: null, rulesVersion: RULES_VERSION, setupVersion: SETUP_BRIEF, market: null, siblingSeeds: null };

describe('farmSeedFor', () => {
  it('plays the visible farm by default and the seed asked for when it is a hidden farm', () => {
    expect(farmSeedFor(base, {})).toBe(SEED);
    expect(farmSeedFor({ ...base, siblingSeeds: [11, 22] }, { farm: 22 })).toBe(22);
    expect(farmSeedFor({ ...base, siblingSeeds: [11, 22] }, { farm: SEED })).toBe(SEED);
  });

  it('refuses a hidden farm until the challenge closes, and a seed that is not one of its farms', () => {
    expect(() => farmSeedFor(base, { farm: 11 })).toThrow(/published when it closes/);
    expect(() => farmSeedFor({ ...base, siblingSeeds: [11, 22] }, { farm: 33 })).toThrow(/not a hidden farm/);
  });

  it('accepts any seed when the server does not publish siblings, and rejects a non-number', () => {
    expect(farmSeedFor({ ...base, siblingSeeds: undefined }, { farm: 33 })).toBe(33);
    expect(() => farmSeedFor(base, { farm: Number.NaN })).toThrow(/whole number/);
  });

  it('practice draws a random 32-bit farm seed', () => {
    const seeds = new Set(Array.from({ length: 5 }, () => farmSeedFor(base, { practice: true })));
    expect(seeds.size).toBeGreaterThan(1);
    for (const s of seeds) expect(Number.isSafeInteger(s) && s >= 0 && s < 2 ** 32).toBe(true);
  });
});

describe('playLocal on a brief day', () => {
  const source = readFileSync(example, 'utf8');

  it('scores a brief day by its goal, on the visible and a hidden farm', () => {
    const { brief } = challengeSetup('daily', SEED, SETUP_BRIEF);
    expect(brief).toBeDefined();
    const visible = playLocal(base, source);
    const hidden = playLocal(base, source, 777);
    expect(Number.isSafeInteger(visible.score)).toBe(true);
    expect(Number.isSafeInteger(hidden.score)).toBe(true);
    expect(visible.errors).toEqual([]);
    expect(visible.challengeId).toBe(base.id);
  });
});
