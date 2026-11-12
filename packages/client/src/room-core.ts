// Pure room logic (no DOM, no sim imports) so node's test runner can load it.
import type { Timeline } from './replay-view';
export const ROOM_MAX = 16;
export const ROOM_FPS = 30;
export const DUEL_ID = /^x-[A-Za-z0-9_-]{8}$/;

export interface RoomPlayer { entryId: string; login: string; displayName: string | null; worth: number; host: boolean }
export type RoomRun =
  | { player: RoomPlayer; state: 'live'; timeline: Timeline }
  | { player: RoomPlayer; state: 'sealed' }
  | { player: RoomPlayer; state: 'missing' };

export interface DuelInfo {
  id: string; seed: number; ticks: number;
  challenger: { login: string; displayName: string } | null;
  entry: { entryId: string; netWorth: number } | null;
}
interface BoardRow { entryId: string; login: string; displayName: string; value: number }

const label = (p: RoomPlayer): string => p.displayName || p.login;
export { label as playerName };

/**
 * Who is in the room: the duel's best runs by net worth, with the host's run always included. The host keeps a seat even
 * when sixteen others beat them. `challenger` is the host; a duel with no posted score has no host seat.
 */
export function pickPlayers(duel: DuelInfo, rows: BoardRow[]): RoomPlayer[] {
  const hostId = duel.entry?.entryId;
  const players: RoomPlayer[] = [];
  for (const r of rows) {
    if (players.length >= ROOM_MAX) break;
    players.push({ entryId: r.entryId, login: r.login, displayName: r.displayName, worth: r.value, host: r.entryId === hostId });
  }
  if (hostId && !players.some((p) => p.host) && duel.challenger && duel.entry) {
    const host: RoomPlayer = { entryId: hostId, login: duel.challenger.login, displayName: duel.challenger.displayName, worth: duel.entry.netWorth, host: true };
    if (players.length >= ROOM_MAX) players.pop();
    players.push(host);
  }
  return players;
}

/** Live order: highest net worth first, ties keep their seat order (the host first). Returns indexes into `worth`. */
export function rankOrder(worth: number[], host: number): number[] {
  return worth.map((_, i) => i).sort((a, b) => worth[b]! - worth[a]! || (a === host ? -1 : b === host ? 1 : 0) || a - b);
}

// ---- the shared clock ----

/** One clock for the whole room: 10 ticks a second at 1x, drawn at most 30 times a second. */
export class RoomClock {
  tick = 0;
  playing = false;
  speed = 4;
  private carry = 0;
  private last = 0;
  private lastDraw = -Infinity;
  readonly total: number;
  constructor(total: number) { this.total = total; }

  /** True when this animation frame should draw. Holds the draw rate to ROOM_FPS even on a 60 or 144 Hz screen. */
  due(now: number): boolean {
    if (now - this.lastDraw < 1000 / ROOM_FPS - 4) return false;
    this.lastDraw = now;
    return true;
  }
  /** Moves the clock by the real time since the last call. Returns true when the tick changed. */
  advance(now: number): boolean {
    const dt = now - this.last;
    this.last = now;
    if (!this.playing) return false;
    this.carry += (dt / 100) * this.speed;
    const whole = Math.floor(this.carry);
    if (whole <= 0) return false;
    this.carry -= whole;
    this.tick = Math.min(this.total, this.tick + whole);
    if (this.tick >= this.total) this.playing = false;
    return true;
  }
  seek(t: number, now: number): void { this.tick = Math.max(0, Math.min(this.total, Math.floor(t))); this.last = now; this.carry = 0; }
  play(now: number): void { if (this.tick >= this.total) this.tick = 0; this.playing = true; this.last = now; }
  pause(): void { this.playing = false; }
}
