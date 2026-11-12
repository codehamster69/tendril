import type { Db } from './db.ts';
import { MAX_FOLLOWING } from './players.ts';
import { HttpError } from './validation.ts';
import type { ChallengeRow } from './arena.ts';

/**
 * C1: the duel page's data and the accept step. No migration: `duel_accepts` is created on first use (the same way
 * share_hits is), so this file never competes with other threads for a migration number.
 */

const ready = new WeakMap<Db, Promise<unknown>>();
async function ensureTable(db: Db): Promise<void> {
  if (!ready.has(db)) {
    ready.set(db, db.execute('CREATE TABLE IF NOT EXISTS duel_accepts (challenge_id TEXT NOT NULL, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (challenge_id, user_id))')
      .catch((e: unknown) => { ready.delete(db); throw e; }));
  }
  await ready.get(db);
}

interface PlayerRow { id: string; login: string; display_name: string; avatar_url: string | null }

/** What /duel/?id= shows: who challenged, their best run on this duel, and what the viewer has done so far. */
export async function duelPage(db: Db, c: ChallengeRow, viewerId: string | undefined) {
  if (c.kind !== 'duel') throw new HttpError(404, 'Duel not found');
  await ensureTable(db);
  const [challenger] = c.created_by ? await db.query<PlayerRow>('SELECT id, login, display_name, avatar_url FROM users WHERE id = ?', [c.created_by]) : [];
  const [best] = challenger
    ? await db.query<{ id: string; net_worth: number; par_tick: number | null; mosaic: string | null }>(
      'SELECT id, net_worth, par_tick, mosaic FROM entries WHERE challenge_id = ? AND user_id = ? ORDER BY net_worth DESC, created_at, id LIMIT 1', [c.id, challenger.id])
    : [];
  const [accepted] = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM duel_accepts WHERE challenge_id = ?', [c.id]);
  let viewer: { isChallenger: boolean; accepted: boolean; entryId: string | null } | null = null;
  if (viewerId) {
    const [mine] = await db.query<{ id: string }>('SELECT id FROM entries WHERE challenge_id = ? AND user_id = ? ORDER BY net_worth DESC, created_at, id LIMIT 1', [c.id, viewerId]);
    const [done] = await db.query('SELECT 1 FROM duel_accepts WHERE challenge_id = ? AND user_id = ?', [c.id, viewerId]);
    viewer = { isChallenger: viewerId === c.created_by, accepted: !!done, entryId: mine?.id ?? null };
  }
  return {
    id: c.id, seed: c.seed, ticks: c.ticks, par: c.par, rulesVersion: c.rules_version, setupVersion: c.setup_v, createdAt: c.opens_at,
    challenger: challenger ? { login: challenger.login, displayName: challenger.display_name, avatarUrl: challenger.avatar_url } : null,
    entry: best ? { entryId: best.id, netWorth: best.net_worth, parTick: best.par_tick, mosaic: best.mosaic } : null,
    accepted: accepted!.n, viewer,
  };
}

/**
 * The friend finished the run: record it once and make the two players follow each other. Needs an entry of their
 * own on this duel, so a link alone (no run) cannot be used to mass-follow. A full follow list is skipped quietly.
 */
export async function acceptDuel(db: Db, c: ChallengeRow, userId: string, now: number): Promise<{ accepted: true; changed: boolean; challenger: { login: string; displayName: string } }> {
  if (c.kind !== 'duel') throw new HttpError(404, 'Duel not found');
  if (!c.created_by) throw new HttpError(404, 'Duel not found');
  if (c.created_by === userId) throw new HttpError(422, 'You cannot accept your own duel');
  await ensureTable(db);
  const [mine] = await db.query('SELECT 1 FROM entries WHERE challenge_id = ? AND user_id = ? LIMIT 1', [c.id, userId]);
  if (!mine) throw new HttpError(409, 'Finish the duel run before accepting');
  const [challenger] = await db.query<PlayerRow>('SELECT id, login, display_name, avatar_url FROM users WHERE id = ?', [c.created_by]);
  if (!challenger) throw new HttpError(404, 'Duel not found');
  const changed = await db.transaction(async (tx) => {
    const r = await tx.execute('INSERT OR IGNORE INTO duel_accepts (challenge_id, user_id, created_at) VALUES (?, ?, ?)', [c.id, userId, Math.trunc(now)]);
    for (const [from, to] of [[userId, challenger.id], [challenger.id, userId]] as const) {
      const [n] = await tx.query<{ n: number }>('SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?', [from]);
      if (n!.n < MAX_FOLLOWING) await tx.execute('INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)', [from, to, Math.trunc(now)]);
    }
    return r.rowsAffected > 0;
  });
  return { accepted: true, changed, challenger: { login: challenger.login, displayName: challenger.display_name } };
}

/** For /stats: how many duels were made and how many were accepted (finished by a second player). */
export async function duelCounts(db: Db): Promise<{ created: number; accepted: number }> {
  await ensureTable(db);
  const [row] = await db.query<{ created: number; accepted: number }>("SELECT (SELECT COUNT(*) FROM challenges WHERE kind = 'duel') AS created, (SELECT COUNT(*) FROM duel_accepts) AS accepted");
  return { created: row!.created, accepted: row!.accepted };
}
