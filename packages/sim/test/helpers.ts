import { applyAction, createWorld, tickWorld } from '../src/index.ts';
import type { Farm, LogEntry, Setup, World } from '../src/index.ts';
import { OP } from '../src/rules.ts';

export { OP };
export const farm = (seed = 12345): Farm => ({ id: 'test', seed });
/** Research bitmask with every crop (bits 0..5) unlocked but no satchel, so capacity stays 20. */
export const CROP_UNLOCKS = 0b111111;

/** Hand-drives a world and records the log. */
export class Driver {
  w: World;
  log: LogEntry[] = [];
  constructor(f: Farm = farm(), setup?: Setup) { this.w = createWorld(f, setup); }
  advance(n: number): void { for (let i = 0; i < n; i++) tickWorld(this.w); }
  /** Waits until the bot is free, then applies and records the action. */
  do(bot: number, op: number, a?: number, b?: number): number {
    if (bot >= 0) while (this.w.bots[bot]!.busyUntil > this.w.tick) tickWorld(this.w);
    const e: LogEntry = [this.w.tick, bot, op];
    if (a !== undefined) e.push(a);
    if (b !== undefined) e.push(b);
    this.log.push(e);
    return applyAction(this.w, e as LogEntry);
  }
}

/** One farming round across tiles x=1..3 for bot 0 (assumes bot starts at the barn). */
export function round(d: Driver): void {
  for (let i = 0; i < 3; i++) { d.do(0, OP.move, 1); d.do(0, OP.till); d.do(0, OP.plant, 1); }
  d.do(0, OP.wait, 200);
  d.do(0, OP.harvest);
  for (let i = 0; i < 2; i++) { d.do(0, OP.move, 3); d.do(0, OP.harvest); }
  d.do(0, OP.move, 3);
  d.do(0, OP.deposit);
  const n = d.w.stock[1]!;
  if (n >= 1) d.do(0, OP.sell, 1, n);
}

export function script(d: Driver, minEntries: number): void {
  while (d.log.length < minEntries) round(d);
}
