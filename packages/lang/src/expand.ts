// "See the full program": the ordinary Sprout that a program with `tend` blocks and `when` rules runs as.
import { compile } from './parser.ts';
import type { CompileOptions } from './parser.ts';
import { unparse } from './unparse.ts';
import type { Diagnostic } from './errors.ts';

/** The expansion of `source`, or `null` plus the diagnostics when it does not compile. A program without `tend` expands to itself, tidied. */
export function expandTend(source: string, opts: CompileOptions = {}): { source: string | null; diagnostics: Diagnostic[] } {
  const { program, diagnostics } = compile(source, opts);
  return { source: program ? unparse(program.body) : null, diagnostics };
}
