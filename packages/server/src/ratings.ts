import { createHash, randomUUID } from 'node:crypto';
import { ALGO_VERSION, DAILY_WEIGHT, ESTABLISHED_FIELD_MIN, PLACEMENT_EVENTS, SEASON_WEIGHT, START_RATING, rateContest, tierOf } from '@tendril/rating/src/index.ts';
import type { Standing, TierInfo } from '@tendril/rating/src/index.ts';
import type { Env } from './auth.ts';
import type { Db, Queryable } from './db.ts';
import { DAY_MS } from './game.ts';
import { isClosed, isSettled, percentileOf } from './arena.ts';
import type { BoardResult, BoardRow, ChallengeRow, Medal } from './arena.ts';
import { HttpError } from './validation.ts';
import { MODEL_KEY_PREFIX, rateGhosts, ratingModels as readModels } from './model-ratings.ts';

/**
 * R2: the rating store and the lazy rater. The maths is `@tendril/rating` (pure); this file decides who is in a field and keeps
 * the results. Layout, eligibility and the lock are described in brain/notes/R2.md and brain/CONTRACTS.md ("Ratings").
 *
 * The rating is a pure function of stored standings in closing order: nothing here reads the clock except to stamp `rated_at`,
 * and the stamp is kept by a recompute, so a rebuild is byte-identical to the live path.
 */

export type Discipline = 'overall' | 'speed' | 'brevity';
export const DISCIPLINES: readonly Discipline[] = ['overall', 'speed', 'brevity'];
export const MEDAL_OF: Record<Discipline, Medal> = { overall: 'wealth', speed: 'speed', brevity: 'brevity' };
const DISCIPLINE_OF_MEDAL: Record<Medal, Discipline> = { wealth: 'overall', speed: 'speed', brevity: 'brevity' };

/** The GitHub account must be this old when the contest closes. */
export const MIN_ACCOUNT_AGE_MS = 14 * DAY_MS;
/** A player with no rated run for this long leaves the ladder (the rating is kept). */
export const ACTIVE_WINDOW_MS = 30 * DAY_MS;
export const LOCK_KEY = 'rating_lock';
export const LOCK_TTL_MS = 2 * 60_000;
/** Contests rated per lazy run; a backlog drains over successive requests. */
export const MAX_CONTESTS_PER_RUN = 4;
export const HISTORY_CAP = 400;
/** Requests that are not rating routes look for a finished contest at most this often per instance. */
export const CHECK_EVERY_MS = 60_000;
const PROFILE_CHUNK = 40;
const IN_CHUNK = 400;

// ---- stored shapes ----

interface HistoryRow {
  c: string; k: 'd' | 's'; at: number; // challenge id, kind, closes_at
  p: number; f: number; pf: number; d: number; b: number; r: number; // place, field (rated entrants), performance, delta, rating before, rating after
  e: string; // the entry that earned it (replay link)
}
interface DisciplineData { r: number; n: number; pk: number; h: HistoryRow[] }
interface ProfileData { v: 1; d: Partial<Record<Discipline, DisciplineData>> }

