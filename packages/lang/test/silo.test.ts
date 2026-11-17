import { describe, expect, it } from 'vitest';
import { API, createRun } from '../src/index.ts';
import { createWorld, SILO_BIT } from '@tendril/sim/src/index.ts';
import type { Setup } from '@tendril/sim/src/index.ts';
import { verifySource } from '../src/verify.ts';

const run = (source: string, setup?: Setup, ticks = 400) => { const r = createRun(createWorld({ id: 'test', seed: 42 }, setup), source); r.step(ticks); return r; };
const researched: Setup = { coins: 5000, unlocks: 1 | (1 << SILO_BIT) };
const v5: Setup = { ...researched, siloTick: 0 };
const texts = (r: ReturnType<typeof run>) => r.output.map((o) => o.text);

describe('silo commands', () => {
  it('lists the new names in the API table and as constants', () => {
    for (const name of ['silo_cost', 'silos', 'nearest_drop']) expect(API.find((a) => a.name === name)?.kind).toBe('query');
    expect(API.find((a) => a.name === 'silo')?.kind).toBe('constant');
    expect(API.find((a) => a.name === 'nearest_drop')?.example).toBe('go_to nearest_drop()');
  });
  it('names a silo in the build error', () => {
    const r = run('build carrot');
    expect(r.errors.map((e) => e.message).join(' ')).toContain('Build a hive, composter or silo.');
  });
  it('reports the barn as the only drop before silo rules are on', () => {
    const r = run('say silo_cost()\nsay silos()\ngo_to nearest_drop()\nsay position()', researched);
    expect(r.errors).toEqual([]);
    expect(texts(r)).toEqual(['0', '[]', '{x: 0, y: 0}']);
  });
  it('does not build a silo without the research', () => {
    const r = run('move east\nbuild silo\nsay silos()', { coins: 5000 });
    expect(r.errors).toEqual([]);
    expect(texts(r)).toEqual(['[]']);
  });
  it('builds a silo under the bot, lists it, prices the next one, and walks to it', () => {
    const r = run('move east\nbuild silo\nsay silo_cost()\nsay silos()\ngo_to nearest_drop()\nsay position()', v5);
    expect(r.errors).toEqual([]);
    expect(texts(r)).toEqual(['2000', '[{x: 1, y: 0}]', '{x: 1, y: 0}']);
  });
  it('breaks ties toward the barn', () => {
    const r = run('move east\nmove east\nbuild silo\nmove west\nsay nearest_drop()\ngo_to nearest_drop()\nsay position()', v5);
    expect(r.errors).toEqual([]);
    expect(texts(r)).toEqual(['{x: 0, y: 0}', '{x: 0, y: 0}']);
  });
  it('runs a silo program on the server verify path', () => {
    const source = 'move east\nbuild silo\nfor each n in range(3):\n    go_to nearest_drop()\n    go_to barn\n';
    const result = verifySource({ source, challengeId: 'silo-test', kind: 'season', seed: 42, ticks: 1500, rulesVersion: 5, market: null });
    expect(result).toMatchObject({ ok: true });
  });
});

describe('sell_plot command', () => {
  it('sells an edge plot under rules v5 and refuses the barn plot', () => {
    const r = run('buy_plot 1, 0\nsell_plot 1, 0\nsell_plot 0, 0\nsay len(plots())', v5);
    expect(r.errors).toEqual([]);
    expect(texts(r)).toEqual(['1']);
  });
  it('does nothing before rules v5', () => {
    const r = run('buy_plot 1, 0\nsell_plot 1, 0\nsay len(plots())', researched);
    expect(r.errors).toEqual([]);
    expect(texts(r)).toEqual(['2']);
  });
});
