import type { Snapshot, Order } from '@tendril/sim/src/index.ts';
import type { GoalProgress } from './goal-progress';
import type { OutputLine, Scenario, SimError, ViewEvent } from './sim-protocol';

export type { Snapshot, Order };

export interface SimSource {
  init(source: string): Promise<void>;          // loads the save or creates a new farm
  setSource(source: string): Promise<void>;
  requestStep(ticks: number): void;             // fire and forget; ignored while a previous step is still running
  latest(): Snapshot | null;                    // most recent snapshot received
  drainOutput(): OutputLine[];
  drainErrors(): SimError[];
  goalProgress?(): GoalProgress | null;         // brief worlds: progress toward the goal as of the latest snapshot
  drainEvents?(): ViewEvent[];                  // harvest, sale, order and error events since the last call
  reset(source: string, over?: { scenario?: Scenario; seed?: number }): Promise<void>;
  onProgress?: (done: number, total: number) => void;
}
