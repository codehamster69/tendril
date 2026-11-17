// The compiled engine against the reference interpreter. If any of these fail, the compiled engine is wrong (the reference defines correct).
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LESSONS } from '../../client/src/lessons.ts';
import { REFERENCE_SOURCE } from '../../server/src/reference.ts';
import { compile } from '../src/index.ts';
import { assertEquivalent, steps } from './equivalence.ts';
import type { Case, Op } from './equivalence.ts';
import { genProgram, mulberry32 } from './fuzz.ts';

const RICH = { coins: 1_000_000, unlocks: 511 };
const examples = readdirSync(new URL('../examples/', import.meta.url)).filter((f) => f.endsWith('.sprout')).map((f) => [f, readFileSync(new URL(`../examples/${f}`, import.meta.url), 'utf8')] as const);

describe('compiled engine matches the reference', () => {
  it('actually runs compiled code', () => {
    expect(assertEquivalent({ source: 'till\n', ops: steps(5, 5) }).compiled).toBe(true);
  });

  for (const [file, source] of examples) {
    it(`example ${file}`, () => {
      for (const seed of [1, 7, 42]) assertEquivalent({ source, seed, setup: seed === 1 ? RICH : { coins: 5000, unlocks: 511 }, ops: steps(1500, 250, 1, 4, 97) }, `${file} seed ${seed}`);
    });
  }

  it('the server reference program', () => {
    for (const seed of [3, 11]) assertEquivalent({ source: REFERENCE_SOURCE, seed, ops: steps(3000, 250, 4) }, `reference seed ${seed}`);
  });

  for (const lesson of LESSONS) {
    it(`lesson ${lesson.title}`, () => {
      for (const source of [lesson.solution, lesson.starter]) {
        const features = new Set(lesson.features);
        assertEquivalent({ source, seed: lesson.seed, setup: lesson.setup, ops: steps(lesson.tickLimit, 250, 4), options: { features } }, lesson.title);
      }
    });
  }

  it('a big farm with many bots (the stress program)', () => {
    const source = `repeat forever:
    if my_id() == 0:
        while bots() < 12 and coins() >= bot_cost():
            buy_bot
        while len(plots()) < 6 and coins() >= plot_cost():
            n = len(plots())
            buy_plot n % 3, (n - n % 3) / 3
    for each tile in tiles():
        if tile.x % bots() == my_id():
            go_to tile
            if scan().ripe:
                harvest
            if scan().empty:
                till
                plant carrot
    go_to barn
    deposit
    sell carrot, all
    wait 5
`;
    assertEquivalent({ source, seed: 20261116, setup: { coins: 100_000_000 }, ops: steps(1200, 250, 3) });
  });

  describe('edge cases', () => {
    const cases: Record<string, string> = {
      'step limit per tick': 'repeat forever:\n    pass\n',
      'pure loops past the step limit then an action': 'a = 0\nwhile a < 4000:\n    a += 1\nsay a\nmove east\nsay tick()\nfor each i in range(3000):\n    a += i\nsay a\nwait 3\n',
      'break in a function ends the callers loop': 'define stop_it():\n    break\nrepeat 5 times:\n    say "x"\n    stop_it()\nsay "after"\n',
      'continue in a function': 'define skip():\n    continue\nfor i from 1 to 4:\n    say i\n    skip()\n    say "no"\nsay "done"\n',
      'break outside any loop': 'say 1\nbreak\nsay 2\n',
      'return at top level': 'say 1\nreturn 5\n',
      'return from nested loops in a function': 'define find(n):\n    for i from 0 to 10:\n        repeat 3 times:\n            if i == n:\n                return i * 10\n    return -1\nsay find(4)\nsay find(40)\n',
      'stop inside a function': 'define quit():\n    say "bye"\n    stop\nsay "a"\nquit()\nsay "b"\n',
      'recursion depth limit': 'define down(n):\n    return down(n + 1)\ndown(0)\n',
      'recursion that finishes': 'define fib(n):\n    if n < 2:\n        return n\n    return fib(n - 1) + fib(n - 2)\nsay fib(12)\n',
      'wrong argument count': 'define f(a, b):\n    return a\nf(1)\n',
      'global declarations': 'total = 0\ndefine add(n):\n    global total\n    total += n\n    local = n\n    return local\nadd(2)\nadd(5)\nsay total\nsay local\n',
      'shadowed builtin name': 'define till():\n    say "mine"\ntill()\nfor each water in [1]:\n    water()\n',
      'builtin through a variable': 'f = {builtin: "till"}\nf()\nf2 = say\nf2("hi")\ng = scan\nsay g().empty\n',
      'function equality and printing': 'define f():\n    pass\ndefine g():\n    pass\nsay f == g\nsay f\nsay [f]\nsay f == f\nsay len\n',
      'record and list aliasing': 'xs = [1, 2]\nys = xs\nappend ys, 3\nsay xs\nr = {a: [1]}\nr.a[0] = 9\nsay r\nshared.n = 1\nshared.n += 1\nsay shared\n',
      'compound assignment evaluates the target twice': 'define side():\n    say "side"\n    return 0\nxs = [1, 2]\nxs[side()] += 5\nr = {k: 1}\nr.k *= 4\nsay xs, r\n',
      'string interpolation and long strings': 's = "ab"\nrepeat 20 times:\n    s = s + s\nsay "never"\n',
      'long lists': 'xs = range(100000)\nxs = xs + xs\n',
      'division and numbers': 'say 7 / 2, -7 / 2, 7 % 3, -7 % 3, 7 % -3, 5 / 0\n',
      'big numbers': 'a = 9007199254740991\nsay a\nsay a + 1\n',
      'unknown names and constants': 'x = 1\nsay north\nnorth()\nsay hive\n',
      'times with huge count': 'repeat 1000000 times:\n    pass\n',
      'multi line expressions': 'xs = [1, scan().ripe, harvest()]\nsay xs\nsay "n={len(xs)} {xs[0]}"\n',
      'sorting and comparing': 'say sorted([3, 1, 2]), sorted(["b", "a"]), sorted([1, "a"])\n',
      'for over strings and records': 'for each ch in "abc":\n    say ch\nfor each k in {x: 1, y: 2}:\n    say k\nfor each v in 5:\n    say v\n',
      'loop variable shadows a builtin': 'for each scan in [1, 2]:\n    say scan\nsay scan\n',
      'in and not in': 'say 1 in [1, 2], 3 not in [1, 2], "a" in "abc", "k" in {k: 1}, 1 in 5\n',
      'random is per bot': 'if bots() < 4:\n    buy_bot\nsay random(100)\nsay random(100)\n',
      'farm operations do not end the turn': 'buy_plot 1, 0\nbuy_plot 0, 1\nsay len(plots())\nunlock clover\nsay unlocked(clover)\nsell_plot 1, 0\nsay coins() > 0\n',
      'sell with zero units takes no time': 'sell carrot, all\nsell carrot, 0\nsay tick()\nmove east\nsay tick()\n',
      'while with a function condition': 'n = 0\ndefine more():\n    n += 1\n    return n < 4\nwhile more():\n    say n\n',
    };
    for (const [name, source] of Object.entries(cases)) {
      it(name, () => {
        for (const setup of [{ coins: 100_000, unlocks: 511 }, undefined]) assertEquivalent({ source, setup, ops: steps(60, 1, 2, 7, 50), options: { stepBudget: 1_000_000 } }, name);
      });
    }
    it('step budget and allocation budget', () => {
      const source = 'xs = []\nrepeat forever:\n    append xs, range(1000)\n    xs = xs + [1]\n';
      for (const [stepBudget, allocationBudget] of [[300, undefined], [50_000, undefined], [undefined, 20_000], [1000, 10]] as const) {
        assertEquivalent({ source, setup: RICH, ops: steps(40, 4), options: { stepBudget, allocationBudget } }, `${stepBudget} ${allocationBudget}`);
      }
    }, 60_000);
    it('breakpoints, line stepping and resuming', () => {
      const source = 'if bots() < 3:\n    buy_bot\na = 0\ndefine f(n):\n    a += n\n    say a\n    return a\nrepeat forever:\n    f(1)\n    move east\n    f(2)\n    wait 2\n';
      const ops: Op[] = [{ op: 'breakpoints', lines: [5, 10] }, ...Array.from({ length: 25 }, (_, i): Op => (i % 5 === 4 ? { op: 'stepLine' } : i % 7 === 6 ? { op: 'breakpoints', lines: [] } : i % 3 === 0 ? { op: 'resume' } : { op: 'step', ticks: 3 }))];
      assertEquivalent({ source, setup: RICH, ops }, 'breakpoints');
    });
  });

  describe('random programs', () => {
    const N = Number(process.env.FUZZ_COUNT ?? 300);
    it(`${N} generated programs, with budgets, breakpoints and line stepping`, () => {
      let valid = 0, withErrors = 0, withActions = 0, exhausted = 0;
      for (let seed = 1; seed <= N; seed++) {
        const source = genProgram(seed);
        if (!compile(source).program) continue;
        valid++;
        const rng = mulberry32(seed * 7919);
        const lines = source.split('\n').length;
        const debug = rng() < 0.35;
        const ops: Op[] = debug
          ? [{ op: 'breakpoints', lines: [1 + Math.floor(rng() * lines), 1 + Math.floor(rng() * lines)] }, ...Array.from({ length: 30 }, (): Op => { const r = rng(); return r < 0.2 ? { op: 'stepLine' } : r < 0.45 ? { op: 'resume' } : r < 0.5 ? { op: 'breakpoints', lines: rng() < 0.5 ? [] : [1 + Math.floor(rng() * lines)] } : { op: 'step', ticks: 1 + Math.floor(rng() * 6) }; })]
          : steps(90, 1, 3, 4, 9, 20);
        const stepBudget = [3_000, 30_000, 400_000, undefined][Math.floor(rng() * 4)];
        const allocationBudget = rng() < 0.2 ? 2_000 : undefined;
        const c: Case = { source, seed, setup: rng() < 0.7 ? RICH : undefined, ops, options: { stepBudget, allocationBudget } };
        try {
          const r = assertEquivalent(c, `fuzz ${seed}`);
          if (r.errors) withErrors++; if (r.actions) withActions++; if (r.steps >= (stepBudget ?? Infinity)) exhausted++;
        } catch (e) { (e as Error).message = `fuzz seed ${seed}\n${source}\n${(e as Error).message}`; throw e; }
      }
      console.log(`fuzz: ${valid}/${N} compiled, ${withActions} acted, ${withErrors} had runtime errors, ${exhausted} spent their budget`);
      expect(valid).toBeGreaterThan(N * 0.5);
    }, 600_000);
  });
});