const getMeta = async (q: Queryable, key: string): Promise<string | null> => (await q.query<{ value: string }>('SELECT value FROM arena_meta WHERE key = ?', [key]))[0]?.value ?? null;
const setMeta = (q: Queryable, key: string, value: string): Promise<unknown> =>
  q.execute('INSERT INTO arena_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

// ---- program similarity ----

/**
 * Canonical form of a Sprout program for the duplicate-source check: comments, blank lines, spacing and indentation width are
 * dropped (nesting depth and every token kept). Names are NOT normalised, so a copy with renamed variables is not caught here
 * (it still runs the same log, which the log-hash check catches). Deliberately a lexer-free approximation: the server never imports the interpreter.
 */
export function normalizeSource(source: string): string {
  const out: string[] = [];
  const indents = [0];
  const token = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#.*|\d[\d_]*|[A-Za-z_]\w*|==|!=|<=|>=|\+=|-=|\*=|\S/g;
  for (const raw of source.replace(/\r/g, '').split('\n')) {
    const line = raw.replace(/\t/g, '    ');
    const body = line.trim();
    if (!body || body.startsWith('#')) continue;
    const space = line.length - line.trimStart().length;
    while (space < indents[indents.length - 1]!) indents.pop();
    if (space > indents[indents.length - 1]!) indents.push(space);
    const tokens = (body.match(token) ?? []).filter((t) => !t.startsWith('#'));
    out.push(`${indents.length - 1}:${tokens.join(' ')}`);
  }
  return out.join('\n');
}

// ---- building a contest's standings ----

export interface Cand {
  id: string; user_id: string; net_worth: number; par_tick: number | null; tokens: number | null; created_at: number;
  log_hash: string; actions_count: number; author_kind: string; github_created_at: number | null;
}

type Cmp = (a: Cand, b: Cand) => number;
const byAge: Cmp = (a, b) => a.created_at - b.created_at || cmp(a.id, b.id);
/** Board order for each discipline (arena.ts MEDALS): best first, earlier entry on a full tie. */
const ORDER: Record<Discipline, Cmp> = {
  overall: (a, b) => b.net_worth - a.net_worth || byAge(a, b),
  speed: (a, b) => a.par_tick! - b.par_tick! || b.net_worth - a.net_worth || byAge(a, b),
  brevity: (a, b) => a.tokens! - b.tokens! || b.net_worth - a.net_worth || byAge(a, b),
};
/** Entries with an equal tie key finish in the same place. */
const TIE_KEY: Record<Discipline, (c: Cand) => string> = {
  overall: (c) => `${c.net_worth}`,
  speed: (c) => `${c.par_tick}:${c.net_worth}`,
  brevity: (c) => `${c.tokens}:${c.net_worth}`,
};

/** `banned` appears only when an operator exclusion applied, so unbanned contests keep their stored bytes. */
export interface Exclusions { belowPar: number; account: number; dupLog: number; dupSource: number; banned?: number }
interface Built {
  standings: { id: string; place: number; entryId: string }[];
  entrants: number; excluded: Exclusions; dupSource: string[];
}

/**
 * Who is in one discipline's field, and where they finished. Only declared-human entries that reached par count (and, for
 * Brevity, that carry a counted program). Each player's best entry stands for them. A player whose entry repeats an earlier
 * player's log, or whose normalised program matches an earlier player's, is out for the day (the first submitter keeps the place).
 * Players whose GitHub account was under 14 days old at closing, or unknown, are out. The field is therefore made only of players
 * who meet every rule: the engine's field-size weight can no longer be padded with accounts that could never be rated.
 */
export function buildStandings(
  discipline: Discipline, cands: Cand[], closesAt: number, sourceKeys: Map<string, string>, dupSourceOverride?: string[], banned: ReadonlySet<string> = new Set(),
): Built {
  const humans = cands.filter((c) => c.author_kind === 'human');
  const entrantIds = new Set(humans.map((c) => c.user_id));
  const gates = (c: Cand): boolean => c.par_tick !== null && (discipline !== 'brevity' || c.tokens !== null);
  const parIds = new Set(humans.filter((c) => c.par_tick !== null).map((c) => c.user_id));
  const best = new Map<string, Cand>();
  for (const c of humans) {
    if (!gates(c)) continue;
    const cur = best.get(c.user_id);
    if (!cur || ORDER[discipline](c, cur) < 0) best.set(c.user_id, c);
  }
  const chosen = [...best.values()];

  const excluded: Exclusions = { belowPar: entrantIds.size - parIds.size, account: 0, dupLog: 0, dupSource: 0 };
  // R9: only players who could be rated take part in the duplicate check. Otherwise an account that can never be rated (too young,
  // excluded by an operator) could submit someone's published program first and push the real player out as "the copy".
  const eligible: Cand[] = [];
  for (const c of chosen) {
    if (banned.has(c.user_id)) excluded.banned = (excluded.banned ?? 0) + 1;
    else if (c.github_created_at === null || c.github_created_at > closesAt - MIN_ACCOUNT_AGE_MS) excluded.account++;
    else eligible.push(c);
  }
  const dupUsers = new Set<string>();
  const seenLogs = new Set<string>(), seenSources = new Set<string>();
  const override = dupSourceOverride ? new Set(dupSourceOverride) : null;
  const dupSource: string[] = [];
  for (const c of [...eligible].sort(byAge)) {
    if (c.actions_count > 0) {
      if (seenLogs.has(c.log_hash)) { dupUsers.add(c.user_id); excluded.dupLog++; continue; }
      seenLogs.add(c.log_hash);
    }
    const key = sourceKeys.get(c.id);
    const repeat = override ? override.has(c.user_id) : key !== undefined && seenSources.has(key);
    if (repeat) { dupUsers.add(c.user_id); excluded.dupSource++; dupSource.push(c.user_id); continue; }
    if (key !== undefined) seenSources.add(key);
  }

  const ordered = eligible.filter((c) => !dupUsers.has(c.user_id)).sort(ORDER[discipline]);
  const standings: Built['standings'] = [];
  let prevKey = '', prevPlace = 0;
  for (const c of ordered) {
    const key = TIE_KEY[discipline](c);
    const place = standings.length > 0 && key === prevKey ? prevPlace : standings.length + 1;
    standings.push({ id: c.user_id, place, entryId: c.id });
    prevKey = key; prevPlace = place;
  }
  return { standings, entrants: entrantIds.size, excluded, dupSource: dupSource.sort() };
}

/** Players in the engine's field: the established ones once 30 exist, else everyone (mirrors the engine). */
export function engineFieldSize(standings: readonly Standing[]): number {
  const established = standings.filter((s) => s.events >= PLACEMENT_EVENTS).length;
  return established >= ESTABLISHED_FIELD_MIN ? established : standings.length;
}

// ---- rating one contest ----

export interface ContestReport {
  challengeId: string;
  rated: Record<Discipline, boolean>;
  /** Players whose profile row was written. */
  participants: number;
  profileWrites: number;
  /** Ghost (declared model) ratings written, outside `writes`. */
  modelWrites: number;
  /** rating_contests rows (3) plus the resume marker (1). */
  bookkeepingWrites: number;
  writes: number;
}

export interface RateOptions { ratedAt: number; dupSource?: Partial<Record<Discipline, string[]>> }

/**
 * Operator lever (R9): `arena_meta` key `rating_excluded` holds a JSON array of user ids whose entries are never rated or ghost-rated.
 * Moderation reports only hide an entry; they deliberately do not touch ratings (mass reports must not be a way to hurt a rating).
 * After editing the list, run `ratings:recompute` to remove the player's past results from everyone else's history.
 */
export const EXCLUDED_KEY = 'rating_excluded';
async function excludedUsers(q: Queryable): Promise<Set<string>> {
  const raw = await getMeta(q, EXCLUDED_KEY);
  if (raw === null) return new Set();
  try { const v: unknown = JSON.parse(raw); return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []); } catch { return new Set(); }
}

