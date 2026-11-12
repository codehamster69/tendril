import { randomBytes, randomUUID } from 'node:crypto';
import { createWorld, dailySeed, DAILY_TICKS, deserialize, hashWorld, IllegalAction, netWorth, replayChunk, RULES_VERSION, serialize } from '@tendril/sim/src/index.ts';
import type { LogEntry, World } from '@tendril/sim/src/index.ts';
import type { Db, Queryable } from './db.ts';
import { HttpError } from './validation.ts';
import type { ChunkInput } from './validation.ts';

interface FarmRow {
  id: string; user_id: string; seed: number; started_at: number; tick: number;
  checkpoint: string; checkpoint_hash: string; rules_version: number; coins: number; net_worth: number; verified_at: number | null;
}
export interface FarmResponse {
  id: string; seed: number; startedAtMs: number; tick: number; checkpoint: string;
  checkpointHash: string; rulesVersion: number; coins: number; netWorth: number;
}
export interface LeaderEntry {
  rank: number; userId: string; displayName: string; farmId: string;
  netWorth: number; growth24h: number; tick: number; verifiedAtMs: number;
}
export type Board = 'networth' | 'growth';
export const HOUR_MS = 3600000;
export const DAY_MS = 24 * HOUR_MS;
/** One every 10 seconds on average: the client syncs small chunks every few seconds, so the board stays close to live. */
export const CHUNK_ATTEMPTS_PER_HOUR = 360;
export const DAILY_SUBMISSIONS_PER_DAY = 20;

function farmResponse(farm: FarmRow): FarmResponse {
  return {
    id: farm.id, seed: farm.seed, startedAtMs: farm.started_at, tick: farm.tick,
    checkpoint: farm.checkpoint, checkpointHash: farm.checkpoint_hash, rulesVersion: farm.rules_version,
    coins: farm.coins, netWorth: farm.net_worth,
  };
}

/** Rejects overflow and non-finite states after a replay; shared by farm chunks and daily runs. */
function checkedWorth(world: World): number {
  const worth = netWorth(world);
  if (!Number.isSafeInteger(world.coins) || !Number.isSafeInteger(worth) || !Number.isSafeInteger(world.tick)) throw new HttpError(422, 'Simulation overflow');
  return worth;
}

function replayOrReject(world: World, actions: LogEntry[], toTick: number): number {
  try {
    replayChunk(world, actions, toTick);
    return checkedWorth(world);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof IllegalAction) throw new HttpError(422, `Invalid action log: ${error.message}`);
    if (error instanceof Error && error.message === 'overflow') throw new HttpError(422, 'Invalid action log');
    throw error;
  }
}

export async function createFarm(db: Db, userId: string, now: () => number): Promise<{ status: 200 | 201; farm: FarmResponse }> {
  const existing = await db.query<FarmRow>('SELECT * FROM farms WHERE user_id = ?', [userId]);
  if (existing[0]) return { status: 200, farm: farmResponse(existing[0]) };
  const id = randomUUID();
  const seed = randomBytes(4).readUInt32LE() || 1;
  const startedAt = now();
  const world = createWorld({ id, seed });
  const worth = netWorth(world);
  const row: FarmRow = {
    id, user_id: userId, seed, started_at: startedAt, tick: world.tick, checkpoint: serialize(world),
    checkpoint_hash: hashWorld(world), rules_version: RULES_VERSION, coins: world.coins, net_worth: worth, verified_at: null,
  };
  // user_id is UNIQUE: a concurrent creation loses the insert and returns the winner's farm.
  const inserted = await db.transaction(async (tx) => {
    const result = await tx.execute(
      'INSERT OR IGNORE INTO farms (id, user_id, seed, started_at, tick, checkpoint, checkpoint_hash, rules_version, coins, net_worth, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)',
      [id, userId, seed, startedAt, row.tick, row.checkpoint, row.checkpoint_hash, RULES_VERSION, world.coins, worth],
    );
    if (result.rowsAffected === 0) return false;
    await tx.execute('INSERT INTO worth_history (farm_id, net_worth, at_ms) VALUES (?, ?, ?)', [id, worth, startedAt]);
    return true;
  });
  if (inserted) return { status: 201, farm: farmResponse(row) };
  const winner = await db.query<FarmRow>('SELECT * FROM farms WHERE user_id = ?', [userId]);
  return { status: 200, farm: farmResponse(winner[0]!) };
}

