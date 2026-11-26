// Tick column: how many ticks each source line spent in the last run.
//
// The action log records which bot did what and when, but not which source line asked for it. So the log is read per
// kind of action (all the `till`s, all the `wait` ticks, ...) and each kind's ticks are shared between the lines that
// can produce it, weighted by how often the interpreter ran each line (the run's line heat). A kind that only one line
// can produce lands on that line exactly. Pure functions only; no editor or DOM here.

import { API } from '@tendril/lang/src/index.ts';
import { COST, OP } from '@tendril/sim/src/index.ts';

/** A log entry: [tick, bot, op, a?, b?]. */
export type LogRow = readonly (number | undefined)[];

/** One call to a tick-costing action found in the source. `wait` carries its literal argument when it has one. */
export interface LineAction { op: number; waitTicks?: number }

const opOfName = (name: string): number | undefined => {
  const key = name.replace(/_(\w)/g, (_m, c: string) => c.toUpperCase());
  const op = (OP as Record<string, number>)[key];
  return typeof op === 'number' ? op : undefined;
};
const ACTION_OPS = new Map<string, number>();
for (const e of API) if (e.kind === 'action' || e.kind === 'farm') { const op = opOfName(e.name); if (op !== undefined) ACTION_OPS.set(e.name, op); }

/** Source text with strings and the trailing comment blanked out, so word scans see code only. */
export function codeOnly(line: string): string {
  let out = '', quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) { if (c === '\\') { out += '  '; i++; continue; } if (c === quote) quote = ''; out += ' '; continue; }
    if (c === '"' || c === "'") { quote = c; out += ' '; continue; }
    if (c === '#') break;
    out += c;
  }
  return out;
}

/** Tick-costing actions called on each line, 1-based. Lines with none are absent. */
export function lineActions(source: string): Map<number, LineAction[]> {
  const out = new Map<number, LineAction[]>();
  source.split('\n').forEach((raw, i) => {
    const code = codeOnly(raw);
    const found: LineAction[] = [];
    for (const m of code.matchAll(/[A-Za-z_]\w*/g)) {
      const op = ACTION_OPS.get(m[0]);
      if (op === undefined) continue;
      // `define name(` introduces a function; it is not a call.
      if (/\b(define|def)\s+$/.test(code.slice(0, m.index))) continue;
      const entry: LineAction = { op };
      if (op === OP.wait) {
        const arg = /^\s*\(?\s*(\d[\d_]*)/.exec(code.slice(m.index! + m[0].length));
        if (arg) entry.waitTicks = Number(arg[1]!.replace(/_/g, ''));
      }
      found.push(entry);
    }
    if (found.length) out.set(i + 1, found);
  });
  return out;
}

/** The log reduced to what attribution needs: how many times each kind ran and how many ticks it took in all. */
export interface OpTotals { count: Map<number, number>; ticks: Map<number, number> }

export function totalsOf(log: readonly LogRow[], from = 0): OpTotals {
  const count = new Map<number, number>(), ticks = new Map<number, number>();
  for (let i = from; i < log.length; i++) {
    const e = log[i]!;
    const op = e[2] ?? -1;
    const cost = op === OP.wait ? (e[3] ?? 0) : (COST[op] ?? 0);
    count.set(op, (count.get(op) ?? 0) + 1);
    ticks.set(op, (ticks.get(op) ?? 0) + cost);
  }
  return { count, ticks };
}

/** Ticks per source line (1-based). `heat` is the run's [line, steps] pairs. */
export function attributeTicks(source: string, totals: OpTotals, heat: Iterable<readonly [number, number]>): Map<number, number> {
  const acts = lineActions(source);
  const steps = new Map<number, number>(heat);
  const result = new Map<number, number>();
  const byOp = new Map<number, [number, number][]>(); // op -> [line, weight]
  for (const [line, list] of acts) {
    const h = steps.get(line) ?? 0;
    for (const a of list) {
      const arr = byOp.get(a.op) ?? [];
      arr.push([line, Math.max(h, 0)]);
      byOp.set(a.op, arr);
    }
  }
  for (const [op, total] of totals.ticks) {
    const lines = byOp.get(op);
    if (!lines || total <= 0) continue;
    const merged = new Map<number, number>();
    for (const [l, w] of lines) merged.set(l, (merged.get(l) ?? 0) + w);
    let sum = 0;
    for (const w of merged.values()) sum += w;
    if (sum === 0) { for (const l of merged.keys()) merged.set(l, 1); sum = merged.size; }
    for (const [l, w] of merged) result.set(l, (result.get(l) ?? 0) + (total * w) / sum);
  }
  for (const [l, v] of result) { const r = Math.round(v); if (r > 0) result.set(l, r); else result.delete(l); }
  return result;
}

/** Lines in the costliest 10% (at least one). Empty when there is nothing to tell apart. */
export function hotLines(ticks: ReadonlyMap<number, number>): Set<number> {
  const entries = [...ticks].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (entries.length < 2) return new Set(entries.length === 1 ? [entries[0]![0]] : []);
  const k = Math.max(1, Math.ceil(entries.length * 0.1));
  const cut = entries[k - 1]![1];
  if (cut === entries[entries.length - 1]![1]) return new Set(); // everything costs the same: nothing stands out
  return new Set(entries.filter(([, v]) => v >= cut).map(([l]) => l));
}

/**
 * Follows a run across frames. Heat and the log both only grow while one run goes on; a drop in heat means a new run
 * started, so what the log already held belongs to the earlier one and is skipped.
 */
export class RunTicks {
  private base = 0;
  private lastHeat = 0;
  private lastLen = 0;
  feed(source: string, log: readonly LogRow[], heat: readonly (readonly [number, number])[]): Map<number, number> {
    const heatTotal = heat.reduce((n, [, v]) => n + v, 0);
    if (log.length < this.lastLen) this.base = 0;
    else if (heatTotal < this.lastHeat) this.base = this.lastLen;
    this.lastHeat = heatTotal;
    this.lastLen = log.length;
    return attributeTicks(source, totalsOf(log, this.base), heat);
  }
  reset(): void { this.base = 0; this.lastHeat = 0; this.lastLen = 0; }
}