const weightOf = (c: ChallengeRow): number => (c.kind === 'season' ? SEASON_WEIGHT : DAILY_WEIGHT);

async function loadProfiles(q: Queryable, ids: string[]): Promise<Map<string, ProfileData>> {
  const map = new Map<string, ProfileData>();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const part = ids.slice(i, i + IN_CHUNK);
    const rows = await q.query<{ user_id: string; data: string }>(`SELECT user_id, data FROM rating_profiles WHERE user_id IN (${part.map(() => '?').join(',')})`, part);
    for (const r of rows) map.set(r.user_id, JSON.parse(r.data) as ProfileData);
  }
  return map;
}

const COLUMNS = ['r_overall', 'n_overall', 'l_overall', 'r_speed', 'n_speed', 'l_speed', 'r_brevity', 'n_brevity', 'l_brevity'];
function columnsOf(p: ProfileData): (number | null)[] {
  return DISCIPLINES.flatMap((d) => {
    const x = p.d[d];
    return x ? [x.r, x.n, x.h[x.h.length - 1]!.at] : [null, null, null];
  });
}

async function writeProfiles(tx: Queryable, rows: [string, ProfileData][], updatedAt: number): Promise<void> {
  for (let i = 0; i < rows.length; i += PROFILE_CHUNK) {
    const part = rows.slice(i, i + PROFILE_CHUNK);
    const args = part.flatMap(([id, p]) => [id, JSON.stringify(p), updatedAt, ...columnsOf(p)]);
    await tx.execute(
      `INSERT INTO rating_profiles (user_id, data, updated_at, ${COLUMNS.join(', ')}) VALUES ${part.map(() => `(?, ?, ?, ${COLUMNS.map(() => '?').join(', ')})`).join(', ')}
       ON CONFLICT (user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, ${COLUMNS.map((c) => `${c} = excluded.${c}`).join(', ')}`,
      args);
  }
}

/**
 * Rates one closed contest in all three disciplines and stores the result: one profile write per participant, one
 * rating_contests row per discipline, and the resume marker. Returns null when the contest was already rated (safe to repeat).
 */
