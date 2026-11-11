import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { API, compile, createRun } from '../src/index.ts';
import { createWorld, deserialize, hashWorld, replayChunk, serialize } from '@tendril/sim/src/index.ts';
const execute = (source: string, ticks = 500) => { const run = createRun(createWorld({ id: 'test', seed: 42 }), source); run.step(ticks); return run; };

describe('Sprout language', () => {
  it('supports variables, command forms, loops, expressions and functions', () => {
    const run = execute('define square(n):\n    return n * n\nx = 0\nfor i from 1 to 3:\n    x += square(i)\nrepeat 2 times:\n    x += 1\nif x == 16:\n    say "sum {x}"\nelse:\n    say "wrong"\n');
    expect(run.errors).toEqual([]); expect(run.output.map((o) => o.text)).toEqual(['sum 16']);
  });
  it('handles collections, mutation, negative indexing and scope', () => {
    const run = execute('x = 1\ndefine grow():\n    global x\n    x += 2\nxs = [1, 2]\nappend xs, 3\nr = {ok: true}\nr.count = len(xs)\ngrow()\nsay xs[-1], r.count, x, -3 / 2, -3 % 2\n');
    expect(run.errors).toEqual([]); expect(run.output[0]?.text).toBe('3 3 3 -2 1');
  });
  it('rejects syntax, unknown names and locked features', () => {
    expect(compile('if true\n    pass').program).toBeNull();
    expect(compile('plnat carrot').diagnostics[0]?.message).toContain('plant');
    expect(compile('repeat forever:\n    pass', { features: new Set(['commands']) }).program).toBeNull();
    expect(compile('plant = 1').program).toBeNull();
  });
  it('does not hang on a non-yielding infinite loop', () => {
    const run = execute('repeat forever:\n    pass', 10); expect(run.world.tick).toBe(10); expect(run.debug()[0]?.status).toBe('thinking');
  });
  it('isolates runtime errors from the host', () => {
    const run = execute('say 1 / 0'); expect(run.errors[0]?.message).toContain('zero'); expect(run.world.tick).toBe(500);
    expect(execute('xs = []\nsay xs[0]').errors[0]?.message).toContain('range');
  });
  it('replays real farming without executing player code on the server', () => {
    const source = readFileSync(new URL('../examples/daily.sprout', import.meta.url), 'utf8');
    const a = execute(source, 3000), b = execute(source, 3000);
    expect(a.errors).toEqual([]); expect(a.world.coins).toBeGreaterThan(0); expect(a.pending).toEqual(b.pending);
    const replay = createWorld({ id: 'test', seed: 42 }); replayChunk(replay, a.pending, a.world.tick);
    expect(hashWorld(replay)).toBe(hashWorld(a.world)); expect(hashWorld(deserialize(serialize(replay)))).toBe(hashWorld(replay));
  });
  it('breakpoints and line stepping preserve action order', () => {
    const source = 'repeat 3 times:\n    move east\n    till\n    plant carrot\n';
    const plain = execute(source, 100), paused = createRun(createWorld({ id: 'test', seed: 42 }), source);
    paused.setBreakpoints([3]); let guard = 0;
    while (paused.world.tick < 100 && guard++ < 50) paused.step(100 - paused.world.tick);
    expect(paused.world.tick).toBe(100); expect(paused.pending).toEqual(plain.pending); expect(hashWorld(paused.world)).toBe(hashWorld(plain.world));
    const debug = execute('x = 42\nwait 100'); expect(debug.debug()[0]?.vars.find((v) => v.name === 'x')?.value).toBe('42');
  });
  it('all shipped examples compile and run with researched fixtures', () => {
    for (const file of readdirSync(new URL('../examples/', import.meta.url))) {
      const source = readFileSync(new URL(`../examples/${file}`, import.meta.url), 'utf8');
      expect(compile(source).diagnostics, file).toEqual([]);
      const run = createRun(createWorld({ id: file, seed: 42 }, { coins: 5000, unlocks: 511 }), source); run.step(3000);
      expect(run.errors, file).toEqual([]);
    }
  });
  it('the reference examples compile', () => { for (const api of API) expect(compile(api.example).diagnostics, api.name).toEqual([]); });
  it('bounded malformed source returns diagnostics rather than a host exception', () => {
    let seed = 1;
    for (let i = 0; i < 200; i++) { seed = Math.imul(seed, 1664525) + 1013904223 | 0; const source = Array.from({ length: 30 }, (_, j) => ' :[]()#"abcd12\n'[(seed >>> (j % 24)) % 14]).join(''); expect(() => compile(source)).not.toThrow(); }
  });
});
