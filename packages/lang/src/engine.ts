// Picks the engine for a run. The compiled engine is the default; the reference interpreter stays available for
// equivalence tests, for environments that cannot build functions from text, and as an emergency switch (`engine: 'reference'`).
import type { World } from '@tendril/sim/src/index.ts';
import { compile } from './parser.ts';
import { CompileError } from './errors.ts';
import { createReferenceRun } from './interpreter.ts';
import type { RunOptions, ScriptRun } from './interpreter.ts';
import { createCompiledRun } from './compiled.ts';

export function createRun(world: World, source: string, opts?: RunOptions): ScriptRun {
  if (opts?.engine === 'reference') return createReferenceRun(world, source, opts);
  const result = compile(source, opts);
  if (!result.program) throw new CompileError(result.diagnostics);
  return createCompiledRun(world, result.program, source, opts) ?? createReferenceRun(world, source, opts);
}