export async function rateChallenge(db: Db, c: ChallengeRow, options: RateOptions): Promise<ContestReport | null> {
  if (c.closes_at === null) throw new Error('Only closed challenges are rated');
  const closesAt = c.closes_at;
  const cands = await db.query<Cand & { model: string | null }>(
    `SELECT e.id, e.user_id, e.net_worth, e.par_tick, e.tokens, e.created_at, e.log_hash, e.actions_count, e.author_kind, e.model, u.github_created_at
     FROM entries e JOIN users u ON u.id = e.user_id WHERE e.challenge_id = ?`, [c.id]);
  const sourceKeys = new Map<string, string>();
  for (const r of await db.query<{ id: string; source: string }>(
    "SELECT id, source FROM entries WHERE challenge_id = ? AND source IS NOT NULL AND author_kind = 'human' AND par_tick IS NOT NULL", [c.id])) {
    sourceKeys.set(r.id, sha(normalizeSource(r.source)));
  }
  const banned = await excludedUsers(db);
  const built = Object.fromEntries(DISCIPLINES.map((d) => [d, buildStandings(d, cands, closesAt, sourceKeys, options.dupSource?.[d], banned)])) as Record<Discipline, Built>;

  return db.transaction(async (tx) => {
    if ((await tx.query('SELECT 1 FROM rating_contests WHERE challenge_id = ? LIMIT 1', [c.id])).length > 0) return null;
    const ids = [...new Set(DISCIPLINES.flatMap((d) => built[d].standings.map((s) => s.id)))].sort();
    const profiles = await loadProfiles(tx, ids);
    const touched = new Set<string>();
    const rated = { overall: false, speed: false, brevity: false } as Record<Discipline, boolean>;
    const summaries = {} as Record<Discipline, Record<string, unknown>>;
    const fieldSizes = {} as Record<Discipline, number>;
    const humanField = {} as Parameters<typeof rateGhosts>[1]['humans'];

    for (const d of DISCIPLINES) {
      const b = built[d];
      const inputs: Standing[] = b.standings.map((s) => {
        const x = profiles.get(s.id)?.d[d];
        return { id: s.id, place: s.place, rating: x?.r ?? START_RATING, events: x?.n ?? 0 };
      });
      fieldSizes[d] = engineFieldSize(inputs);
      const changes = inputs.length === 0 ? [] : rateContest({ standings: inputs, weight: weightOf(c), algoVersion: ALGO_VERSION });
      rated[d] = changes.length > 0;
      humanField[d] = { rated: rated[d], standings: b.standings.map((s, i) => ({ standing: inputs[i]!, entryId: s.entryId })) };
      const entryOf = new Map(b.standings.map((s) => [s.id, s]));
      for (const ch of changes) {
        const s = entryOf.get(ch.id)!;
        const prof = profiles.get(ch.id) ?? { v: 1 as const, d: {} };
        const x = prof.d[d] ?? { r: START_RATING, n: 0, pk: START_RATING, h: [] };
        const before = x.r;
        x.h.push({ c: c.id, k: c.kind === 'season' ? 's' : 'd', at: closesAt, p: s.place, f: b.standings.length, pf: ch.performance, d: ch.delta, b: before, r: ch.rating, e: s.entryId });
        if (x.h.length > HISTORY_CAP) x.h.splice(0, x.h.length - HISTORY_CAP);
        x.r = ch.rating; x.n++; x.pk = Math.max(x.pk, ch.rating);
        prof.d[d] = x;
        profiles.set(ch.id, prof);
        touched.add(ch.id);
      }
      summaries[d] = {
        rated: rated[d], entrants: b.entrants, standings: b.standings.length, field: fieldSizes[d], excluded: b.excluded,
        changed: changes.length, dupSource: b.dupSource,
      };
    }

    const writeIds = [...touched].sort();
    await writeProfiles(tx, writeIds.map((id) => [id, profiles.get(id)!] as [string, ProfileData]), options.ratedAt);
    const bookkeeping = DISCIPLINES.length + 1;
    const report: ContestReport = {
      challengeId: c.id, rated, modelWrites: 0, participants: writeIds.length, profileWrites: writeIds.length, bookkeepingWrites: bookkeeping, writes: writeIds.length + bookkeeping,
    };
    summaries.overall!.writes = report.writes;
    // R7 ghost step: after the human field is rated and its rows are written; reads the humans' starting ratings, writes only model rows.
    report.modelWrites = await rateGhosts(tx, {
      challenge: { id: c.id, kind: c.kind, closesAt }, weight: weightOf(c), cands: banned.size ? cands.filter((x) => !banned.has(x.user_id)) : cands, humans: humanField, order: ORDER, tieKey: TIE_KEY,
      gate: (d, e) => e.par_tick !== null && (d !== 'brevity' || e.tokens !== null),
    });
    await tx.execute(
      `INSERT INTO rating_contests (challenge_id, discipline, algo_version, field_size, rated_at, summary) VALUES ${DISCIPLINES.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`,
      DISCIPLINES.flatMap((d) => [c.id, d, ALGO_VERSION, fieldSizes[d], options.ratedAt, JSON.stringify(summaries[d])]));
    await tx.execute(
      "INSERT INTO arena_meta (key, value) VALUES ('rating_through', ?1) ON CONFLICT(key) DO UPDATE SET value = MAX(CAST(value AS INTEGER), CAST(?1 AS INTEGER))", [String(closesAt)]);
    return report;
  });
}

