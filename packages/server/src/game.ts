import { randomBytes, randomUUID } from 'node:crypto';
import { createWorld, dailySeed, DAILY_TICKS, deserialize, hashWorld, IllegalAction, netWorth, replayChunk, RULES_VERSION, serialize } from '@tendril/sim/src/index.ts';
import type { LogEntry, World } from '@tendril/sim/src/index.ts';
import type { Db, Queryable } from './db.ts';
import { HttpError } from './validation.ts';
import type { ChunkInput } from './validation.ts';

interface FarmRow {
  id: string; user_id: string; seed: number; started_at: number; tick: number;
  checkpoint: string; checkpoint_hash: string; rules_version: number; coins: number; net_worth: number; verified_at: number | null;
  pending_from: number | null; pending_actions: string | null; pending_at: number | null;
  slow_at: number; sampled_at: number; rank: number | null; growth: number; att_start: number; att_n: number;
}
export interface ChunkResult { tick: number; checkpointHash: string; netWorth: number; rank: number | null; nextSyncMs: number }
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

// ---- Endless sync cost model (brain/notes/COST.md) ----
/** Rank, 24h growth and the cached rank are refreshed at most this often per farm (they are the only reads a sync does). */
export const SLOW_REFRESH_MS = 5 * 60_000;
/** A worth_history sample is written at most this often per farm; the 24h growth baseline is the latest sample at or before now-24h. */
export const SAMPLE_EVERY_MS = 30 * 60_000;
/** Verified action logs are buffered in the farm row and flushed into `chunks` after this long or this many bytes. */
export const PENDING_MAX_AGE_MS = 10 * 60_000;
export const PENDING_MAX_BYTES = 256 * 1024;
/** A farm's rank is exact up to this; below it the answer is null ("outside the top N"). Bounds the rank query to N rows. */
export const RANK_CAP = 500;
/** How soon the client should sync again, by rank. The visible top of the board stays about 15 s from live; the long tail syncs slowly. */
export const SYNC_TIERS: readonly { maxRank: number; ms: number }[] = [{ maxRank: 25, ms: 15_000 }, { maxRank: RANK_CAP, ms: 60_000 }];
export const SYNC_TAIL_MS = 180_000;
export function syncIntervalMs(rank: number | null, scale = 1): number {
  const tier = rank === null ? undefined : SYNC_TIERS.find((t) => rank <= t.maxRank);
  return Math.round((tier?.ms ?? SYNC_TAIL_MS) * scale);
}

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
    pending_from: null, pending_actions: null, pending_at: null, slow_at: 0, sampled_at: startedAt, rank: null, growth: 0, att_start: 0, att_n: 0,
  };
  // user_id is UNIQUE: a concurrent creation loses the insert and returns the winner's farm.
  const inserted = await db.transaction(async (tx) => {
    const result = await tx.execute(
      'INSERT OR IGNORE INTO farms (id, user_id, seed, started_at, tick, checkpoint, checkpoint_hash, rules_version, coins, net_worth, verified_at, sampled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)',
      [id, userId, seed, startedAt, row.tick, row.checkpoint, row.checkpoint_hash, RULES_VERSION, world.coins, worth, startedAt],
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

export async function reserveAttempt(db: Db, userId: string, kind: AttemptKind, time: number, chunkLimit = CHUNK_ATTEMPTS_PER_HOUR, scale = 1): Promise<void> {
  // `scale` < 1 is the budget guard's tightened mode (housekeeping.ts); never below one attempt.
  const limit = Math.max(1, Math.floor((kind === 'chunk' ? chunkLimit : ATTEMPT_LIMITS[kind]) * scale));
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

/**
 * Rank among verified farms, exact up to RANK_CAP and null beyond. Reads at most RANK_CAP rows: the range starts at this
 * farm's worth in the ranking index, so a deep farm never scans the whole table. Ties go to the earlier verification.
 */
async function cappedRank(q: Queryable, farmId: string, worth: number, verifiedAt: number): Promise<number | null> {
  const [row] = await q.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM (SELECT 1 FROM farms INDEXED BY farms_ranked
       WHERE verified_at IS NOT NULL AND net_worth >= ?2 AND id <> ?1 AND (net_worth > ?2 OR verified_at < ?3 OR (verified_at = ?3 AND id < ?1)) LIMIT ?4)`,
    [farmId, worth, verifiedAt, RANK_CAP],
  );
  return row!.n >= RANK_CAP ? null : row!.n + 1;
}

/** Growth = worth minus the latest sample at or before now-24h (sample-and-hold), else the farm's first sample. */
export async function growthOf(q: Queryable, farmId: string, worth: number, time: number): Promise<number> {
  const [row] = await q.query<{ base: number }>(
    `SELECT COALESCE(
       (SELECT h.net_worth FROM worth_history h WHERE h.farm_id = ?1 AND h.at_ms <= ?2 ORDER BY h.at_ms DESC, h.id DESC LIMIT 1),
       (SELECT h.net_worth FROM worth_history h WHERE h.farm_id = ?1 ORDER BY h.at_ms ASC, h.id ASC LIMIT 1),
       ?3) AS base`,
    [farmId, time - DAY_MS, worth],
  );
  return worth - row!.base;
}

export interface ChunkOptions { chunkAttemptsPerHour?: number; /** Budget guard: attempt limits are multiplied by this. */ rateScale?: number; /** Budget guard: sync hints are multiplied by this. */ syncScale?: number }

/** True when the farm's fixed attempt hour is over (or the clock went backwards). Two placeholders: the current time, twice. */
const WINDOW_OVER = `(? - att_start >= ${HOUR_MS} OR ? < att_start)`;

/**
 * Verifies a chunk and advances the farm. Cost: ONE row written on the usual sync (the farm row carries the attempt counter,
 * the buffered action log and the cached rank); a `chunks` row every PENDING_MAX_AGE_MS, a worth sample every SAMPLE_EVERY_MS.
 * The attempt limit is a fixed hour kept in the farm row; the increment is a conditional UPDATE, so concurrent requests cannot
 * exceed it. An attempt that fails after the cheap checks still counts (one extra write), so invalid logs cannot evade the cap.
 */
export async function verifyChunk(db: Db, userId: string, farmId: string, input: ChunkInput, now: () => number, options: ChunkOptions = {}): Promise<ChunkResult> {
  const [farm] = await db.query<FarmRow>('SELECT * FROM farms WHERE id = ?', [farmId]);
  if (!farm) throw new HttpError(404, 'Farm not found');
  if (farm.user_id !== userId) throw new HttpError(403, 'Not your farm');
  const t = now();
  const limit = Math.max(1, Math.floor((options.chunkAttemptsPerHour ?? CHUNK_ATTEMPTS_PER_HOUR) * (options.rateScale ?? 1)));
  // Early refusal costs no write and no replay.
  if (t - farm.att_start < HOUR_MS && t >= farm.att_start && farm.att_n >= limit) throw new HttpError(429, 'Too many chunk attempts');
  try {
    return await accept(db, farm, input, t, limit, options.syncScale ?? 1);
  } catch (error) {
    if (!(error instanceof HttpError) || error.status === 429) throw error;
    const counted = await db.execute(
      `UPDATE farms SET att_start = CASE WHEN ${WINDOW_OVER} THEN ? ELSE att_start END, att_n = CASE WHEN ${WINDOW_OVER} THEN 1 ELSE att_n + 1 END
         WHERE id = ? AND (${WINDOW_OVER} OR att_n < ?)`,
      [t, t, t, t, t, farm.id, t, t, limit],
    );
    if (counted.rowsAffected === 0) throw new HttpError(429, 'Too many chunk attempts');
    throw error;
  }
}

async function accept(db: Db, farm: FarmRow, input: ChunkInput, t: number, limit: number, syncScale: number): Promise<ChunkResult> {
  if (input.rulesVersion !== RULES_VERSION || input.rulesVersion !== farm.rules_version) throw new HttpError(409, 'Rules version mismatch');
  if (input.fromTick !== farm.tick || input.checkpointHash !== farm.checkpoint_hash) throw new HttpError(409, 'Stale checkpoint');
  if (input.toTick <= input.fromTick) throw new HttpError(422, 'Invalid tick range');
  if (input.toTick > Math.floor((t - farm.started_at) / 100)) throw new HttpError(422, 'Tick is ahead of server clock');
  const world = deserialize(farm.checkpoint);
  const worth = replayOrReject(world, input.actions, input.toTick);
  const hash = hashWorld(world);
  const checkpoint = serialize(world);

  // Buffer the log in the farm row; flush it into `chunks` when old or large.
  const buffered = farm.pending_actions ? (JSON.parse(farm.pending_actions) as LogEntry[]) : [];
  const logJson = JSON.stringify([...buffered, ...input.actions]);
  const pendingFrom = farm.pending_from ?? input.fromTick;
  const pendingAt = farm.pending_from === null ? t : (farm.pending_at ?? t);
  const flush = t - pendingAt >= PENDING_MAX_AGE_MS || logJson.length >= PENDING_MAX_BYTES;

  const slowDue = t - farm.slow_at >= SLOW_REFRESH_MS;
  const sampleDue = t - farm.sampled_at >= SAMPLE_EVERY_MS;
  const rank = slowDue ? await cappedRank(db, farm.id, worth, t) : farm.rank;
  const growth = slowDue ? await growthOf(db, farm.id, worth, t) : farm.growth;

  // Only touch the growth/rank columns when refreshed: an unchanged indexed column costs no index write.
  const sets = ['tick = ?', 'checkpoint = ?', 'checkpoint_hash = ?', 'coins = ?', 'net_worth = ?', 'verified_at = ?',
    'pending_from = ?', 'pending_actions = ?', 'pending_at = ?',
    `att_start = CASE WHEN ${WINDOW_OVER} THEN ? ELSE att_start END`, `att_n = CASE WHEN ${WINDOW_OVER} THEN 1 ELSE att_n + 1 END`];
  const args: (string | number | null)[] = [world.tick, checkpoint, hash, world.coins, worth, t,
    flush ? null : pendingFrom, flush ? null : logJson, flush ? null : pendingAt, t, t, t, t, t];
  if (slowDue) { sets.push('slow_at = ?', 'rank = ?', 'growth = ?'); args.push(t, rank, growth); }
  if (sampleDue) { sets.push('sampled_at = ?'); args.push(t); }
  return db.transaction(async (tx) => {
    // Compare-and-swap on the checkpoint tick: of two racing submissions from the same checkpoint exactly one wins.
    // The same statement enforces the attempt limit, so racing requests cannot exceed it.
    const swapped = await tx.execute(
      `UPDATE farms SET ${sets.join(', ')} WHERE id = ? AND user_id = ? AND tick = ? AND (${WINDOW_OVER} OR att_n < ?)`,
      [...args, farm.id, farm.user_id, input.fromTick, t, t, limit],
    );
    if (swapped.rowsAffected === 0) {
      const [now] = await tx.query<{ tick: number }>('SELECT tick FROM farms WHERE id = ?', [farm.id]);
      throw new HttpError(now && now.tick !== input.fromTick ? 409 : 429, now && now.tick !== input.fromTick ? 'Stale checkpoint' : 'Too many chunk attempts');
    }
    if (flush) await tx.execute('INSERT INTO chunks (farm_id, from_tick, to_tick, actions, created_at) VALUES (?, ?, ?, ?, ?)', [farm.id, pendingFrom, world.tick, logJson, t]);
    if (sampleDue) await tx.execute('INSERT INTO worth_history (farm_id, net_worth, at_ms) VALUES (?, ?, ?)', [farm.id, worth, t]);
    return { tick: world.tick, checkpointHash: hash, netWorth: worth, rank, nextSyncMs: syncIntervalMs(rank, syncScale) };
  });
}

export async function leaderboard(db: Db, board: Board, limit: number, _now: number): Promise<LeaderEntry[]> {
  // Both boards read an index (farms_ranked / farms_growth) and stop after `limit` rows. Growth is cached on the farm and
  // refreshed every SLOW_REFRESH_MS, so the 24h board lags by at most that; net worth is as live as the last sync.
  const order = board === 'growth' ? 'f.growth DESC, f.verified_at ASC, f.id ASC' : 'f.net_worth DESC, f.verified_at ASC, f.id ASC';
  const rows = await db.query<{ user_id: string; display_name: string; farm_id: string; net_worth: number; growth: number; tick: number; verified_at: number }>(
    `SELECT f.user_id, u.display_name, f.id AS farm_id, f.net_worth, f.tick, f.verified_at, f.growth
     FROM farms f JOIN users u ON u.id = f.user_id
     WHERE f.verified_at IS NOT NULL ORDER BY ${order} LIMIT ?1`, // `order` is one of two constants, never request data
    [limit],
  );
  return rows.map((row, i) => ({
    rank: i + 1, userId: row.user_id, displayName: row.display_name, farmId: row.farm_id,
    netWorth: row.net_worth, growth24h: row.growth, tick: row.tick, verifiedAtMs: row.verified_at,
  }));
}

export async function getReplay(db: Db, farmId: string, fromTick = 0, limit = 1) {
  const [farm] = await db.query<{ seed: number; rules_version: number; pending_from: number | null; pending_actions: string | null; tick: number }>(
    'SELECT seed, rules_version, pending_from, pending_actions, tick FROM farms WHERE id = ? AND verified_at IS NOT NULL', [farmId]);
  if (!farm) throw new HttpError(404, 'Verified farm not found');
  // Bounded in SQL: one page plus a lookahead row for the cursor.
  const rows = await db.query<{ from_tick: number; to_tick: number; actions: string }>(
    'SELECT from_tick, to_tick, actions FROM chunks WHERE farm_id = ? AND from_tick >= ? ORDER BY from_tick LIMIT ?',
    [farmId, fromTick, limit + 1],
  );
  // The log not yet flushed into `chunks` is the last chunk.
  if (rows.length <= limit && farm.pending_from !== null && farm.pending_actions !== null && farm.pending_from >= fromTick) {
    rows.push({ from_tick: farm.pending_from, to_tick: farm.tick, actions: farm.pending_actions });
  }
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
