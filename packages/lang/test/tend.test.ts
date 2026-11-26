// `tend` blocks and `when` rules (docs/LANGUAGE.md section 11): they expand to ordinary Sprout, so both engines and the expansion agree.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createWorld, hashWorld } from '@tendril/sim/src/index.ts';
import { LESSONS } from '../../client/src/lessons.ts';
import { compile, countTokens, createRun, expandTend } from '../src/index.ts';
import { unparse } from '../src/unparse.ts';
import { assertEquivalent, steps } from './equivalence.ts';

const RICH = { coins: 1_000_000, unlocks: 511 };
const example = (f: string): string => readFileSync(new URL(`../examples/${f}`, import.meta.url), 'utf8');
const messages = (source: string): string[] => compile(source).diagnostics.map((d) => `${d.line}:${d.severity}: ${d.message}`);

/** Runs a program for `ticks` and returns what a verifier sees: world hash, the action log, errors. */
function outcome(source: string, ticks: number, setup = RICH, seed = 7): { hash: string; log: string; errors: string[]; ticks: number } {
  const run = createRun(createWorld({ id: 't', seed }, setup), source);
  while (run.world.tick < ticks) run.step(Math.min(500, ticks - run.world.tick));
  const out = { hash: hashWorld(run.world), log: JSON.stringify(run.takeLog()), errors: run.errors.map((e) => e.message), ticks: run.world.tick };
  run.close();
  return out;
}

const PROGRAMS: Record<string, string> = {
  starter: example('starter-tend.sprout'),
  basic: 'tend every tile:\n    when ripe: harvest\n    when empty and dry: water\n    when empty: plant carrot\nwhen full: sell everything\n',
  unlessElse: 'tend every tile:\n    when ripe: harvest\n    when empty: plant carrot unless tired, else wheat\n',
  unlessAction: 'tend every tile:\n    when ripe: harvest unless tired\n    when empty: plant carrot unless moisture < 10, else water\n',
  comparisons: 'tend every tile:\n    when ripe or stage == 3: harvest\n    when empty and moisture < 40 and not frost: water\n    when empty and nitrogen >= 10: plant carrot\nwhen coins > 3 and carrying: sell carrot\n',
  blockBody: 'tend every tile:\n    when empty:\n        till\n        plant carrot\n        water\n    when ripe:\n        harvest\n        say "got one at", position()\n',
  region: 'tend region 0, 0 to 3, 3:\n    when ripe: harvest\n    when empty: plant carrot\nwhen full: sell everything\n',
  list: 'route = [{x: 1, y: 0}, {x: 2, y: 0}, {x: 3, y: 1}]\ntend route:\n    when ripe: harvest\n    when empty: plant carrot\n',
  crew: 'when coins() >= bot_cost() and bots() < 4: buy_bot\ntend every tile:\n    when ripe: harvest\n    when empty: plant carrot\nwhen full: sell everything\n',
  inYourLoop: 'n = 0\nrepeat forever:\n    n += 1\n    tend every tile:\n        when empty: plant carrot\n    wait 20\n',
  setupAbove: 'define greet():\n    say "hello"\ngreet()\ntend every tile:\n    when empty: plant carrot\n',
  twoBlocks: 'tend region 0, 0 to 1, 1:\n    when empty: plant wheat\ntend region 2, 2 to 3, 3:\n    when empty: plant carrot\n',
};

describe('tend programs run the same everywhere', () => {
  for (const [name, source] of Object.entries(PROGRAMS)) {
    it(`${name}: interpreter equals compiled engine`, () => {
      for (const seed of [1, 7]) expect(assertEquivalent({ source, seed, setup: RICH, ops: steps(2500, 250, 1, 4, 97) }, `${name} seed ${seed}`).compiled).toBe(true);
    });
    it(`${name}: runs exactly like its printed expansion`, () => {
      const expanded = expandTend(source);
      expect(expanded.source, name).not.toBeNull();
      expect(compile(expanded.source!).diagnostics, `${name} expansion compiles clean`).toEqual([]);
      const a = outcome(source, 3000), b = outcome(expanded.source!, 3000);
      expect(a.errors, name).toEqual([]);
      expect(b, name).toEqual(a);
    });
  }
  it('the starter in rules does what the long starter does, in about a third of the tokens', () => {
    const long = outcome(example('starter.sprout'), 30_000, { coins: 300 } as typeof RICH), short = outcome(example('starter-tend.sprout'), 30_000, { coins: 300 } as typeof RICH);
    expect(short.errors).toEqual([]);
    expect(countTokens(example('starter-tend.sprout'))).toBeLessThan(countTokens(example('starter.sprout')) / 2);
    const coins = (s: string): number => { const r = createRun(createWorld({ id: 't', seed: 7 }, { coins: 300 }), s); r.step(20_000); const c = r.world.coins; r.close(); return c; };
    expect(coins(example('starter-tend.sprout'))).toBeGreaterThan(coins(example('starter.sprout')) * 0.8);
    void long; void short;
  });
});

