// Plain-English errors get a Fix button only when there is one obvious fix: an unknown name that is exactly one edit
// (insert, delete, change or swap two letters) away from a single known name. Pure; the editor applies the change.

export interface Fix { from: number; to: number; replacement: string; label: string }

/** True when the two words differ by exactly one insert, delete, change or swap of neighbours. */
export function oneEditApart(a: string, b: string): boolean {
  if (a === b) return false;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true; // one letter changed
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2); // two neighbours swapped
  }
  const [long, short] = la > lb ? [a, b] : [b, a];
  return long.slice(i + 1) === short.slice(i);
}

const UNKNOWN = /I don't know what `([A-Za-z_]\w*)` means/;

/** The unknown name an error message complains about, if it is that kind of message. */
export const unknownNameIn = (message: string): string | null => UNKNOWN.exec(message)?.[1] ?? null;

/** Offsets are within `lineText`. Returns null when there is no fix, or more than one equally good one. */
export function suggestFix(message: string, lineText: string, known: Iterable<string>): Fix | null {
  const bad = unknownNameIn(message);
  if (!bad) return null;
  const near = new Set<string>();
  for (const k of known) if (oneEditApart(bad, k)) near.add(k);
  if (near.size !== 1) return null;
  const replacement = [...near][0]!;
  const at = new RegExp(`(?<![\\w])${bad}(?![\\w])`).exec(lineText);
  if (!at) return null;
  return { from: at.index, to: at.index + bad.length, replacement, label: `Change to ${replacement}` };
}

/** Names the player's own program introduces: functions, parameters, loop variables and assigned variables. */
export function userNames(source: string): string[] {
  const out = new Set<string>();
  for (const raw of source.split('\n')) {
    const line = raw.replace(/#.*$/, '');
    const def = /^\s*(?:define|def)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/.exec(line);
    if (def) { out.add(def[1]!); for (const p of def[2]!.split(',')) { const n = p.trim(); if (/^[A-Za-z_]\w*$/.test(n)) out.add(n); } }
    const each = /^\s*for\s+each\s+([A-Za-z_]\w*)\s+in\b/.exec(line) ?? /^\s*for\s+([A-Za-z_]\w*)\s+from\b/.exec(line);
    if (each) out.add(each[1]!);
    const set = /^\s*(?:set\s+|global\s+)?([A-Za-z_]\w*)\s*(?:=|\+=|-=|\*=|\s+to\b)/.exec(line);
    if (set) out.add(set[1]!);
  }
  return [...out];
}
