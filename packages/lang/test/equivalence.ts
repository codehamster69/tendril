// Differential harness: the compiled engine must match the reference interpreter in everything observable.
import { expect } from 'vitest';
import { createWorld, hashWorld } from '@tendril/sim/src/index.ts';
import type { Setup } from '@tendril/sim/src/index.ts';
import { createRun } from '../src/index.ts';
import type { RunOptions, ScriptRun } from '../src/index.ts';

export type Op = { op: 'step'; ticks: number } | { op: 'stepLine' } | { op: 'breakpoints'; lines: number[] } | { op: 'resume' };
export interface Case { source: string; seed?: number; setup?: Setup; ops: Op[]; options?: RunOptions }

const heatOf = (r: ScriptRun): [number, number][] => [...r.lineHeat()].sort((a, b) => a[0] - b[0]);

/** Runs the same operations on both engines and compares everything after every operation. Returns the reference's final state. */
export function assertEquivalent(c: Case, label = ''): { ticks: number; actions: number; errors: number; steps: number; compiled: boolean } {
  const seed = c.seed ?? 42;
  const ref = createRun(createWorld({ id: 'eq', seed }, c.setup), c.source, { ...c.options, engine: 'reference' });
  const fast = createRun(createWorld({ id: 'eq', seed }, c.setup), c.source, { ...c.options, engine: 'compiled' });
  const compiled = (fast as { engine?: string }).engine === 'compiled';
  let actions = 0;
  c.ops.forEach((op, n) => {
    const where = `${label} op ${n} ${JSON.stringify(op)}`;
    let a, b;
    if (op.op === 'step') { a = ref.step(op.ticks); b = fast.step(op.ticks); }
    else if (op.op === 'resume') { a = ref.step(1); b = fast.step(1); }
    else if (op.op === 'stepLine') { a = ref.stepLine(); b = fast.stepLine(); }
    else { ref.setBreakpoints(op.lines); fast.setBreakpoints(op.lines); a = b = { ticks: 0, paused: null }; }
    expect(b, where).toEqual(a);
    expect(fast.world.tick, where).toBe(ref.world.tick);
    expect(fast.pending, `${where} log`).toEqual(ref.pending);
    const log = ref.takeLog(); fast.takeLog(); actions += log.length;
    expect(fast.errors, `${where} errors`).toEqual(ref.errors);
    expect(fast.output, `${where} output`).toEqual(ref.output);
    expect(fast.steps, `${where} steps`).toBe(ref.steps);
    expect(fast.exhausted, `${where} exhausted`).toBe(ref.exhausted);
    expect(hashWorld(fast.world), `${where} world`).toBe(hashWorld(ref.world));
    expect(fast.debug(), `${where} debug`).toEqual(ref.debug());
    expect(heatOf(fast), `${where} heat`).toEqual(heatOf(ref));
  });
  const out = { ticks: ref.world.tick, actions, errors: ref.errors.length, steps: ref.steps, compiled };
  ref.close(); fast.close();
  return out;
}

/** Steps in the given slice sizes until `total` ticks have run. */
export const steps = (total: number, ...slices: number[]): Op[] => {
  const ops: Op[] = []; let done = 0, i = 0;
  while (done < total) { const n = Math.min(slices[i++ % slices.length]!, total - done); ops.push({ op: 'step', ticks: n }); done += n; }
  return ops;
};
