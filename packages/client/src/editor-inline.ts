// Inline values: while a run is paused or stepping, each line shows the current value of the variables it mentions.
import { codeOnly } from './editor-ticks.ts';

export interface VarValue { name: string; value: string }
const MAX_PER_LINE = 3, MAX_VALUE = 28;

const clip = (v: string): string => (v.length > MAX_VALUE ? `${v.slice(0, MAX_VALUE - 1)}…` : v);

/** Line number (1-based) to the text shown after it, e.g. `x = 3, y = 7`. Lines that mention no known variable are absent. */
export function inlineValues(source: string, vars: readonly VarValue[]): Map<number, string> {
  const out = new Map<number, string>();
  if (!vars.length) return out;
  const byName = new Map(vars.map((v) => [v.name, v.value]));
  source.split('\n').forEach((raw, i) => {
    const seen: string[] = [];
    for (const m of codeOnly(raw).matchAll(/[A-Za-z_]\w*/g)) {
      const name = m[0];
      if (byName.has(name) && !seen.includes(name)) seen.push(name);
    }
    if (seen.length) out.set(i + 1, seen.slice(0, MAX_PER_LINE).map((n) => `${n} = ${clip(byName.get(n)!)}`).join(', '));
  });
  return out;
}
