import type { Db } from './db.ts';
import type { Env } from './auth.ts';
import { DAY_MS } from './game.ts';

/**
 * Housekeeping and the free-tier budget guard (task F2). Nothing here is load-bearing on a schedule: the daily prune
 * runs from a Vercel cron AND lazily on the first request of each UTC day, and the guard re-measures on demand.
 * Free-tier numbers and the projection live in brain/notes/F2.md.
 */

// ---- budget guard ----

export type GuardMode = 'normal' | 'lean' | 'tight' | 'readonly';
export const GUARD_MODES: GuardMode[] = ['normal', 'lean', 'tight', 'readonly'];
/** Turso Free: 5 GB storage, 10M rows written / month. Defaults leave headroom; env overrides exist for an upgrade. */
export const DEFAULT_STORAGE_BUDGET_BYTES = 4_000_000_000;
export const DEFAULT_WRITES_BUDGET_PER_MONTH = 8_000_000;
/** Fraction of a budget at which each mode engages. A mode releases only 5 points below its entry point. */
export const ENTER_AT: Record<Exclude<GuardMode, 'normal'>, number> = { lean: 0.5, tight: 0.7, readonly: 0.9 };
export const RELEASE_MARGIN = 0.05;
/** In tight mode every per-user attempt limit is multiplied by this. */
export const TIGHT_SCALE = 0.25;
export const GUARD_REFRESH_MS = 10 * 60 * 1000;
/** Write rate is sampled over this window and projected to a month. Short on purpose: it is a read cost every refresh. */
export const SAMPLE_MS = 5 * 60 * 1000;
const MONTH_MS = 30 * DAY_MS;
/** Rows written per verified chunk (farm update, chunk, worth sample, attempt) and per stored entry (entry, attempt, trims). */
const WRITES_PER_CHUNK = 4;
const WRITES_PER_ENTRY = 3;

export const TOP_KEEP = 100;
export const CHUNK_RETENTION_MS = 14 * DAY_MS;
export const DUEL_RETENTION_MS = 90 * DAY_MS;
/** Closed challenges stay whole this long first (the legacy daily alias still accepts a day after closing). */
export const PRUNE_AFTER_CLOSE_MS = 2 * DAY_MS;
const BATCH = 2000;
const MAX_BATCHES = 25;

const levelOf = (mode: GuardMode): number => GUARD_MODES.indexOf(mode);

/** Pure: next mode from the current one and the worst budget ratio, with release hysteresis. */
export function decideMode(current: GuardMode, ratio: number): GuardMode {
  let level = levelOf(current);
  let up = 0;
  GUARD_MODES.forEach((m, i) => { if (i > 0 && ratio >= ENTER_AT[m as Exclude<GuardMode, 'normal'>]) up = i; });
  if (up > level) return GUARD_MODES[up]!;
  while (level > 0 && ratio < ENTER_AT[GUARD_MODES[level] as Exclude<GuardMode, 'normal'>] - RELEASE_MARGIN) level--;
  return GUARD_MODES[level]!;
}

