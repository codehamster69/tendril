import { randomBytes, randomUUID } from 'node:crypto';
import type { PGlite, Transaction } from '@electric-sql/pglite';
import { createWorld, deserialize, hashWorld, IllegalAction, netWorth, replayChunk, RULES_VERSION, serialize } from '@tendril/sim/src/index.ts';
import type { LogEntry } from '@tendril/sim/src/index.ts';
import { asService, safeNumber } from './db.ts';
import { HttpError } from './validation.ts';
import type { ChunkInput } from './validation.ts';

type DbNumber = number | string;
interface FarmRow {
  id: string; user_id: string; seed: DbNumber; started_at_ms: DbNumber; tick: DbNumber;
  checkpoint: string; checkpoint_hash: string; rules_version: number; coins: DbNumber; net_worth: DbNumber;
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

function farmResponse(farm: FarmRow): FarmResponse {
  return {
    id: farm.id, seed: safeNumber(farm.seed), startedAtMs: safeNumber(farm.started_at_ms), tick: safeNumber(farm.tick),
    checkpoint: farm.checkpoint, checkpointHash: farm.checkpoint_hash, rulesVersion: farm.rules_version,
    coins: safeNumber(farm.coins), netWorth: safeNumber(farm.net_worth),
  };
}

export async function createFarm(db: PGlite, userId: string, now: () => number) {
  return asService(db, async (tx) => {
    await tx.query('SELECT id FROM profiles WHERE id = $1 FOR UPDATE', [userId]);
    const existing = await tx.query<FarmRow>('SELECT * FROM farms WHERE user_id = $1', [userId]);
    if (existing.rows[0]) return { status: 200, farm: farmResponse(existing.rows[0]) };
    const id = randomUUID();
    const seed = randomBytes(4).readUInt32LE() || 1;
    const startedAt = now();
    const world = createWorld({ id, seed });
    const hash = hashWorld(world);
    const result = await tx.query<FarmRow>(
      'INSERT INTO farms (id, user_id, seed, started_at_ms, tick, checkpoint, checkpoint_hash, rules_version, coins, net_worth) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *',
      [id, userId, seed, startedAt, world.tick, serialize(world), hash, RULES_VERSION, world.coins, netWorth(world)],
    );
    await tx.query('INSERT INTO worth_history (farm_id, net_worth, verified_at_ms) VALUES ($1, $2, $3)', [id, netWorth(world), startedAt]);
    return { status: 201, farm: farmResponse(result.rows[0]!) };
  });
}

export async function getFarm(db: PGlite, userId: string): Promise<FarmResponse> {
  return asService(db, async (tx) => {
    const result = await tx.query<FarmRow>('SELECT * FROM farms WHERE user_id = $1', [userId]);
    if (!result.rows[0]) throw new HttpError(404, 'Farm not found');
    return farmResponse(result.rows[0]);
  });
}

// Attempts commit separately so invalid submissions cannot roll back the abuse limit.
export async function reserveAttempt(db: PGlite, userId: string, now: () => number): Promise<void> {
  const allowed = await asService(db, async (tx) => {
    await tx.query('SELECT id FROM profiles WHERE id = $1 FOR UPDATE', [userId]);
    const time = now();
    await tx.query('DELETE FROM chunk_attempts WHERE user_id = $1 AND attempted_at_ms <= $2', [userId, time - HOUR_MS]);
    const count = await tx.query<{ count: DbNumber }>('SELECT count(*) AS count FROM chunk_attempts WHERE user_id = $1', [userId]);
    if (safeNumber(count.rows[0]!.count) >= 10) return false;
    await tx.query('INSERT INTO chunk_attempts (user_id, attempted_at_ms) VALUES ($1, $2)', [userId, time]);
    return true;
  });
  if (!allowed) throw new HttpError(429, 'Too many chunk attempts');
}

async function rank(tx: Transaction, farmId: string): Promise<number> {
  const result = await tx.query<{ rank: DbNumber }>(
    'WITH ranked AS (SELECT farm_id, row_number() OVER (ORDER BY net_worth DESC, verified_at_ms ASC, farm_id ASC) AS rank FROM scores) SELECT rank FROM ranked WHERE farm_id = $1', [farmId],
  );
  return safeNumber(result.rows[0]!.rank);
}

export async function verifyChunk(db: PGlite, userId: string, farmId: string, input: ChunkInput, now: () => number) {
  return asService(db, async (tx) => {
    const result = await tx.query<FarmRow>('SELECT * FROM farms WHERE id = $1 FOR UPDATE', [farmId]);
    const farm = result.rows[0];
    if (!farm) throw new HttpError(404, 'Farm not found');
    if (farm.user_id !== userId) throw new HttpError(403, 'Not your farm');
    if (input.rulesVersion !== RULES_VERSION || input.rulesVersion !== farm.rules_version) throw new HttpError(409, 'Rules version mismatch');
    if (input.fromTick !== safeNumber(farm.tick) || input.checkpointHash !== farm.checkpoint_hash) throw new HttpError(409, 'Stale checkpoint');
    const duplicate = await tx.query('SELECT 1 FROM chunks WHERE farm_id = $1 AND from_tick = $2 AND checkpoint_hash = $3', [farmId, input.fromTick, input.checkpointHash]);
    if (duplicate.rows.length) throw new HttpError(409, 'Stale checkpoint');
    const verifiedAt = now();
    const availableTick = Math.floor((verifiedAt - safeNumber(farm.started_at_ms)) / 100);
    if (input.toTick > availableTick) throw new HttpError(422, 'Tick is ahead of server clock');
    const world = deserialize(farm.checkpoint);
    try {
      replayChunk(world, input.actions, input.toTick);
      if (!Number.isSafeInteger(world.coins) || !Number.isSafeInteger(netWorth(world)) || !Number.isSafeInteger(world.tick)) throw new HttpError(422, 'Simulation overflow');
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error instanceof IllegalAction || (error instanceof Error && error.message === 'overflow')) throw new HttpError(422, 'Invalid action log');
      throw error;
    }
    const hash = hashWorld(world);
    const worth = netWorth(world);
    await tx.query('INSERT INTO chunks (farm_id, from_tick, to_tick, checkpoint_hash, actions, verified_at_ms) VALUES ($1, $2, $3, $4, $5, $6)', [farmId, input.fromTick, input.toTick, input.checkpointHash, JSON.stringify(input.actions), verifiedAt]);
    await tx.query('UPDATE farms SET tick = $1, checkpoint = $2, checkpoint_hash = $3, coins = $4, net_worth = $5 WHERE id = $6', [world.tick, serialize(world), hash, world.coins, worth, farmId]);
    await tx.query('INSERT INTO scores (farm_id, user_id, net_worth, tick, verified_at_ms) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (farm_id) DO UPDATE SET net_worth = EXCLUDED.net_worth, tick = EXCLUDED.tick, verified_at_ms = EXCLUDED.verified_at_ms', [farmId, userId, worth, world.tick, verifiedAt]);
    await tx.query('INSERT INTO worth_history (farm_id, net_worth, verified_at_ms) VALUES ($1, $2, $3)', [farmId, worth, verifiedAt]);
    return { tick: world.tick, checkpointHash: hash, netWorth: worth, rank: await rank(tx, farmId) };
  });
}

