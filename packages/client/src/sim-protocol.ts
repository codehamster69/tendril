import type { LogEntry, Setup, Snapshot } from '@tendril/sim/src/index.ts';
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
  | { type: 'resume' };

export type ToWorker = Command & { id: number };

export interface StateMessage {
  type: 'state';
  id: number;
  fromTick: number;
  fromHash: string;
  hash: string; // FNV diagnostic only, not verification.
  snapshot: Snapshot;
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
