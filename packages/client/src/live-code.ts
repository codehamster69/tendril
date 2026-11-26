// Live code: pure helpers for "apply my edits while the farm runs". No DOM here (live-code-ui.ts owns the chip).

/** Quiet time after the last keystroke before an edit is applied. */
export const APPLY_DELAY_MS = 600;

/** One line without its comment (a `#` outside a string) and without spare spaces. Indentation is kept: it is part of Sprout. */
function strip(line: string): string {
  const raw = line.replace(/\t/g, '    ');
  let quote = '';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (quote) {
      out += c;
      if (c === '\\') { out += raw[++i] ?? ''; } else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") { quote = c; out += c; }
    else if (c === '#') break;
    else out += c;
  }
  const indent = out.match(/^ */)![0];
  const body = out.slice(indent.length).trimEnd();
  if (!body) return '';
  // Runs of spaces between words never matter, except inside a string.
  let squeezed = '', q = '', prevSpace = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (q) { squeezed += c; if (c === '\\') squeezed += body[++i] ?? ''; else if (c === q) q = ''; prevSpace = false; continue; }
    if (c === '"' || c === "'") { q = c; squeezed += c; prevSpace = false; continue; }
    if (c === ' ') { if (!prevSpace) squeezed += c; prevSpace = true; continue; }
    squeezed += c; prevSpace = false;
  }
  return indent + squeezed;
}

/** The program as the interpreter sees it: no comments, no blank lines, no spare spaces. */
export function significantLines(source: string): string[] {
  return source.replace(/\r/g, '').split('\n').map(strip).filter((l) => l !== '');
}

/** False when two sources differ only in comments, blank lines or spacing: nothing to apply. */
export function isMeaningfulChange(before: string, after: string): boolean {
  const a = significantLines(before), b = significantLines(after);
  return a.length !== b.length || a.some((l, i) => l !== b[i]);
}

/** Line numbers (1-based) of `after` that are new or edited compared with `before`; lines that merely moved down keep out of it. */
export function changedLines(before: string, after: string): number[] {
  const a = before.replace(/\r/g, '').split('\n'), b = after.replace(/\r/g, '').split('\n');
  let head = 0;
  while (head < a.length && head < b.length && strip(a[head]!) === strip(b[head]!)) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && strip(a[a.length - 1 - tail]!) === strip(b[b.length - 1 - tail]!)) tail++;
  const out: number[] = [];
  for (let n = head; n < b.length - tail; n++) if (strip(b[n]!) !== '') out.push(n + 1);
  return out;
}

export type EquipState =
  | { kind: 'equipped'; tick: number; lines: number[] }
  | { kind: 'kept'; line: number | null; message: string };

/** Event the loop emits after an auto-apply: the chip, the gutter pulse and the bot flash listen to it. */
export const EQUIP_EVENT = 'tendril:equip';