// ---- finding work, the lock, the lazy run ----

/** Optional launch gate: contests closing at or before this date (YYYY-MM-DD, UTC) are never rated. */
const ratingFrom = (env: Env): number => {
  const ms = env.TENDRIL_RATING_FROM ? Date.parse(env.TENDRIL_RATING_FROM) : NaN;
  return Number.isFinite(ms) ? ms : 0;
};

/** Unrated closed dailies and seasons that have entries, in closing order (a daily before a season that closes with it). */
async function findPending(db: Db, now: number, env: Env, limit: number): Promise<ChallengeRow[]> {
  const through = Number((await getMeta(db, 'rating_through')) ?? 0);
  const lowest = Math.max(through, ratingFrom(env) + 1);
  return db.query<ChallengeRow>(
    `SELECT c.* FROM challenges c
     WHERE c.kind IN ('daily', 'season') AND c.closes_at IS NOT NULL AND c.closes_at <= ?1 AND c.closes_at >= ?2 AND c.opens_at >= ?3
       AND NOT EXISTS (SELECT 1 FROM rating_contests r WHERE r.challenge_id = c.id)
       AND EXISTS (SELECT 1 FROM entries e WHERE e.challenge_id = c.id)
     ORDER BY c.closes_at ASC, CASE c.kind WHEN 'daily' THEN 0 ELSE 1 END, c.id ASC LIMIT ?4`,
    [now, lowest, Math.max(0, lowest - 8 * DAY_MS), limit]);
}

async function claimLock(db: Db, now: number): Promise<string | null> {
  const token = `${now}:${randomUUID()}`;
  const r = await db.execute(
    'INSERT INTO arena_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2 WHERE CAST(value AS INTEGER) < ?3',
    [LOCK_KEY, token, now - LOCK_TTL_MS]);
  return r.rowsAffected > 0 ? token : null;
}
const releaseLock = (db: Db, token: string): Promise<unknown> => db.execute('DELETE FROM arena_meta WHERE key = ? AND value = ?', [LOCK_KEY, token]);

export type RunReason = 'none' | 'locked' | 'paused' | 'off' | 'stale-algo';
export interface RateRun { ran: boolean; reason?: RunReason; contests: ContestReport[]; /** Lock claim, release and the resume marker are counted in each contest. */ lockWrites: number }

export interface RateDueOptions {
  /** False pauses rating (budget guard); the backlog is rated later. */
  canWrite?: () => Promise<boolean>;
  max?: number;
}

/**
 * On the first request after a close: take the lock and rate every unrated, settled daily and season in closing order.
 * Stops at the first contest that is not settled yet (a daily takes legacy-alias submissions for a day), so a later
 * contest is never rated ahead of an earlier one. A second caller finds the lock taken and does nothing.
 */
export async function rateDue(db: Db, env: Env, now: number, options: RateDueOptions = {}): Promise<RateRun> {
  const none = (reason: RunReason): RateRun => ({ ran: false, reason, contests: [], lockWrites: 0 });
  if (env.TENDRIL_RATING === 'off') return none('off');
  const max = options.max ?? MAX_CONTESTS_PER_RUN;
  // R9: every refusal below happens BEFORE the lock is claimed. Claiming writes twice (claim and release), and rating routes call this on
  // every request, so a contest waiting out its alias grace day, or an engine mismatch, would otherwise cost two writes per page view.
  const [next] = await findPending(db, now, env, 1);
  if (!next || !isSettled(next, now)) return none('none');
  if ((await db.query('SELECT 1 FROM rating_contests WHERE algo_version <> ? LIMIT 1', [ALGO_VERSION])).length > 0) return none('stale-algo');
  if (options.canWrite && !(await options.canWrite())) return none('paused');
  const token = await claimLock(db, now);
  if (!token) return none('locked');
  const contests: ContestReport[] = [];
  try {
    for (const c of await findPending(db, now, env, max)) {
      if (!isSettled(c, now)) break;
      const report = await rateChallenge(db, c, { ratedAt: now });
      if (report) contests.push(report);
    }
  } finally { await releaseLock(db, token); }
  return { ran: contests.length > 0, reason: contests.length ? undefined : 'none', contests, lockWrites: 2 };
}

