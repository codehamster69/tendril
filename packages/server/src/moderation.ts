import type { Db } from './db.ts';
import { DAY_MS } from './game.ts';
import { HttpError } from './validation.ts';

/** Counted reports that hide a published program. The entry's score and rank are never touched. */
export const HIDE_THRESHOLD = 3;
/** A reporter's account must be at least this old (and have a verified entry) for the report to count. */
export const MIN_REPORTER_AGE_MS = 7 * DAY_MS;
/** Reports per account per UTC day (budgeted through submission_attempts, kind 'report'). */
export const REPORTS_PER_DAY = 10;

/** SQL fragment: true when the entry named by `col` has enough counted reports. */
export const hiddenSql = (col: string): string =>
  `(SELECT COUNT(*) FROM reports r WHERE r.entry_id = ${col} AND r.counted = 1) >= ${HIDE_THRESHOLD}`;

export async function isHidden(db: Db, entryId: string): Promise<boolean> {
  const [row] = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM reports WHERE entry_id = ? AND counted = 1', [entryId]);
  return row!.n >= HIDE_THRESHOLD;
}

/**
 * POST /entries/:id/report. Only programs another player has published can be reported. Reporting twice is a no-op.
 * Reports from new accounts are stored but never counted.
 */
export async function reportProgram(db: Db, userId: string, entryId: string, now: number): Promise<{ reported: true; changed: boolean; hidden: boolean }> {
  const [entry] = await db.query<{ user_id: string; source_public: number; source_verified: number }>('SELECT user_id, source_public, source_verified FROM entries WHERE id = ?', [entryId]);
  if (!entry || entry.source_public !== 1 || entry.source_verified !== 1) throw new HttpError(404, 'No published program for this entry');
  if (entry.user_id === userId) throw new HttpError(422, 'You cannot report your own program');
  const [me] = await db.query<{ created_at: number }>('SELECT created_at FROM users WHERE id = ?', [userId]);
  if (!me) throw new HttpError(401, 'Authentication required');
  const [verified] = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM (SELECT 1 FROM entries WHERE user_id = ? AND actions_count > 0 LIMIT 1)', [userId]);
  const counted = now - me.created_at >= MIN_REPORTER_AGE_MS && verified!.n > 0 ? 1 : 0;
  const added = await db.execute('INSERT OR IGNORE INTO reports (entry_id, reporter_id, counted, created_at) VALUES (?, ?, ?, ?)', [entryId, userId, counted, now]);
  return { reported: true, changed: added.rowsAffected > 0, hidden: await isHidden(db, entryId) };
}