async function getMeta(db: Db, key: string): Promise<string | null> {
  const [row] = await db.query<{ value: string }>('SELECT value FROM arena_meta WHERE key = ?', [key]);
  return row?.value ?? null;
}
const setMeta = (db: Db, key: string, value: string): Promise<unknown> =>
  db.execute('INSERT INTO arena_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);

/** Live database size without scanning any table: used pages minus free pages. */
export async function storageBytes(db: Db): Promise<number> {
  const [row] = await db.query<{ bytes: number }>(
    'SELECT ((SELECT page_count FROM pragma_page_count()) - (SELECT freelist_count FROM pragma_freelist_count())) * (SELECT page_size FROM pragma_page_size()) AS bytes',
  );
  return Number(row?.bytes ?? 0);
}

/** Projected rows written per month from the last few minutes of verified chunks and stored entries. */
export async function projectedMonthlyWrites(db: Db, now: number): Promise<number> {
  const since = now - SAMPLE_MS;
  const [c] = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM chunks WHERE created_at > ?', [since]);
  const [e] = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM entries WHERE created_at > ?', [since]);
  return Math.round(((c!.n * WRITES_PER_CHUNK + e!.n * WRITES_PER_ENTRY) * MONTH_MS) / SAMPLE_MS);
}

const positive = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export interface GuardState { mode: GuardMode; bytes: number; projectedWrites: number; checkedAt: number }

/** Measures, decides, and stores the mode. Safe to call from anywhere, any number of times. */
export async function refreshGuard(db: Db, env: Env, now: number): Promise<GuardState> {
  const previous = ((await getMeta(db, 'guard_mode')) ?? 'normal') as GuardMode;
  const bytes = await storageBytes(db);
  const projectedWrites = await projectedMonthlyWrites(db, now);
  const ratio = Math.max(
    bytes / positive(env.TENDRIL_STORAGE_BUDGET_BYTES, DEFAULT_STORAGE_BUDGET_BYTES),
    projectedWrites / positive(env.TENDRIL_WRITES_BUDGET_PER_MONTH, DEFAULT_WRITES_BUDGET_PER_MONTH),
  );
  const mode = decideMode(GUARD_MODES.includes(previous) ? previous : 'normal', ratio);
  await setMeta(db, 'guard_mode', mode);
  await setMeta(db, 'guard_state', JSON.stringify({ bytes, projectedWrites, checkedAt: now }));
  return { mode, bytes, projectedWrites, checkedAt: now };
}

/** Per-app guard: reads the stored mode (re-measuring when stale) and caches it briefly in memory. */
export function createGuard(db: Db, env: Env, now: () => number) {
  let cached: { mode: GuardMode; at: number } | undefined;
  return {
    async mode(): Promise<GuardMode> {
      const t = now();
      if (cached && t - cached.at < 30_000 && t >= cached.at) return cached.mode;
      let mode: GuardMode;
      const raw = await getMeta(db, 'guard_state');
      const checkedAt = raw ? (JSON.parse(raw) as GuardState).checkedAt : 0;
      if (t - checkedAt >= GUARD_REFRESH_MS || t < checkedAt) mode = (await refreshGuard(db, env, t)).mode;
      else { const stored = await getMeta(db, 'guard_mode'); mode = GUARD_MODES.includes(stored as GuardMode) ? (stored as GuardMode) : 'normal'; }
      cached = { mode, at: t };
      return mode;
    },
    forget(): void { cached = undefined; },
  };
}

export const rateScale = (mode: GuardMode): number => (mode === 'tight' || mode === 'readonly' ? TIGHT_SCALE : 1);

// ---- pruning ----

/** The entries a closed challenge keeps whole: the top TOP_KEEP of each medal. Only constants are interpolated. */
const TOP_IDS = `
  SELECT id FROM (SELECT id FROM entries WHERE challenge_id = ?1 ORDER BY net_worth DESC, created_at ASC, id ASC LIMIT ${TOP_KEEP})
  UNION SELECT id FROM (SELECT id FROM entries WHERE challenge_id = ?1 AND par_tick IS NOT NULL ORDER BY par_tick ASC, net_worth DESC, created_at ASC, id ASC LIMIT ${TOP_KEEP})
  UNION SELECT id FROM (SELECT id FROM entries WHERE challenge_id = ?1 AND tokens IS NOT NULL ORDER BY tokens ASC, net_worth DESC, created_at ASC, id ASC LIMIT ${TOP_KEEP})`;

/** Drops the stored log and source (not the score, rank or mosaic) of every entry outside the top of each medal. */
export async function dropReplaysOutsideTop(db: Db, challengeId: string, onlyEntryId?: string): Promise<number> {
  const only = onlyEntryId === undefined ? '' : ' AND id = ?2';
  const args = onlyEntryId === undefined ? [challengeId] : [challengeId, onlyEntryId];
  const r = await db.execute(`UPDATE entries SET actions = NULL, source = NULL WHERE challenge_id = ?1 AND actions IS NOT NULL${only} AND id NOT IN (${TOP_IDS})`, args);
  return r.rowsAffected;
}

export interface PruneReport {
  challengesPruned: number; entriesTrimmed: number; duelEntriesTrimmed: number; chunks: number; sessions: number; attempts: number; worthSamples: number;
}

async function deleteInBatches(db: Db, sql: string, args: (string | number)[]): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const { rowsAffected } = await db.execute(sql, [...args, BATCH]);
    total += rowsAffected;
    if (rowsAffected < BATCH) break;
  }
  return total;
}

