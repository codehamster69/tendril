import type { LogEntry, Setup, Snapshot } from '@tendril/sim/src/index.ts';
import type { BotDebug, Diagnostic } from '@tendril/lang/src/index.ts';

export type ScenarioKind = 'live' | 'sandbox' | 'campaign' | 'daily';
export interface Scenario { kind: ScenarioKind; features?: string[]; setup?: Setup; tickLimit?: number; farmId?: string }

export interface SimError { bot: number; message: string; line?: number; col?: number; tick?: number; kind?: 'script' | 'storage' | 'worker' }
export interface OutputLine { bot: number; tick: number; text: string }

type Command =
  | { type: 'init'; saved: string | null; seed: number; source: string; scenario: Scenario }
  | { type: 'setSource'; source: string }
  | { type: 'step'; ticks: number }
  | { type: 'reset'; seed: number; source: string; scenario: Scenario }
  | { type: 'setBreakpoints'; lines: number[] }
  | { type: 'stepLine' };

export type ToWorker = Command & { id: number };

export interface StateMessage {
  type: 'state';
  id: number;
  fromTick: number;
  fromHash: string;
  hash: string; // FNV diagnostic only, not verification.
  snapshot: Snapshot;
  output: OutputLine[];
  errors: SimError[];
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