export async function leaderboard(db: PGlite, board: Board, limit: number, now: number): Promise<LeaderEntry[]> {
  return asService(db, async (tx) => {
    const result = await tx.query<{
      rank: DbNumber; user_id: string; display_name: string; farm_id: string;
      net_worth: DbNumber; growth: DbNumber; tick: DbNumber; verified_at_ms: DbNumber;
    }>(`
      WITH board_values AS (
        SELECT s.*, p.display_name, s.net_worth - COALESCE(b.net_worth, first_sample.net_worth, s.net_worth) AS growth
        FROM scores s JOIN profiles p ON p.id = s.user_id
        LEFT JOIN LATERAL (
          SELECT net_worth FROM worth_history h WHERE h.farm_id = s.farm_id AND h.verified_at_ms <= $1
          ORDER BY h.verified_at_ms DESC, h.id DESC LIMIT 1
        ) b ON true
        LEFT JOIN LATERAL (
          SELECT net_worth FROM worth_history h WHERE h.farm_id = s.farm_id
          ORDER BY h.verified_at_ms ASC, h.id ASC LIMIT 1
        ) first_sample ON true
      )
      SELECT *, row_number() OVER (ORDER BY CASE WHEN $2 = 'growth' THEN growth ELSE net_worth END DESC, verified_at_ms ASC, farm_id ASC) AS rank
      FROM board_values ORDER BY rank LIMIT $3
    `, [now - DAY_MS, board, limit]);
    return result.rows.map((row) => ({
      rank: safeNumber(row.rank), userId: row.user_id, displayName: row.display_name, farmId: row.farm_id,
      netWorth: safeNumber(row.net_worth), growth24h: safeNumber(row.growth), tick: safeNumber(row.tick), verifiedAtMs: safeNumber(row.verified_at_ms),
    }));
  });
}

export async function getReplay(db: PGlite, farmId: string, fromTick = 0, limit = 1) {
  return asService(db, async (tx) => {
    const farm = await tx.query<{ seed: DbNumber; rules_version: number }>('SELECT f.seed, f.rules_version FROM farms f JOIN scores s ON s.farm_id = f.id WHERE f.id = $1', [farmId]);
    if (!farm.rows[0]) throw new HttpError(404, 'Verified farm not found');
    // Bound allocation in SQL, including just one lookahead row for the cursor.
    const result = await tx.query<{ from_tick: DbNumber; to_tick: DbNumber; actions: LogEntry[] }>(
      'SELECT from_tick, to_tick, actions FROM chunks WHERE farm_id = $1 AND from_tick >= $2 ORDER BY from_tick LIMIT $3',
      [farmId, fromTick, limit + 1],
    );
    return {
      seed: safeNumber(farm.rows[0].seed), rulesVersion: farm.rows[0].rules_version,
      chunks: result.rows.slice(0, limit).map((row) => ({ fromTick: safeNumber(row.from_tick), toTick: safeNumber(row.to_tick), actions: row.actions })),
      nextFromTick: result.rows[limit] ? safeNumber(result.rows[limit].from_tick) : null,
    };
  });
}
