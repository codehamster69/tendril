import { applyAction, challengeSetup, createWorld, deserialize, netWorth, serialize, snapshot, tickWorld } from '@tendril/sim/src/index.ts';
import type { ChallengeKind, LogEntry, Snapshot, World } from '@tendril/sim/src/index.ts';

export interface ReplayEntry {
  id: string;
  player: { login: string; displayName: string | null };
  netWorth: number;
  sealed: boolean;
  challenge: { id: string; kind: ChallengeKind; number: number | null; seed: number; ticks: number; closesAt: string | null };
}
export interface ReplayData { seed: number; ticks: number; rulesVersion: number; actions: LogEntry[] }

const CHECKPOINT_EVERY = 250;

/** Re-runs an action log and lets the caller jump to any tick. Keeps a serialized world every 250 ticks. */
export class Timeline {
  readonly ticks: number;
  private world: World;
  private next = 0;
  private checkpoints: { tick: number; next: number; state: string }[] = [];
  private finalWorth = 0;

  constructor(private kind: ChallengeKind, private seed: number, ticks: number, private actions: LogEntry[]) {
    this.ticks = ticks;
    this.world = this.fresh();
    this.checkpoints.push({ tick: 0, next: 0, state: serialize(this.world) });
    this.advance(ticks);
    this.finalWorth = netWorth(this.world);
    this.seek(0);
  }

  private fresh(): World { return createWorld({ id: 'replay', seed: this.seed }, challengeSetup(this.kind, this.seed).setup); }

  /** Net worth at the last tick of the run, from a full re-run. */
  get finalNetWorth(): number { return this.finalWorth; }
  get tick(): number { return this.world.tick; }

  private advance(to: number): void {
    const w = this.world;
    while (w.tick < to) {
      while (this.next < this.actions.length && this.actions[this.next]![0] <= w.tick) applyAction(w, this.actions[this.next++]!);
      tickWorld(w);
      if (w.tick % CHECKPOINT_EVERY === 0 && w.tick > (this.checkpoints[this.checkpoints.length - 1]?.tick ?? -1)) {
        this.checkpoints.push({ tick: w.tick, next: this.next, state: serialize(w) });
      }
    }
  }

  /** Moves the world to `tick` (clamped to the run) and returns its snapshot. */
  seek(tick: number): Snapshot {
    const target = Math.max(0, Math.min(this.ticks, Math.floor(tick)));
    if (target < this.world.tick) {
      let cp = this.checkpoints[0]!;
      for (const c of this.checkpoints) if (c.tick <= target) cp = c;
      this.world = deserialize(cp.state);
      this.next = cp.next;
    }
    this.advance(target);
    return snapshot(this.world);
  }
}

/** Fills one pane header with the player name and returns a setter for the net worth readout. */
export function paneHeader(root: HTMLElement, entry: ReplayEntry): { setWorth(n: number): void } {
  root.querySelector<HTMLElement>('.pane-name')!.textContent = entry.player.displayName || entry.player.login;
  const worth = root.querySelector<HTMLElement>('.pane-worth')!;
  return { setWorth: (n) => { worth.textContent = n.toLocaleString('en-US'); worth.dataset.value = String(n); } };
}