/** Idempotent and bounded per call. A backlog drains over successive days. */
export async function prune(db: Db, now: number): Promise<PruneReport> {
  const report: PruneReport = { challengesPruned: 0, entriesTrimmed: 0, duelEntriesTrimmed: 0, chunks: 0, sessions: 0, attempts: 0, worthSamples: 0 };

  // Closed challenges: oldest unprocessed first, tracked by a watermark on closes_at.
  const watermark = Number((await getMeta(db, 'prune_closes_at')) ?? 0);
  const closed = await db.query<{ id: string; closes_at: number }>(
    'SELECT id, closes_at FROM challenges WHERE closes_at IS NOT NULL AND closes_at > ? AND closes_at <= ? ORDER BY closes_at ASC LIMIT 50',
    [watermark, now - PRUNE_AFTER_CLOSE_MS],
  );
  for (const c of closed) {
    report.entriesTrimmed += await dropReplaysOutsideTop(db, c.id);
    report.challengesPruned++;
    await setMeta(db, 'prune_closes_at', String(c.closes_at));
  }

  // Duels never close: their replays expire by age instead.
  const duelMark = Number((await getMeta(db, 'prune_duel_opens_at')) ?? 0);
  const duels = await db.query<{ id: string; opens_at: number }>(
    "SELECT id, opens_at FROM challenges WHERE kind = 'duel' AND opens_at > ? AND opens_at <= ? ORDER BY opens_at ASC LIMIT 200",
    [duelMark, now - DUEL_RETENTION_MS],
  );
  for (const d of duels) {
    report.duelEntriesTrimmed += (await db.execute('UPDATE entries SET actions = NULL, source = NULL WHERE challenge_id = ? AND actions IS NOT NULL', [d.id])).rowsAffected;
    await setMeta(db, 'prune_duel_opens_at', String(d.opens_at));
  }

  // Endless chunks past the retention window, always keeping each farm's newest chunk (its checkpoint's tail).
  report.chunks = await deleteInBatches(
    db,
    `DELETE FROM chunks WHERE (farm_id, from_tick) IN (
       SELECT c.farm_id, c.from_tick FROM chunks c JOIN farms f ON f.id = c.farm_id
       WHERE c.created_at < ? AND c.to_tick < f.tick ORDER BY c.created_at LIMIT ?)`,
    [now - CHUNK_RETENTION_MS],
  );

  for (const table of ['sessions', 'oauth_states', 'desktop_logins']) {
    report.sessions += (await db.execute(`DELETE FROM ${table} WHERE expires_at < ?`, [now])).rowsAffected;
  }
  report.attempts = (await db.execute('DELETE FROM submission_attempts WHERE at_ms < ?', [now - 2 * DAY_MS])).rowsAffected;

  // Net-worth samples: three days are enough for the 24h growth board. Each farm keeps its newest sample at or before
  // now-24h, so a farm that went quiet still shows the right growth when it returns.
  report.worthSamples = await deleteInBatches(
    db,
    `DELETE FROM worth_history WHERE id IN (
       SELECT id FROM worth_history WHERE at_ms < ?1
         AND id NOT IN (SELECT MAX(h.id) FROM worth_history h WHERE h.at_ms <= ?2 GROUP BY h.farm_id) LIMIT ?3)`,
    [now - 3 * DAY_MS, now - DAY_MS],
  );
  return report;
}

/**
 * Runs the prune at most once per UTC day across all instances: the first caller claims the day in arena_meta.
 * A failed run gives the claim back so the next request (or the cron) retries.
 */
export async function pruneOncePerDay(db: Db, now: number): Promise<PruneReport | null> {
  const day = new Date(now).toISOString().slice(0, 10);
  const previous = await getMeta(db, 'pruned_day');
  if (previous !== null && previous >= day) return null;
  const claim = await db.execute(
    'INSERT INTO arena_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2 WHERE value < ?2',
    ['pruned_day', day],
  );
  if (claim.rowsAffected === 0) return null;
  try {
    const report = await prune(db, now);
    await setMeta(db, 'prune_report', JSON.stringify({ day, ...report }));
    return report;
  } catch (error) {
    if (previous === null) await db.execute("DELETE FROM arena_meta WHERE key = 'pruned_day'");
    else await setMeta(db, 'pruned_day', previous);
    throw error;
  }
}

// ---- cache headers for read routes ----

/** Edge cache lifetime in seconds for a public, anonymous GET on `route` (the part after /api), or null for never. */
export function edgeSeconds(route: string): number | null {
  if (route === '/leaderboard' || route === '/daily/leaderboard') return 30;
  if (route === '/stats') return 300;
  if (route === '/daily') return 60;
  if (/^\/challenges\/[^/]+$/.test(route)) return 30;
  if (/^\/challenges\/[^/]+\/board$/.test(route)) return 30;
  if (/^\/entries\/[^/]+$/.test(route)) return 60;
  if (/^\/entries\/[^/]+\/replay$/.test(route)) return 3600;
  if (/^\/farms\/[^/]+\/replay$/.test(route)) return 300;
  return null;
}

/**
 * Applies cache headers to a finished response. Only successful, anonymous GETs are cacheable: anything that carries a
 * cookie or bearer token may differ per viewer (`me`, friends, sealed replays) and stays no-store, as does every error.
 * No `Vary: Cookie` or `Vary: Authorization`: Vercel's CDN refuses to cache a response that names Cookie, and never caches a request
 * with an Authorization header. The app's own `Vary: Origin` stays, so desktop (CORS) answers are keyed apart.
 */
export function withCacheHeaders(request: Request, response: Response): Response {
  if (request.method !== 'GET' || response.status !== 200) return response;
  if (request.headers.has('authorization') || request.headers.has('cookie') || request.headers.has('origin')) return response;
  const path = new URL(request.url).pathname;
  const seconds = path.startsWith('/api/') ? edgeSeconds(path.slice(4)) : null;
  if (seconds === null) return response;
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', `public, max-age=0, s-maxage=${seconds}, stale-while-revalidate=${seconds * 2}`);
  return new Response(response.body, { status: response.status, headers });
}
