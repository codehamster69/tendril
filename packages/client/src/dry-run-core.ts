// Dry run (DOM-free): copy a farm, play a program on the copy for a while and measure what happened.
// Nothing here touches the real farm, its save or the server. The rules are the normal sim rules.
import { COST, deserialize, netWorth, OP, tickWorld } from '@tendril/sim/src/index.ts';
import type { World } from '@tendril/sim/src/index.ts';
import { compile, createRun } from '@tendril/lang/src/index.ts';
import type { Diagnostic } from '@tendril/lang/src/index.ts';

export const DRY_RUN_SPANS = [1_000, 3_000, 10_000] as const;
export const DRY_RUN_MAX = 20_000;
/** Ticks per slice: small enough to report progress, large enough to keep the per-slice cost low. */
const SLICE = 250;

export interface DryStats {
  ticks: number;
  /** Coin change scaled to 1,000 ticks (buying land or bots lowers it; net worth counts what was bought). */
  coinsPer1000: number;
  netWorthPer1000: number;
  coins: { start: number; end: number };
  plots: { start: number; end: number };
  bots: { start: number; end: number };
  /** Share of all bot time spent walking, 0..1. */
  walkShare: number;
  harvests: number;
  sales: number;
  /** Bots whose program stopped on an error, with the first error. */
  crashes: number;
  firstCrash: { bot: number; line: number; message: string } | null;
}

export interface DryRunRequest {
  /** Serialized world (the real farm's last durable checkpoint). */
  world: string;
  /** The program running on the real farm now; null when nothing runs there. */
  before: string | null;
  /** The program to try (the editor text). */
  after: string;
  ticks: number;
  features?: string[];
}
export interface DryRunResult {
  startTick: number;
  ticks: number;
  before: DryStats | null;
  after: DryStats | null;
  /** Compile errors in the new program: nothing was run for it. */
  diagnostics: Diagnostic[];
}

const per1000 = (delta: number, ticks: number): number => ticks > 0 ? Math.round(delta * 1000 / ticks) : 0;

/** Plays `source` (or nothing, when null) on its own copy of the world, yielding the ticks done after every slice. */
export function* playCopy(saved: string, source: string | null, ticks: number, features?: ReadonlySet<string>): Generator<number, DryStats, void> {
  const w: World = deserialize(saved);
  const start = { coins: w.coins, plots: w.plots.length, bots: w.bots.length, worth: netWorth(w) };
  const run = source === null ? null : createRun(w, source, { features });
  let walk = 0, botTime = 0, harvests = 0, sales = 0, done = 0;
  try {
    while (done < ticks) {
      const n = Math.min(SLICE, ticks - done);
      const bots = w.bots.length;
      let ran = n;
      if (run) {
        ran = run.step(n).ticks;
        for (const [, bot, op] of run.takeLog()) {
          if (bot < 0) continue;
          if (op === OP.move) walk += COST[OP.move]!;
          else if (op === OP.harvest) harvests++;
          else if (op === OP.sell) sales++;
        }
      } else {
        // No program: the farm still lives through time (crops grow, orders come and go).
        for (let i = 0; i < n; i++) tickWorld(w);
      }
      if (ran <= 0) break;
      botTime += Math.max(bots, w.bots.length) * ran;
      done += ran;
      yield done;
    }
  } finally { run?.close(); }
  const crashed = run ? run.errors : [];
  const first = crashed[0] ?? null;
  return {
    ticks: done,
    coinsPer1000: per1000(w.coins - start.coins, done),
    netWorthPer1000: per1000(netWorth(w) - start.worth, done),
    coins: { start: start.coins, end: w.coins },
    plots: { start: start.plots, end: w.plots.length },
    bots: { start: start.bots, end: w.bots.length },
    walkShare: botTime > 0 ? Math.min(1, walk / botTime) : 0,
    harvests, sales,
    crashes: new Set(crashed.map((e) => e.bot)).size,
    firstCrash: first ? { bot: first.bot, line: first.line, message: first.message } : null,
  };
}