/**
 * Rebuilds every rating from the stored standings (entries) under algorithm version `algoVersion`, which must be the one the
 * engine implements: a new version is new engine code. `rated_at` stamps and the duplicate-source verdicts are kept from the
 * old rows (the program text is pruned after a few days), so rebuilding unchanged code reproduces every stored byte.
 */
export async function recomputeRatings(db: Db, env: Env, now: number, algoVersion: number = ALGO_VERSION): Promise<{ contests: number; writes: number }> {
  if (algoVersion !== ALGO_VERSION) throw new Error(`This build rates with algorithm version ${ALGO_VERSION}, not ${algoVersion}. Ship the engine change first.`);
  const token = await claimLock(db, now);
  if (!token) throw new Error('The rating lock is held; try again in a few minutes');
  try {
    // Keep what cannot be derived again; if a previous rebuild crashed midway the saved copy is still the original.
    let saved = await getMeta(db, 'rating_recompute');
    if (saved === null) {
      const old: Record<string, { at: number; dup: Partial<Record<Discipline, string[]>> }> = {};
      for (const r of await db.query<{ challenge_id: string; discipline: Discipline; rated_at: number; summary: string }>('SELECT challenge_id, discipline, rated_at, summary FROM rating_contests')) {
        const o = (old[r.challenge_id] ??= { at: r.rated_at, dup: {} });
        o.dup[r.discipline] = (JSON.parse(r.summary) as { dupSource?: string[] }).dupSource ?? [];
      }
      saved = JSON.stringify(old);
      await setMeta(db, 'rating_recompute', saved);
    }
    const keep = JSON.parse(saved) as Record<string, { at: number; dup: Partial<Record<Discipline, string[]>> }>;
    await db.transaction(async (tx) => {
      await tx.execute('DELETE FROM rating_profiles');
      await tx.execute('DELETE FROM rating_contests');
      await tx.execute('DELETE FROM arena_meta WHERE substr(key, 1, ?) = ?', [MODEL_KEY_PREFIX.length, MODEL_KEY_PREFIX]);
      await tx.execute("DELETE FROM arena_meta WHERE key = 'rating_through'");
    });
    let contests = 0, writes = 0;
    for (;;) {
      const batch = await findPending(db, now, env, 50);
      let progressed = false;
      for (const c of batch) {
        if (!isSettled(c, now)) { batch.length = 0; break; }
        const k = keep[c.id];
        const report = await rateChallenge(db, c, { ratedAt: k?.at ?? now, dupSource: k?.dup });
        if (report) { contests++; writes += report.writes; progressed = true; }
      }
      if (!progressed) break;
    }
    await db.execute("DELETE FROM arena_meta WHERE key = 'rating_recompute'");
    return { contests, writes };
  } finally { await releaseLock(db, token); }
}

export interface Rater { tick(force: boolean): Promise<void> }

/** Per-app wrapper: dedupes concurrent runs inside one instance, throttles background checks, never fails a request. */
export function createRater(db: Db, env: Env, now: () => number, canWrite: () => Promise<boolean>): Rater {
  let inflight: Promise<unknown> | undefined;
  let lastCheck = Number.NEGATIVE_INFINITY, failedAt = Number.NEGATIVE_INFINITY;
  return {
    async tick(force) {
      const t = now();
      if (!force && t >= lastCheck && t - lastCheck < CHECK_EVERY_MS) return;
      // R9: a run that failed is not retried on every rating-route request (each retry rereads the whole contest): once a minute at most.
      if (t >= failedAt && t - failedAt < CHECK_EVERY_MS) return;
      lastCheck = t;
      inflight ??= rateDue(db, env, t, { canWrite })
        .catch(() => { failedAt = t; console.error('Rating run failed'); })
        .finally(() => { inflight = undefined; });
      await inflight;
    },
  };
}

// ---- reading ----

export type TierView = TierInfo;
export interface HistoryView { challengeId: string; kind: 'daily' | 'season'; closesAt: number; place: number; field: number; performance: number; delta: number; before: number; rating: number; entryId: string }
export interface DisciplineView {
  rating: number; tier: TierView; provisional: boolean; events: number; peak: number;
  /** Ladder position among established players active in the last 30 days; null in placement or when inactive. */
  rank: number | null; percentile: number | null; history: HistoryView[];
}
export type RatingSummary = Record<Discipline, DisciplineView | null>;

