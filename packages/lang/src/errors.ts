// Diagnostics, compile and runtime errors, and "did you mean" suggestions.

export interface Diagnostic { line: number; col: number; endCol: number; message: string; severity: 'error' | 'warning' }

/** Thrown by createRun when the source does not compile. */
export class CompileError extends Error {
  diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[]) {
    const first = diagnostics.find((d) => d.severity === 'error');
    super(first ? `line ${first.line}: ${first.message}` : 'compile error');
    this.name = 'CompileError';
    this.diagnostics = diagnostics;
  }
}

/** A runtime error inside one bot's program. Stops only that bot. */
export class SproutError extends Error {
  constructor(message: string) { super(message); this.name = 'SproutError'; }
}

/** Levenshtein distance, capped: returns max + 1 as soon as the distance must exceed max. */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

/** Nearest candidate within edit distance 2 (ties: first in candidate order), or null. */
export function suggest(word: string, candidates: Iterable<string>): string | null {
  let best: string | null = null;
  let bestD = 3;
  for (const c of candidates) {
    if (c === word) continue;
    const d = editDistance(word.toLowerCase(), c.toLowerCase(), 2);
    if (d < bestD) { best = c; bestD = d; }
  }
  return best;
}

export const didYouMean = (word: string, candidates: Iterable<string>): string => {
  const s = suggest(word, candidates);
  return s ? ` Did you mean \`${s}\`?` : '';
};