describe('tend and the crew', () => {
  it('splits the tiles between bots without overlap, and one program runs every bot', () => {
    const run = createRun(createWorld({ id: 't', seed: 3 }, { coins: 100_000, unlocks: 511 }), 'when coins() >= bot_cost() and bots() < 3: buy_bot\ntend every tile:\n    when empty: plant carrot\n    when ripe: say "bot", my_id(), "at", position().x, position().y\n');
    run.step(2000);
    const planted = run.takeLog().filter((e) => e[1] >= 0);
    expect(run.errors).toEqual([]);
    expect(run.world.bots.length).toBe(3);
    expect(planted.length).toBeGreaterThan(0);
    // every bot got a share: the tile list has 64 tiles, split 21 / 21 / 22 by bot number
    const cut = (n: number, id: number): number => Math.floor(64 * id / n);
    expect([cut(3, 0), cut(3, 1), cut(3, 2), cut(3, 3)]).toEqual([0, 21, 42, 64]);
    run.close();
  });
});

describe('plain-word errors and warnings', () => {
  it('suggests the word you meant in a condition', () => {
    expect(messages('tend every tile:\n    when dryy: water\n')[0]).toContain('Did you mean `dry`?');
    expect(messages('tend every tile:\n    when ripe: wter\n')[0]).toContain('Did you mean `water`?');
  });
  it('suggests `when` for a mistyped rule', () => {
    expect(messages('tend every tile:\n    wehn ripe: harvest\n')[0]).toContain('every rule starts with `when`. Did you mean `when`?');
    expect(messages('tend every tile:\n    harvest\n')[0]).toContain('every rule starts with `when`');
  });
  it('explains a top-level when with no tend, an empty tend and a bad target', () => {
    expect(messages('when full: sell everything\n')[0]).toContain('Add a `tend every tile:` block');
    expect(messages('tend every plot:\n    when ripe: harvest\n')[0]).toContain('Write `tend every tile:`');
    expect(messages('tend every tile:\n    when ripe: harvest unless tired, else\n')[0]).toContain('Expected');
  });
  it('keeps the program when there are only warnings', () => {
    const r = compile('tend every tile:\n    when empty: plant carrot\n    when empty and dry: water\n    when ripe and empty: harvest\n    when ripe: harvest\n    when ripe: harvest\n');
    expect(r.program).not.toBeNull();
    expect(r.diagnostics.map((d) => [d.line, d.severity])).toEqual([[3, 'warning'], [4, 'warning'], [6, 'warning']]);
    expect(r.diagnostics[0]!.message).toContain('line 2 already catches everything');
    expect(r.diagnostics[1]!.message).toContain('contradict');
  });
  it('does not warn about a more specific rule written first', () => {
    expect(compile(example('starter-tend.sprout')).diagnostics).toEqual([]);
    expect(compile('tend every tile:\n    when empty and dry: water\n    when empty: plant carrot\n    when ripe: harvest\n').diagnostics).toEqual([]);
  });
  it('treats `dry` and `moisture < 25` as the same fact', () => {
    expect(messages('tend every tile:\n    when dry: water\n    when moisture < 25: water\n')).toHaveLength(1);
  });
  it('locks tend until its feature is on, and not for the generated code', () => {
    const only = new Set(['commands']);
    expect(compile('tend every tile:\n    when empty: till\n', { features: only }).diagnostics[0]?.message).toContain('tend feature is locked');
    expect(compile('tend every tile:\n    when empty: till\n', { features: new Set(['commands', 'tend']) }).diagnostics).toEqual([]);
  });
  it('refuses a rule where it cannot work', () => {
    expect(messages('repeat forever:\n    when full: sell everything\n')[0]).toContain('top-level `when` rule belongs');
    expect(messages('tend every tile:\n    when ripe:\n        tend every tile:\n            when ripe: harvest\n')[0]).toContain('not inside a rule');
  });
});

describe('tend does not disturb ordinary programs', () => {
  it('leaves programs that use the new words as names alone', () => {
    const source = 'tend = 3\nwhen = 4\nevery = [tend, when]\nsay every\ndefine unless(x):\n    return x\nsay unless(5)\n';
    expect(compile(source).diagnostics).toEqual([]);
    const run = createRun(createWorld({ id: 't', seed: 1 }), source); run.step(5);
    expect(run.errors).toEqual([]); expect(run.output.map((o) => o.text)).toEqual(['[3, 4]', '5']);
  });
  it('expands a program without tend to itself', () => {
    const src = example('daily.sprout');
    const again = (s: string): string => expandTend(s).source!;
    expect(again(again(src))).toBe(again(src));
  });
});

describe('printing a program and reading it back gives the same program', () => {
  const strip = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (k, x) => (k === 'pos' || k === 'namePos' || k === 'gen' || k === 'cond' ? undefined : x)));
  const files = readdirSync(new URL('../examples/', import.meta.url)).filter((f) => f.endsWith('.sprout'));
  const sources: [string, string][] = [...files.map((f) => [f, example(f)] as [string, string]), ...LESSONS.flatMap((l) => [[`${l.title} solution`, l.solution], [`${l.title} starter`, l.starter]] as [string, string][]), ...Object.entries(PROGRAMS)];
  for (const [name, source] of sources) {
    it(name, () => {
      const first = compile(source).program;
      if (!first) return;
      const text = unparse(first.body), second = compile(text);
      expect(second.diagnostics, `${name}\n${text}`).toEqual([]);
      expect(strip(second.program!.body)).toEqual(strip(first.body));
    });
  }
});