const historyView = (h: HistoryRow): HistoryView => ({
  challengeId: h.c, kind: h.k === 's' ? 'season' : 'daily', closesAt: h.at, place: h.p, field: h.f, performance: h.pf, delta: h.d, before: h.b, rating: h.r, entryId: h.e,
});
const tierView = (rating: number): TierView => tierOf(rating);
const activeSince = (now: number): number => now - ACTIVE_WINDOW_MS;

/** `rating` block of GET /players/:login. A discipline the player has no rated run in is null. */
export async function ratingSummary(db: Db, userId: string, now: number): Promise<RatingSummary> {
  const out: RatingSummary = { overall: null, speed: null, brevity: null };
  const [row] = await db.query<{ data: string }>('SELECT data FROM rating_profiles WHERE user_id = ?', [userId]);
  if (!row) return out;
  const data = JSON.parse(row.data) as ProfileData;
  for (const d of DISCIPLINES) {
    const x = data.d[d];
    if (!x) continue;
    const last = x.h[x.h.length - 1]!.at;
    let rank: number | null = null, percentile: number | null = null;
    if (x.n >= PLACEMENT_EVENTS && last >= activeSince(now)) {
      const [r] = await db.query<{ above: number; total: number }>(
        `SELECT (SELECT COUNT(*) FROM rating_profiles WHERE n_${d} >= ?1 AND l_${d} >= ?2 AND (r_${d} > ?3 OR (r_${d} = ?3 AND user_id < ?4))) AS above,
                (SELECT COUNT(*) FROM rating_profiles WHERE n_${d} >= ?1 AND l_${d} >= ?2) AS total`,
        [PLACEMENT_EVENTS, activeSince(now), x.r, userId]);
      rank = r!.above + 1; percentile = percentileOf(rank, r!.total);
    }
    out[d] = { rating: x.r, tier: tierView(x.r), provisional: x.n < PLACEMENT_EVENTS, events: x.n, peak: x.pk, rank, percentile, history: x.h.map(historyView) };
  }
  return out;
}

export interface LadderRow { rank: number; login: string; displayName: string; avatarUrl: string | null; rating: number; tier: TierView; events: number; lastRatedAt: number }

export function disciplineParam(value: string | null): Discipline {
  const d = value ?? 'overall';
  if (d !== 'overall' && d !== 'speed' && d !== 'brevity') throw new HttpError(400, 'Invalid discipline');
  return d;
}

const encodeCursor = (c: { r: number; u: string; n: number }): string => Buffer.from(JSON.stringify(c)).toString('base64url');
function decodeCursor(raw: string): { r: number; u: string; n: number } {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { r?: unknown; u?: unknown; n?: unknown };
    if (Number.isInteger(c.r) && typeof c.u === 'string' && c.u.length > 0 && c.u.length <= 64 && Number.isInteger(c.n) && (c.n as number) >= 1) return c as { r: number; u: string; n: number };
  } catch { /* fall through */ }
  throw new HttpError(400, 'Invalid cursor');
}

/**
 * GET /ratings/board: established players active in the last 30 days, best rating first (ties by user id), keyset-paged.
 * `nextCursor` carries the next rank, so no count is needed per page.
 */
export async function ratingBoard(db: Db, discipline: Discipline, limit: number, cursor: string | null, now: number): Promise<{ discipline: Discipline; entries: LadderRow[]; nextCursor: string | null }> {
  const after = cursor ? decodeCursor(cursor) : null;
  const d = discipline;
  const rows = await db.query<{ user_id: string; rating: number; events: number; last: number; login: string; display_name: string; avatar_url: string | null }>(
    `SELECT p.user_id, p.r_${d} AS rating, p.n_${d} AS events, p.l_${d} AS last, u.login, u.display_name, u.avatar_url
     FROM rating_profiles p JOIN users u ON u.id = p.user_id
     WHERE p.n_${d} >= ?1 AND p.l_${d} >= ?2 AND (?3 IS NULL OR p.r_${d} < ?3 OR (p.r_${d} = ?3 AND p.user_id > ?4))
     ORDER BY p.r_${d} DESC, p.user_id ASC LIMIT ?5`,
    [PLACEMENT_EVENTS, activeSince(now), after ? after.r : null, after ? after.u : '', limit + 1]);
  const start = after ? after.n : 1;
  const page = rows.slice(0, limit);
  const entries = page.map((r, i): LadderRow => ({
    rank: start + i, login: r.login, displayName: r.display_name, avatarUrl: r.avatar_url, rating: r.rating, tier: tierView(r.rating), events: r.events, lastRatedAt: r.last,
  }));
  const next = rows.length > limit ? page[page.length - 1]! : null;
  return { discipline, entries, nextCursor: next ? encodeCursor({ r: next.rating, u: next.user_id, n: start + page.length }) : null };
}