/** Runs before and after on two identical copies, yielding [done, total] ticks over both runs. */
export function* dryRun(req: DryRunRequest): Generator<[number, number], DryRunResult, void> {
  if (!Number.isSafeInteger(req.ticks) || req.ticks <= 0 || req.ticks > DRY_RUN_MAX) throw new Error(`A dry run lasts 1 to ${DRY_RUN_MAX.toLocaleString('en-US')} ticks.`);
  const features = req.features ? new Set(req.features) : undefined;
  const startTick = deserialize(req.world).tick;
  const { program, diagnostics } = compile(req.after, { features });
  const broken = !program || diagnostics.some((d) => d.severity === 'error');
  const beforeOk = req.before !== null && !compile(req.before, { features }).diagnostics.some((d) => d.severity === 'error');
  const total = req.ticks * (broken ? 1 : 2);
  const before = yield* tally(playCopy(req.world, beforeOk ? req.before : null, req.ticks, features), 0, total);
  if (broken) return { startTick, ticks: req.ticks, before, after: null, diagnostics };
  const after = yield* tally(playCopy(req.world, req.after, req.ticks, features), req.ticks, total);
  return { startTick, ticks: req.ticks, before, after, diagnostics };
}

function* tally(it: Generator<number, DryStats, void>, offset: number, total: number): Generator<[number, number], DryStats, void> {
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
    yield [offset + r.value, total];
  }
}

/** Runs a dry run to the end without yielding (tests, tools). */
export function dryRunSync(req: DryRunRequest): DryRunResult {
  const it = dryRun(req);
  for (;;) { const r = it.next(); if (r.done) return r.value; }
}

export interface DryRow { label: string; before: string; after: string; better: boolean | null; hint?: string }
const fmt = (n: number): string => n.toLocaleString('en-US');
const pct = (n: number): string => `${Math.round(n * 100)}%`;
const signedFmt = (n: number): string => (n > 0 ? '+' : '') + fmt(n);

/** Rows for the result card. `better` is true when after beats before, false when it is worse, null when even or unknown. */
export function dryRows(r: DryRunResult): DryRow[] {
  const b = r.before, a = r.after;
  const cmp = (x: number | undefined, y: number | undefined, higher = true): boolean | null => x === undefined || y === undefined || x === y ? null : (y > x) === higher;
  const dash = '—';
  return [
    { label: 'Coins per 1,000 ticks', before: b ? signedFmt(b.coinsPer1000) : dash, after: a ? signedFmt(a.coinsPer1000) : dash, better: cmp(b?.coinsPer1000, a?.coinsPer1000) },
    { label: 'Net worth per 1,000 ticks', before: b ? signedFmt(b.netWorthPer1000) : dash, after: a ? signedFmt(a.netWorthPer1000) : dash, better: cmp(b?.netWorthPer1000, a?.netWorthPer1000) },
    { label: 'Land at the end', before: b ? `${fmt(b.plots.end)} plot${b.plots.end === 1 ? '' : 's'}` : dash, after: a ? `${fmt(a.plots.end)} plot${a.plots.end === 1 ? '' : 's'}` : dash, better: cmp(b?.plots.end, a?.plots.end) },
    { label: 'Time spent walking', before: b ? pct(b.walkShare) : dash, after: a ? pct(a.walkShare) : dash, better: b && a && Math.round(b.walkShare * 100) === Math.round(a.walkShare * 100) ? null : cmp(b?.walkShare, a?.walkShare, false) },
    { label: 'Crashed bots', before: b ? fmt(b.crashes) : dash, after: a ? fmt(a.crashes) : dash, better: cmp(b?.crashes, a?.crashes, false),
      hint: a?.firstCrash ? `Line ${a.firstCrash.line}: ${a.firstCrash.message}` : undefined },
  ];
}

/** One sentence for the top of the card. */
export function dryVerdict(r: DryRunResult): string {
  if (!r.after) return 'Your new code has errors, so it was not run. Fix the marked lines and try again.';
  const a = r.after, b = r.before;
  if (a.crashes > 0 && (!b || a.crashes > b.crashes)) return `Careful: ${a.crashes === 1 ? 'a bot stops' : `${a.crashes} bots stop`} on an error in the new code.`;
  if (!b) return `The new code makes ${signedFmt(a.netWorthPer1000)} net worth per 1,000 ticks. Nothing runs on your farm now.`;
  const d = a.netWorthPer1000 - b.netWorthPer1000;
  if (d === 0) return 'The new code does as well as the code running now.';
  const base = Math.abs(b.netWorthPer1000);
  const share = base > 0 ? ` (${d > 0 ? '+' : '−'}${Math.round(Math.abs(d) * 100 / base)}%)` : '';
  return d > 0 ? `The new code grows your farm faster: ${signedFmt(d)} net worth per 1,000 ticks${share}.` : `The new code is slower: ${signedFmt(d)} net worth per 1,000 ticks${share}.`;
}
