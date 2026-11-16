import type { LogEntry, Setup, ViewScalars } from '@tendril/sim/src/index.ts';
import type { BotDebug, Diagnostic, OutputLine, ScriptError } from '@tendril/lang/src/index.ts';

export type { BotDebug, Diagnostic, OutputLine, ScriptError };
export type ScenarioKind = 'live' | 'sandbox' | 'campaign' | 'daily';
/** farmId is a local extra: daily challenges use a per-date world id. */
export interface Scenario { kind: ScenarioKind; features?: string[]; setup?: Setup; tickLimit?: number; farmId?: string }

/** Client-side error: a script error from the worker, or a storage/worker failure raised on the main thread. */
export interface SimError { bot: number; message: string; line?: number; col?: number; tick?: number; kind?: 'script' | 'storage' | 'worker' }

type Command =
  | { type: 'init'; saved: string | null; seed: number; source: string; scenario: Scenario }
  | { type: 'setSource'; source: string }
  | { type: 'step'; ticks: number }
  | { type: 'reset'; seed: number; source: string; scenario: Scenario }
  | { type: 'setBreakpoints'; lines: number[] }
  | { type: 'stepLine' }
  | { type: 'resume' }
  /** Ask for a complete view without running ticks (the main thread lost track of the deltas). */
  | { type: 'fullView' };

export type ToWorker = Command & { id: number };

export interface StateMessage {
  type: 'state';
  id: number;
  fromTick: number;
  fromHash: string;
  hash: string; // FNV diagnostic only, not verification.
  view: ViewUpdate;
  output: OutputLine[];
  errors: ScriptError[];
  diagnostics: Diagnostic[];
  log: LogEntry[];
  saved: string; // Every completed command is a recoverable checkpoint.
  debug: BotDebug[];
  paused: { bot: number; line: number } | null;
  heat: [number, number][];
}

export type FromWorker =
  | StateMessage
  | { type: 'progress'; id: number; done: number; total: number }
  | { type: 'fatal'; id: number; message: string };

/**
 * Compact farm view for the screen. Bump VIEW_VERSION whenever the layout below changes: a store that
 * sees another version asks for a full update and ignores deltas it cannot read.
 */
export const VIEW_VERSION = 1;
/** Events the screen must not miss: [kind, tick, bot, a, b]. harvest: a = item; sale and order: a = item or order id, b = units. */
export const EVENT = { harvest: 1, sale: 2, order: 3, error: 4 } as const;
export type ViewEvent = [kind: number, tick: number, bot: number, a: number, b: number];
export const MAX_VIEW_EVENTS = 256;

export interface ViewUpdate {
  version: number;
  /** Replaces everything the store holds. Sent on load, reset, request and format change. */
  full: boolean;
  /** Sequence number; `base` is the sequence this delta applies to (0 for a full update). */
  seq: number;
  base: number;
  tick: number;
  /** Changed plots: indexes into the plot list, and VIEW_TILE_FIELDS × 64 ints each in the same order. Transferred. */
  plotIndex: Int32Array;
  tiles: Int32Array;
  /** Changed bots: indexes, and VIEW_BOT_FIELDS ints each. Transferred. */
  botIndex: Int32Array;
  bots: Int32Array;
  botCount: number;
  /** Plot positions as px, py pairs; present only when the plot count changed (and on full updates). */
  plots?: number[];
  /** Present only when something other than tick changed (and on full updates). */
  scalars?: ViewScalars;
  events: ViewEvent[];
}