export async function getFarm(db: Db, userId: string): Promise<FarmResponse> {
  const rows = await db.query<FarmRow>('SELECT * FROM farms WHERE user_id = ?', [userId]);
  if (!rows[0]) throw new HttpError(404, 'Farm not found');
  return farmResponse(rows[0]);
}

/**
 * Records an attempt and enforces the limit atomically. Attempts commit even when the submission is later
 * rejected, so invalid submissions cannot evade the cap. kind 'chunk': `chunkLimit` per rolling hour; 'daily': 20 per UTC day.
 */
export type AttemptKind = 'chunk' | 'daily' | 'entry' | 'duel';
/** Per UTC day, except 'chunk' (per rolling hour, set by the caller). */
export const ATTEMPT_LIMITS: Record<Exclude<AttemptKind, 'chunk'>, number> = { daily: DAILY_SUBMISSIONS_PER_DAY, entry: 60, duel: 20 };
const ATTEMPT_MESSAGES: Record<AttemptKind, string> = {
  chunk: 'Too many chunk attempts', daily: 'Too many daily submissions', entry: 'Too many entry submissions', duel: 'Too many duels created',
};

export async function reserveAttempt(db: Db, userId: string, kind: AttemptKind, time: number, chunkLimit = CHUNK_ATTEMPTS_PER_HOUR): Promise<void> {
  const limit = kind === 'chunk' ? chunkLimit : ATTEMPT_LIMITS[kind];
  const since = kind === 'chunk' ? time - HOUR_MS : time - (time % DAY_MS);
  const allowed = await db.transaction(async (tx) => {
    await tx.execute('DELETE FROM submission_attempts WHERE user_id = ? AND kind = ? AND at_ms <= ?', [userId, kind, kind === 'chunk' ? time - HOUR_MS : time - 2 * DAY_MS]);
    const [count] = await tx.query<{ n: number }>('SELECT COUNT(*) AS n FROM submission_attempts WHERE user_id = ? AND kind = ? AND at_ms > ?', [userId, kind, since]);
    if (count!.n >= limit) return false;
    await tx.execute('INSERT INTO submission_attempts (user_id, kind, at_ms) VALUES (?, ?, ?)', [userId, kind, time]);
    return true;
  });
  if (!allowed) throw new HttpError(429, ATTEMPT_MESSAGES[kind]);
}

async function farmRank(tx: Queryable, farmId: string, worth: number, verifiedAt: number): Promise<number> {
  const [row] = await tx.query<{ n: number }>(
    `SELECT COUNT(*) + 1 AS n FROM farms WHERE verified_at IS NOT NULL AND id <> ?1
       AND (net_worth > ?2 OR (net_worth = ?2 AND (verified_at < ?3 OR (verified_at = ?3 AND id < ?1))))`,
    [farmId, worth, verifiedAt],
  );
  return row!.n;
}

export async function verifyChunk(db: Db, userId: string, farmId: string, input: ChunkInput, now: () => number) {
  const [farm] = await db.query<FarmRow>('SELECT * FROM farms WHERE id = ?', [farmId]);
  if (!farm) throw new HttpError(404, 'Farm not found');
  if (farm.user_id !== userId) throw new HttpError(403, 'Not your farm');
  if (input.rulesVersion !== RULES_VERSION || input.rulesVersion !== farm.rules_version) throw new HttpError(409, 'Rules version mismatch');
  if (input.fromTick !== farm.tick || input.checkpointHash !== farm.checkpoint_hash) throw new HttpError(409, 'Stale checkpoint');
  if (input.toTick <= input.fromTick) throw new HttpError(422, 'Invalid tick range');
  const verifiedAt = now();
  if (input.toTick > Math.floor((verifiedAt - farm.started_at) / 100)) throw new HttpError(422, 'Tick is ahead of server clock');
  const world = deserialize(farm.checkpoint);
  const worth = replayOrReject(world, input.actions, input.toTick);
  const hash = hashWorld(world);
  const checkpoint = serialize(world);
  return db.transaction(async (tx) => {
    // Compare-and-swap on the checkpoint tick: of two racing submissions from the same checkpoint exactly one wins.
    const swapped = await tx.execute(
      'UPDATE farms SET tick = ?, checkpoint = ?, checkpoint_hash = ?, coins = ?, net_worth = ?, verified_at = ? WHERE id = ? AND user_id = ? AND tick = ?',
      [world.tick, checkpoint, hash, world.coins, worth, verifiedAt, farmId, userId, input.fromTick],
    );
    if (swapped.rowsAffected === 0) throw new HttpError(409, 'Stale checkpoint');
    await tx.execute('INSERT INTO chunks (farm_id, from_tick, to_tick, actions, created_at) VALUES (?, ?, ?, ?, ?)', [farmId, input.fromTick, input.toTick, JSON.stringify(input.actions), verifiedAt]);
    await tx.execute('INSERT INTO worth_history (farm_id, net_worth, at_ms) VALUES (?, ?, ?)', [farmId, worth, verifiedAt]);
    return { tick: world.tick, checkpointHash: hash, netWorth: worth, rank: await farmRank(tx, farmId, worth, verifiedAt) };
  });
}

