// Facts for the "while you were away" card, gathered from the action log the catch-up already produces (no extra replay).
import { ITEMS, OP } from '@tendril/sim/src/index.ts';
import type { LogEntry } from '@tendril/sim/src/index.ts';

/** Away shorter than this (10 minutes of farm time) gets no card. */
export const AWAY_MIN_TICKS = 6_000;
/** A bot with no action for this long is "idle" (5 minutes). */
export const IDLE_MIN_TICKS = 3_000;

/** Units sold per item and the last tick each bot acted, counted as log entries pass by. */
export class AwayFacts {
  readonly sold = new Map<number, number>();
  readonly lastAct = new Map<number, number>();
  record(log: readonly LogEntry[]): void {
    for (const [t, bot, op, a, b] of log) {
      if (bot >= 0) this.lastAct.set(bot, Math.max(this.lastAct.get(bot) ?? 0, t));
      if (op === OP.sell && a !== undefined && b !== undefined && b > 0) this.sold.set(a, (this.sold.get(a) ?? 0) + b);
    }
  }
}

const fmt = (n: number): string => n.toLocaleString('en-US');

/** "3 h 12 m", "45 m", "2 h". Farm time at 10 ticks a second. */
export function duration(ticks: number): string {
  const minutes = Math.max(0, Math.round(ticks / 600));
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return h && m ? `${h} h ${m} m` : h ? `${h} h` : `${m} m`;
}

/** "212 carrots sold" (the biggest line), then "and 40 more items" for the rest. Empty when nothing sold. */
export function soldText(sold: ReadonlyMap<number, number>): string {
  const rows = [...sold].sort((x, y) => y[1] - x[1]);
  if (!rows.length) return '';
  const [item, units] = rows[0]!;
  const name = ITEMS[item]?.name ?? 'item';
  const rest = rows.slice(1).reduce((n, r) => n + r[1], 0);
  return `${fmt(units)} ${name}${units === 1 ? '' : 's'} sold${rest ? `, and ${fmt(rest)} more ${rest === 1 ? 'item' : 'items'}` : ''}`;
}

export interface AwayInput {
  awayTicks: number; coinsGained: number; sold: ReadonlyMap<number, number>;
  /** Ticks the clock rested because the player was gone longer than the cap. */
  restedTicks: number;
  error: { bot: number; line?: number; tick?: number; message: string } | null;
  /** The bot that did nothing the longest, if it passed IDLE_MIN_TICKS. */
  idle: { bot: number; ticks: number } | null;
}
export interface AwayLines { title: string; summary: string; problem: string | null; line: number | null; cap: string | null }

export function awayLines(i: AwayInput): AwayLines {
  const coins = i.coinsGained >= 0 ? `+${fmt(i.coinsGained)}` : `-${fmt(-i.coinsGained)}`;
  const sold = soldText(i.sold);
  const problem = i.error
    ? `Bot ${i.error.bot} stopped${i.error.line ? ` at line ${i.error.line}` : ''}${i.error.tick !== undefined ? ` at tick ${fmt(i.error.tick)}` : ''}: ${i.error.message}`
    : i.idle ? `Bot ${i.idle.bot} did nothing for the last ${duration(i.idle.ticks)}.` : null;
  return {
    title: `While you were away (${duration(i.awayTicks)})`,
    summary: `${coins} coins${sold ? `, ${sold}` : ''}.`,
    problem, line: i.error?.line ?? null,
    cap: i.restedTicks > 0 ? `Your farm stopped growing ${duration(i.restedTicks)} ago: it rests after 6 h away.` : null,
  };
}

/** The idle bot with the longest wait, among bots 0..botCount-1. */
export function longestIdle(facts: AwayFacts, botCount: number, nowTick: number, fromTick: number): { bot: number; ticks: number } | null {
  let best: { bot: number; ticks: number } | null = null;
  for (let b = 0; b < botCount; b++) {
    const ticks = nowTick - Math.max(fromTick, facts.lastAct.get(b) ?? 0);
    if (ticks >= IDLE_MIN_TICKS && (!best || ticks > best.ticks)) best = { bot: b, ticks };
  }
  return best;
}