/** GET /ratings/models: ghost ratings per declared model (see model-ratings.ts). */
export const ratingModels = (db: Db, now: number) => readModels(db, now);

export interface LatestChange {
  challengeId: string; kind: 'daily' | 'season'; closesAt: number;
  overall: ChangeView | null; speed: ChangeView | null; brevity: ChangeView | null;
}
export interface ChangeView { place: number; field: number; delta: number; before: number; rating: number; tier: TierView; previousTier: TierView; promoted: boolean; provisional: boolean; events: number; entryId: string }

/**
 * GET /ratings/me/latest: the newest rated contest for the player (all disciplines), for the morning card. `seen` is the
 * challenge id the client already showed; the answer is `latest: null` when it is still the newest. Nothing is written.
 */
export async function latestChange(db: Db, userId: string, seen: string | null): Promise<{ latest: LatestChange | null }> {
  const [row] = await db.query<{ data: string }>('SELECT data FROM rating_profiles WHERE user_id = ?', [userId]);
  if (!row) return { latest: null };
  const data = JSON.parse(row.data) as ProfileData;
  let newest: HistoryRow | undefined;
  for (const d of DISCIPLINES) {
    const h = data.d[d]?.h;
    const last = h?.[h.length - 1];
    if (last && (!newest || last.at > newest.at || (last.at === newest.at && last.k === 's' && newest.k === 'd'))) newest = last;
  }
  if (!newest || newest.c === seen) return { latest: null };
  const view = (d: Discipline): ChangeView | null => {
    const x = data.d[d];
    const idx = x ? x.h.findIndex((h) => h.c === newest.c) : -1;
    if (!x || idx < 0) return null;
    const h = x.h[idx]!;
    const before = tierView(h.b), after = tierView(h.r);
    return { place: h.p, field: h.f, delta: h.d, before: h.b, rating: h.r, tier: after, previousTier: before, promoted: after.floor > before.floor, provisional: idx + 1 < PLACEMENT_EVENTS, events: idx + 1, entryId: h.e };
  };
  return { latest: { challengeId: newest.c, kind: newest.k === 's' ? 'season' : 'daily', closesAt: newest.at, overall: view('overall'), speed: view('speed'), brevity: view('brevity') } };
}

export type RatedBoardRow = BoardRow & { rating: number | null; tier: { key: string; name: string } | null; delta: number | null };

/** Closed daily/season boards: each row gains the rating it ended on, its tier and the change that contest gave (null when unrated). */
export async function decorateBoard(db: Db, c: ChallengeRow, result: BoardResult, now: number): Promise<BoardResult | (Omit<BoardResult, 'entries' | 'me'> & { entries: RatedBoardRow[]; me: (RatedBoardRow & { percentile: number }) | null })> {
  if (c.kind === 'duel' || !isClosed(c, now)) return result;
  const rows = result.me ? [...result.entries, result.me] : result.entries;
  const ids = [...new Set(rows.map((r) => r.userId))];
  const d = DISCIPLINE_OF_MEDAL[result.medal];
  const found = new Map<string, HistoryRow>();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const part = ids.slice(i, i + IN_CHUNK);
    const got = await db.query<{ user_id: string; h: string }>(
      `SELECT p.user_id, j.value AS h FROM rating_profiles p, json_each(p.data, '$.d.${d}.h') j
       WHERE p.user_id IN (${part.map(() => '?').join(',')}) AND json_extract(j.value, '$.c') = ?`, [...part, c.id]);
    for (const g of got) found.set(g.user_id, JSON.parse(g.h) as HistoryRow);
  }
  const add = <T extends BoardRow>(r: T): T & { rating: number | null; tier: { key: string; name: string } | null; delta: number | null } => {
    const h = found.get(r.userId);
    const t = h ? tierView(h.r) : null;
    return { ...r, rating: h?.r ?? null, tier: t ? { key: t.key, name: t.name } : null, delta: h?.d ?? null };
  };
  return { ...result, entries: result.entries.map(add), me: result.me ? add(result.me) : null };
}