export async function leaderboard(db: Db, board: Board, limit: number, now: number): Promise<LeaderEntry[]> {
  // Growth = current worth minus the latest sample at or before now-24h (sample-and-hold), else the farm's first sample.
  const order = board === 'growth' ? 'growth DESC, f.verified_at ASC, f.id ASC' : 'f.net_worth DESC, f.verified_at ASC, f.id ASC';
  const rows = await db.query<{ user_id: string; display_name: string; farm_id: string; net_worth: number; growth: number; tick: number; verified_at: number }>(
    `SELECT f.user_id, u.display_name, f.id AS farm_id, f.net_worth, f.tick, f.verified_at,
       f.net_worth - COALESCE(
         (SELECT h.net_worth FROM worth_history h WHERE h.farm_id = f.id AND h.at_ms <= ?1 ORDER BY h.at_ms DESC, h.id DESC LIMIT 1),
         (SELECT h.net_worth FROM worth_history h WHERE h.farm_id = f.id ORDER BY h.at_ms ASC, h.id ASC LIMIT 1),
         f.net_worth) AS growth
     FROM farms f JOIN users u ON u.id = f.user_id
     WHERE f.verified_at IS NOT NULL ORDER BY ${order} LIMIT ?2`, // `order` is one of two constants, never request data
    [now - DAY_MS, limit],
  );
  return rows.map((row, i) => ({
    rank: i + 1, userId: row.user_id, displayName: row.display_name, farmId: row.farm_id,
    netWorth: row.net_worth, growth24h: row.growth, tick: row.tick, verifiedAtMs: row.verified_at,
  }));
}

export async function getReplay(db: Db, farmId: string, fromTick = 0, limit = 1) {
  const [farm] = await db.query<{ seed: number; rules_version: number }>('SELECT seed, rules_version FROM farms WHERE id = ? AND verified_at IS NOT NULL', [farmId]);
  if (!farm) throw new HttpError(404, 'Verified farm not found');
  // Bounded in SQL: one page plus a lookahead row for the cursor.
  const rows = await db.query<{ from_tick: number; to_tick: number; actions: string }>(
    'SELECT from_tick, to_tick, actions FROM chunks WHERE farm_id = ? AND from_tick >= ? ORDER BY from_tick LIMIT ?',
    [farmId, fromTick, limit + 1],
  );
  return {
    seed: farm.seed, rulesVersion: farm.rules_version,
    chunks: rows.slice(0, limit).map((row) => ({ fromTick: row.from_tick, toTick: row.to_tick, actions: JSON.parse(row.actions) as LogEntry[] })),
    nextFromTick: rows[limit] ? rows[limit].from_tick : null,
  };
}

// Daily challenge seed: dailySeed(date) from the sim = FNV-1a 32-bit over the UTF-8 bytes of "tendril-daily:" + "YYYY-MM-DD"
// (UTC date), 0 mapped to 1. Every player gets the same farm for a date; runs last DAILY_TICKS (3000) ticks.
export const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function isValidDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && utcDate(Date.parse(`${value}T00:00:00Z`)) === value;
}

export function dailyInfo(now: number) {
  const date = utcDate(now);
  return { date, seed: dailySeed(date), ticks: DAILY_TICKS, rulesVersion: RULES_VERSION };
}
