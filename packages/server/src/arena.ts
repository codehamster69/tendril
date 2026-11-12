import { createHash, randomBytes } from 'node:crypto';
import { challengeSetup, createWorld, dailyNumber, dailySeed, DAILY_PAR, DAILY_TICKS, IllegalAction, parFromReference, replayWithPar, RULES_VERSION, SEASON_TICKS, SETUP_LEGACY, SETUP_VERSION } from '@tendril/sim/src/index.ts';
import type { ChallengeKind, LogEntry } from '@tendril/sim/src/index.ts';
import type { Db, Queryable } from './db.ts';
import { DAY_MS, isValidDate, utcDate } from './game.ts';
import { HttpError } from './validation.ts';
import type { EntryInput } from './validation.ts';
import type { SourceVerifier } from './verify-client.ts';
import { REFERENCE_SOURCE } from './reference.ts';

// ---- limits ----

/** Per-kind size caps. A tick count never comes from a client except for duels, which are capped here. */
export const KIND_LIMITS: Record<ChallengeKind, { maxActions: number; maxTicks: number }> = {
  daily: { maxActions: 20000, maxTicks: DAILY_TICKS },
  season: { maxActions: 20000, maxTicks: SEASON_TICKS },
  duel: { maxActions: 20000, maxTicks: 6000 },
};
/** Vercel rejects request bodies over 4.5 MB before our code runs; tests prove the largest legal log fits under it. */
export const VERCEL_BODY_LIMIT = 4.5 * 1000 * 1000;
export const MAX_SOURCE_BYTES = 32 * 1024;
/**
 * Desktop 0.1.x only knows /api/daily/submit, which also accepted "yesterday". The alias keeps that grace so
 * those clients near midnight do not break. Set to 0 once 0.1.x is gone: a late entry is the one way to see a
 * sealed replay before submitting (the brief's D2 attack review should look at this).
 */
export const LEGACY_GRACE_MS = DAY_MS;
export const BOARD_BUCKETS = 10;

// ---- ids and calendar ----

const CHALLENGE_ID = /^(?:d-\d{4}-\d{2}-\d{2}|s-\d{4}-W\d{2}|x-[A-Za-z0-9_-]{8})$/;
/** Monday 2026-11-30 00:00 UTC: the start of the ISO week that holds the daily epoch (2026-12-01). */
const SEASON_EPOCH_MONDAY = Date.UTC(2026, 10, 30);
const WEEK_MS = 7 * DAY_MS;
const pad2 = (n: number): string => String(n).padStart(2, '0');

export const dailyId = (date: string): string => `d-${date}`;
const dayStart = (ms: number): number => ms - (((ms % DAY_MS) + DAY_MS) % DAY_MS);
const mondayOf = (ms: number): number => dayStart(ms) - ((new Date(ms).getUTCDay() + 6) % 7) * DAY_MS;

/** s-YYYY-Www with the ISO week-year and week number of the week containing `ms`. */
export function seasonId(ms: number): string {
  const thursday = new Date(mondayOf(ms) + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / WEEK_MS) + 1;
  return `s-${year}-W${pad2(week)}`;
}

/** FNV-1a 32-bit over UTF-8 of "tendril-season:" + id; 0 -> 1. Same construction as the sim's dailySeed. */
export function seasonSeed(id: string): number {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(`tendril-season:${id}`)) { h ^= byte; h = Math.imul(h, 0x01000193); }
  return (h >>> 0) || 1;
}

export type Medal = 'wealth' | 'speed' | 'brevity';
export type AuthorKind = 'human' | 'model';

export interface ChallengeRow {
  id: string; kind: ChallengeKind; number: number | null; seed: number; ticks: number; par: number | null;
  opens_at: number; closes_at: number | null; created_by: string | null; rules_version: number;
  /** How the starting conditions derive from the seed: 0 plain farm (old challenges), 1 seed-drawn modifiers. */ setup_v: number;
  /** Players with an entry for each medal, kept by submitEntry so a board total never needs a scan. */
  n_wealth?: number; n_speed?: number; n_brevity?: number;
}
export interface ChallengeInfo {
  id: string; kind: ChallengeKind; number: number | null; seed: number; ticks: number; par: number | null;
  opensAt: number; closesAt: number | null; rulesVersion: number; setupVersion: number; players: number; best: number | null;
}

export const isOpen = (c: ChallengeRow, now: number): boolean => now >= c.opens_at && (c.closes_at === null || now < c.closes_at);
export const isClosed = (c: ChallengeRow, now: number): boolean => c.closes_at !== null && now >= c.closes_at;

function newDailyRow(date: string, setupV: number): ChallengeRow {
  const seed = dailySeed(date);
  const start = Date.parse(`${date}T00:00:00Z`);
  return { id: dailyId(date), kind: 'daily', number: dailyNumber(date), seed, ticks: challengeSetup('daily', seed, setupV).ticks, par: DAILY_PAR, opens_at: start, closes_at: start + DAY_MS, created_by: null, rules_version: RULES_VERSION, setup_v: setupV };
}
function newSeasonRow(ms: number, setupV: number): ChallengeRow {
  const id = seasonId(ms);
  const seed = seasonSeed(id);
  const start = mondayOf(ms);
  return { id, kind: 'season', number: 1 + Math.round((start - SEASON_EPOCH_MONDAY) / WEEK_MS), seed, ticks: challengeSetup('season', seed, setupV).ticks, par: DAILY_PAR, opens_at: start, closes_at: start + WEEK_MS, created_by: null, rules_version: RULES_VERSION, setup_v: setupV };
}

/** Rows that may be created on first request: today's and yesterday's daily, this and last week's season. */
function creatable(id: string, now: number, setupV: number): ChallengeRow | null {
  if (id.startsWith('d-')) {
    const date = id.slice(2);
    return isValidDate(date) && (date === utcDate(now) || date === utcDate(now - DAY_MS)) ? newDailyRow(date, setupV) : null;
  }
  if (id.startsWith('s-')) {
    for (const ms of [now, now - WEEK_MS]) if (seasonId(ms) === id) return newSeasonRow(ms, setupV);
  }
  return null;
}

async function insertChallenge(q: Queryable, c: ChallengeRow): Promise<void> {
  await q.execute(
    'INSERT OR IGNORE INTO challenges (id, kind, number, seed, ticks, par, opens_at, closes_at, created_by, rules_version, setup_v) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [c.id, c.kind, c.number, c.seed, c.ticks, c.par, c.opens_at, c.closes_at, c.created_by, c.rules_version, c.setup_v],
  );
}

export function resolveChallengeId(ref: string, now: number): string {
  if (ref === 'today') return dailyId(utcDate(now));
  if (ref === 'week') return seasonId(now);
  if (!CHALLENGE_ID.test(ref)) throw new HttpError(400, 'Invalid challenge id');
  return ref;
}

/** Loads a challenge, creating today's daily or this week's season on first request. 404 for anything else unknown. */
export async function loadChallenge(db: Db, ref: string, now: number, verify?: SourceVerifier, setupV: number = SETUP_VERSION): Promise<ChallengeRow> {
  const id = resolveChallengeId(ref, now);
  const [found] = await db.query<ChallengeRow>('SELECT * FROM challenges WHERE id = ?', [id]);
  if (found) return found;
  const fresh = creatable(id, now, setupV);
  if (!fresh) throw new HttpError(404, 'Challenge not found');
  fresh.par = await referencePar(fresh, verify) ?? fresh.par;
  await insertChallenge(db, fresh);
  const [row] = await db.query<ChallengeRow>('SELECT * FROM challenges WHERE id = ?', [id]);
  return row!;
}

export async function challengeInfo(db: Db, c: ChallengeRow): Promise<ChallengeInfo> {
  // players comes from the stored counter; MAX(net_worth) reads one index entry.
  const [stats] = await db.query<{ players: number; best: number | null }>(
    'SELECT (SELECT n_wealth FROM challenges WHERE id = ?1) AS players, (SELECT MAX(net_worth) FROM entries WHERE challenge_id = ?1) AS best', [c.id]);
  return {
    id: c.id, kind: c.kind, number: c.number, seed: c.seed, ticks: c.ticks, par: c.par, opensAt: c.opens_at,
    closesAt: c.closes_at, rulesVersion: c.rules_version, setupVersion: c.setup_v, players: stats!.players ?? 0, best: stats!.best,
  };
}

/**
 * Par for a new challenge: 90% of what the bundled reference program earns on this exact world, measured by the
 * separate verify function (the main function never runs programs). Null when the check cannot be made, and the
 * caller keeps its constant fallback, so a verify outage never blocks a challenge from opening.
 */
export async function referencePar(c: ChallengeRow, verify: SourceVerifier | undefined): Promise<number | null> {
  if (!verify || c.setup_v < 1) return null; // version 0 challenges keep the constant par
  try {
    const v = await verify({ source: REFERENCE_SOURCE, challengeId: c.id, kind: c.kind, seed: c.seed, ticks: c.ticks, rulesVersion: c.rules_version, setupVersion: c.setup_v });
    return v.ok && typeof v.netWorth === 'number' && Number.isSafeInteger(v.netWorth) ? parFromReference(v.netWorth) : null;
  } catch { return null; }
}

// ---- duels ----

export interface DuelInput { seed: number | null; ticks: number | null }

export async function createDuel(db: Db, userId: string, input: DuelInput, now: number, verify?: SourceVerifier, setupV: number = SETUP_VERSION): Promise<{ challengeId: string }> {
  const seed = input.seed ?? ((randomBytes(4).readUInt32LE() >>> 0) || 1);
  const { ticks: defaultTicks } = challengeSetup('duel', seed, setupV);
  const ticks = input.ticks ?? defaultTicks;
  // Only the standard length has a calibrated par, so other lengths have no Speed medal.
  const row: ChallengeRow = { id: `x-${randomBytes(6).toString('base64url')}`, kind: 'duel', number: null, seed, ticks, par: ticks === DAILY_TICKS ? DAILY_PAR : null, opens_at: now, closes_at: null, created_by: userId, rules_version: RULES_VERSION, setup_v: setupV };
  row.par = await referencePar(row, verify) ?? row.par;
  await insertChallenge(db, row);
  return { challengeId: row.id };
}

// ---- submitting ----

interface EntryRow {
  id: string; challenge_id: string; user_id: string; net_worth: number; par_tick: number | null; tokens: number | null;
  actions: string | null; actions_count: number; log_hash: string; mosaic: string | null; source_public: number; source_verified: number;
  author_kind: AuthorKind; model: string | null; created_at: number;
}
export interface Ranks { wealth: number | null; speed: number | null; brevity: number | null }
export interface SubmitResult {
  entryId: string; netWorth: number; parTick: number | null; tokens: number | null; mosaic: string;
  ranks: Ranks; percentile: number | null; improved: boolean; total: number;
}

interface Replayed { netWorth: number; parTick: number | null; mosaic: string }

/** Replays the log from the challenge's start. Throws 422 for an illegal log, never leaves partial state. */
function replayLog(c: ChallengeRow, actions: LogEntry[]): Replayed {
  const { setup } = challengeSetup(c.kind, c.seed, c.setup_v);
  const world = createWorld({ id: c.id, seed: c.seed }, setup);
  try {
    const result = replayWithPar(world, actions, c.ticks, c.par ?? Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(world.coins) || !Number.isSafeInteger(result.netWorth) || !Number.isSafeInteger(world.tick)) throw new HttpError(422, 'Simulation overflow');
    return result;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof IllegalAction) throw new HttpError(422, `Invalid action log: ${error.message}`);
    if (error instanceof Error && error.message === 'overflow') throw new HttpError(422, 'Invalid action log');
    throw error;
  }
}

export const logHash = (actions: LogEntry[]): string => createHash('sha256').update(JSON.stringify(actions)).digest('hex');
const newEntryId = (): string => randomBytes(9).toString('base64url');

// Ordering for each medal, best first. `value` is the board value; later keys break ties deterministically.
/** The sort-key columns of an entry; `atOrAhead` is the index range "this entry or anything ranked before it". */
export interface EntryKeys { net_worth: number; par_tick: number | null; tokens: number | null }
const MEDALS: Record<Medal, { where: string; value: string; keys: (a: string) => string; atOrAhead: (a: string, k: EntryKeys) => { sql: string; args: number[] } }> = {
  wealth: { where: '1 = 1', value: 'net_worth', keys: (a) => `${a}.net_worth DESC`,
    atOrAhead: (a, k) => ({ sql: `${a}.net_worth >= ?`, args: [k.net_worth] }) },
  speed: { where: 'e.par_tick IS NOT NULL', value: 'par_tick', keys: (a) => `${a}.par_tick ASC, ${a}.net_worth DESC`,
    atOrAhead: (a, k) => ({ sql: `(${a}.par_tick < ? OR (${a}.par_tick = ? AND ${a}.net_worth >= ?))`, args: [k.par_tick!, k.par_tick!, k.net_worth] }) },
  // Brevity is "fewest tokens among programs that reach par": without that gate an empty program would win it.
  brevity: { where: 'e.tokens IS NOT NULL AND e.par_tick IS NOT NULL', value: 'tokens', keys: (a) => `${a}.tokens ASC, ${a}.net_worth DESC`,
    atOrAhead: (a, k) => ({ sql: `(${a}.tokens < ? OR (${a}.tokens = ? AND ${a}.net_worth >= ?))`, args: [k.tokens!, k.tokens!, k.net_worth] }) },
};
/** One player's entries, best first: the medal's keys, then earlier wins. */
const playerOrder = (medal: Medal, a: string): string => `${MEDALS[medal].keys(a)}, ${a}.created_at ASC, ${a}.id ASC`;
const MEDAL_NAMES = Object.keys(MEDALS) as Medal[];

/**
 * `upTo` limits the ranking to entries at or ahead of that key. Every row ranked before an included row is itself included
 * (the bound is a prefix of the sort order, ties kept), so ranks inside the range are exact, and the work is proportional to the
 * rank asked about instead of the size of the board.
 */
interface Filters { viewerId?: string; friends?: boolean; author?: AuthorKind; upTo?: EntryKeys }

/**
 * CTE giving one row per player (their best entry for the medal) with a global rank. Only constants are
 * interpolated; every request value is a bound parameter, in the order the placeholders appear.
 */
function rankedCte(medal: Medal, challengeId: string, filters: Filters = {}): { sql: string; args: (string | number)[] } {
  const m = MEDALS[medal];
  const args: (string | number)[] = [challengeId];
  let extra = '';
  if (filters.upTo) {
    const bound = m.atOrAhead('e', filters.upTo);
    extra += ` AND ${bound.sql}`;
    args.push(...bound.args);
  }
  if (filters.friends) {
    extra += ' AND (e.user_id = ? OR e.user_id IN (SELECT followee_id FROM follows WHERE follower_id = ?))';
    args.push(filters.viewerId!, filters.viewerId!);
  }
  if (filters.author) { extra += ' AND e.author_kind = ?'; args.push(filters.author); }
  // Identical non-empty logs (same grp) are the same run: they sit together, ordered by when the log first appeared,
  // and share the rank of the first. Everyone else ranks by the medal's keys, then earlier first.
  const sql = `WITH best AS (
      SELECT e.id, e.user_id, e.net_worth, e.par_tick, e.tokens, e.created_at, e.${m.value} AS value, e.mosaic, e.author_kind, e.model,
        CASE WHEN e.actions_count > 0 THEN e.log_hash ELSE e.id END AS grp,
        ROW_NUMBER() OVER (PARTITION BY e.user_id ORDER BY ${playerOrder(medal, 'e')}) AS pick
      FROM entries e WHERE e.challenge_id = ? AND ${m.where}${extra}
    ), grouped AS (
      SELECT b.*, MIN(b.created_at) OVER (PARTITION BY b.grp) AS gfirst FROM best b WHERE b.pick = 1
    ), numbered AS (
      SELECT g.*, ROW_NUMBER() OVER (ORDER BY ${m.keys('g')}, g.gfirst ASC, g.grp ASC, g.created_at ASC, g.id ASC) AS rn FROM grouped g
    ), ranked AS (
      SELECT n.*, MIN(n.rn) OVER (PARTITION BY n.grp) AS rank FROM numbered n
    )`;
  return { sql, args };
}

/** The entry that stands for this player on a medal: their best one, by the medal's keys then the earlier one. */
async function bestEntry(q: Queryable, medal: Medal, challengeId: string, userId: string): Promise<EntryKeys | undefined> {
  const [row] = await q.query<EntryKeys>(
    `SELECT e.net_worth, e.par_tick, e.tokens FROM entries e WHERE e.challenge_id = ? AND e.user_id = ? AND ${MEDALS[medal].where} ORDER BY ${playerOrder(medal, 'e')} LIMIT 1`,
    [challengeId, userId]);
  return row;
}

async function rankOf(q: Queryable, medal: Medal, challengeId: string, userId: string): Promise<number | null> {
  const mine = await bestEntry(q, medal, challengeId, userId);
  if (!mine) return null;
  const { sql, args } = rankedCte(medal, challengeId, { upTo: mine });
  const [row] = await q.query<{ rank: number | null }>(`${sql} SELECT rank FROM ranked WHERE user_id = ?`, [...args, userId]);
  return row?.rank ?? null;
}

/** "At or above X% of players": 100 for first place, rises with rank, never 0 for a ranked player. */
export const percentileOf = (rank: number, total: number): number => Math.floor((100 * (total - rank + 1)) / total);

/** Which of one player's entries to keep: their best for each medal (wealth, speed, brevity). At most three. */
export function keepIds(rows: Pick<EntryRow, 'id' | 'net_worth' | 'par_tick' | 'tokens' | 'created_at'>[]): Set<string> {
  const keep = new Set<string>();
  for (const medal of MEDAL_NAMES) {
    const eligible = rows.filter((r) => (medal === 'speed' ? r.par_tick !== null : medal === 'brevity' ? r.tokens !== null && r.par_tick !== null : true));
    if (eligible.length === 0) continue;
    const key = (r: typeof rows[number]): number[] => (medal === 'wealth' ? [-r.net_worth] : medal === 'speed' ? [r.par_tick!, -r.net_worth] : [r.tokens!, -r.net_worth]);
    eligible.sort((a, b) => {
      const ka = [...key(a), a.created_at], kb = [...key(b), b.created_at];
      for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! - kb[i]!;
      return a.id < b.id ? -1 : 1;
    });
    keep.add(eligible[0]!.id);
  }
  return keep;
}

async function standing(q: Queryable, challengeId: string, userId: string): Promise<{ ranks: Ranks; percentile: number | null; total: number }> {
  const ranks: Ranks = { wealth: null, speed: null, brevity: null };
  for (const medal of MEDAL_NAMES) ranks[medal] = await rankOf(q, medal, challengeId, userId);
  const [counts] = await q.query<{ n: number }>('SELECT n_wealth AS n FROM challenges WHERE id = ?', [challengeId]);
  const total = counts?.n ?? 0;
  return { ranks, percentile: ranks.wealth === null ? null : percentileOf(ranks.wealth, total), total };
}

export interface SubmitOptions {
  /** Extra time after closing during which submissions are still taken (legacy alias only). */ graceMs?: number;
  /** Answer a repeat of your own log with the existing entry instead of 409 (legacy alias only). */ repeatOk?: boolean;
  /** The source check. Required only when the body carries a program. */ verify?: SourceVerifier;
}

export const SOURCE_UNAVAILABLE = 'The source check is unavailable. Submit without your program or try again later.';
export const SOURCE_MISMATCH = 'Source does not produce this run';

/** Runs the program in the verify function and requires it to produce exactly `hash`. Returns the token count. */
async function checkSource(c: ChallengeRow, source: string, hash: string, verify: SourceVerifier | undefined): Promise<number> {
  if (!verify) throw new HttpError(503, SOURCE_UNAVAILABLE);
  let verdict;
  try { verdict = await verify({ source, challengeId: c.id, kind: c.kind, seed: c.seed, ticks: c.ticks, rulesVersion: c.rules_version, setupVersion: c.setup_v }); }
  catch { throw new HttpError(503, SOURCE_UNAVAILABLE); }
  if (!verdict.ok) {
    if (verdict.reason === 'rules') throw new HttpError(409, 'Rules version mismatch');
    throw new HttpError(422, verdict.reason === 'timeout' ? 'Source took too long to check' : `Source cannot be checked: ${verdict.message}`);
  }
  if (verdict.logHash !== hash) throw new HttpError(422, SOURCE_MISMATCH);
  if (!Number.isSafeInteger(verdict.tokens) || verdict.tokens < 0) throw new HttpError(503, SOURCE_UNAVAILABLE);
  return verdict.tokens;
}

export async function submitEntry(db: Db, userId: string, c: ChallengeRow, input: EntryInput, actions: LogEntry[], now: number, options: SubmitOptions = {}): Promise<SubmitResult> {
  if (input.rulesVersion !== c.rules_version || input.rulesVersion !== RULES_VERSION) throw new HttpError(409, 'Rules version mismatch');
  if (now < c.opens_at || (c.closes_at !== null && now >= c.closes_at + (options.graceMs ?? 0))) throw new HttpError(409, 'Challenge is not open');
  const replayed = replayLog(c, actions);
  const hash = logHash(actions);
  // The program, if sent, is run by the separate verify function and must reproduce this exact log.
  const tokens = input.source !== null ? await checkSource(c, input.source, hash, options.verify) : null;
  const id = newEntryId();
  return db.transaction(async (tx) => {
    let entryId = id;
    let improved = false;
    const mineAlready = await tx.query<{ id: string; source_verified: number }>('SELECT id, source_verified FROM entries WHERE challenge_id = ? AND user_id = ? AND log_hash = ? AND actions_count > 0', [c.id, userId, hash]);
    const attach = mineAlready[0] !== undefined && tokens !== null && mineAlready[0].source_verified === 0;
    if (mineAlready[0] && !attach) {
      // Your own log again. New clients get 409; the old daily route retries blindly, so it gets the existing entry back.
      if (!options.repeatOk) throw new HttpError(409, 'You already submitted this log');
      entryId = mineAlready[0].id;
    } else {
      if (attach) {
        // Same log, now with its program: add the verified source to the existing entry instead of refusing it.
        entryId = mineAlready[0]!.id;
        await tx.execute('UPDATE entries SET tokens = ?, source = ?, source_public = ?, source_verified = 1 WHERE id = ?', [tokens, input.source, input.sourcePublic ? 1 : 0, entryId]);
      } else {
        await tx.execute(
          `INSERT INTO entries (id, challenge_id, user_id, net_worth, par_tick, tokens, actions, actions_count, log_hash, mosaic, source, source_public, source_verified, author_kind, model, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, c.id, userId, replayed.netWorth, replayed.parTick, tokens, JSON.stringify(actions), actions.length, hash, replayed.mosaic, tokens === null ? null : input.source, tokens === null ? 0 : input.sourcePublic ? 1 : 0, tokens === null ? 0 : 1, input.authorKind, input.model, now],
        );
      }
      const mine = await tx.query<EntryRow>('SELECT * FROM entries WHERE challenge_id = ? AND user_id = ?', [c.id, userId]);
      // Players per medal: this player joins a medal's board the first time they hold an entry that qualifies for it.
      const prior = mine.filter((r) => r.id !== id);
      const joined = [prior.length === 0, !prior.some((r) => r.par_tick !== null) && replayed.parTick !== null, false /* brevity: tokens arrive with the source check (C3) */];
      if (joined.some(Boolean)) {
        await tx.execute('UPDATE challenges SET n_wealth = n_wealth + ?, n_speed = n_speed + ?, n_brevity = n_brevity + ? WHERE id = ?', [...joined.map(Number), c.id]);
      }
      const keep = keepIds(mine);
      for (const row of mine) if (!keep.has(row.id)) await tx.execute('DELETE FROM entries WHERE id = ?', [row.id]);
      improved = keep.has(entryId);
      if (!improved) {
        const [top] = await tx.query<{ id: string }>(`SELECT e.id FROM entries e WHERE e.challenge_id = ? AND e.user_id = ? ORDER BY ${playerOrder('wealth', 'e')} LIMIT 1`, [c.id, userId]);
        entryId = top!.id;
      }
    }
    const { ranks, percentile, total } = await standing(tx, c.id, userId);
    return { entryId, netWorth: replayed.netWorth, parTick: replayed.parTick, tokens, mosaic: replayed.mosaic, ranks, percentile, improved, total };
  });
}

// ---- boards ----

export interface BoardRow {
  rank: number; entryId: string; userId: string; login: string; displayName: string; avatarUrl: string | null; value: number;
  mosaic: string | null; authorKind: AuthorKind; model: string | null; createdAt: number;
}
export interface Histogram { min: number; max: number; width: number; counts: number[] }
export interface BoardResult { medal: Medal; entries: BoardRow[]; histogram: Histogram; total: number; me: (BoardRow & { percentile: number }) | null }

interface RankedRow {
  rank: number; id: string; user_id: string; value: number; mosaic: string | null; author_kind: AuthorKind; model: string | null; created_at: number;
  login: string; display_name: string; avatar_url: string | null;
}
const boardRow = (r: RankedRow): BoardRow => ({
  rank: r.rank, entryId: r.id, userId: r.user_id, login: r.login, displayName: r.display_name, avatarUrl: r.avatar_url, value: r.value,
  mosaic: r.mosaic, authorKind: r.author_kind, model: r.model, createdAt: r.created_at,
});
const RANKED_SELECT = 'SELECT r.rank, r.id, r.user_id, r.value, r.mosaic, r.author_kind, r.model, r.created_at, u.login, u.display_name, u.avatar_url FROM ranked r JOIN users u ON u.id = r.user_id';

export interface BoardQuery { medal: Medal; friends: boolean; author?: AuthorKind; limit: number; viewerId?: string; now?: number; /** Tests: the largest board still computed in full. */ fullMax?: number }

/** Boards up to this many players are computed in full on every request (cheap, and exact in every detail). */
export const FULL_BOARD_MAX = 300;
/** On bigger open boards the histogram (a coarse picture of the whole field) is recomputed at most this often. */
export const HISTOGRAM_TTL_MS = 5 * 60_000;

async function histogramOf(db: Db, sql: string, args: (string | number)[]): Promise<{ histogram: Histogram; total: number }> {
  const [agg] = await db.query<{ n: number; lo: number | null; hi: number | null }>(`${sql} SELECT COUNT(*) AS n, MIN(value) AS lo, MAX(value) AS hi FROM ranked`, args);
  const total = agg!.n;
  const lo = agg!.lo ?? 0, hi = agg!.hi ?? 0;
  const width = Math.max(1, Math.ceil((hi - lo + 1) / BOARD_BUCKETS));
  const counts = new Array<number>(BOARD_BUCKETS).fill(0);
  if (total > 0) {
    const grouped = await db.query<{ b: number; n: number }>(`${sql} SELECT CAST((value - ?) / ? AS INTEGER) AS b, COUNT(*) AS n FROM ranked GROUP BY b`, [...args, lo, width]);
    for (const g of grouped) counts[Math.min(BOARD_BUCKETS - 1, g.b)]! += g.n;
  }
  return { histogram: { min: lo, max: hi, width, counts }, total };
}

const COUNT_COLUMN: Record<Medal, string> = { wealth: 'n_wealth', speed: 'n_speed', brevity: 'n_brevity' };

export async function board(db: Db, c: ChallengeRow, q: BoardQuery): Promise<BoardResult> {
  if (!q.friends && !q.author) {
    const [counted] = await db.query<{ n: number }>(`SELECT ${COUNT_COLUMN[q.medal]} AS n FROM challenges WHERE id = ?`, [c.id]);
    if ((counted?.n ?? 0) > (q.fullMax ?? FULL_BOARD_MAX)) return bigBoard(db, c, q, counted!.n);
  }
  const { sql, args } = rankedCte(q.medal, c.id, { friends: q.friends, viewerId: q.viewerId, author: q.author });
  const rows = await db.query<RankedRow>(`${sql} ${RANKED_SELECT} ORDER BY r.rank LIMIT ?`, [...args, q.limit]);
  const { histogram, total } = await histogramOf(db, sql, args);
  let me: BoardResult['me'] = null;
  if (q.viewerId) {
    const [mine] = await db.query<RankedRow>(`${sql} ${RANKED_SELECT} WHERE r.user_id = ?`, [...args, q.viewerId]);
    if (mine) me = { ...boardRow(mine), percentile: percentileOf(mine.rank, total) };
  }
  return { medal: q.medal, entries: rows.map(boardRow), histogram, total, me };
}

/**
 * A big unfiltered board. Reads about 3 x limit entries for the top rows, about the viewer's rank for their own row, one counter
 * for the total, and a stored histogram that is refreshed every HISTOGRAM_TTL_MS (a closed challenge never changes, so it is
 * computed once). The full pass over every entry that small boards use would cost the whole field on every request.
 */
async function bigBoard(db: Db, c: ChallengeRow, q: BoardQuery, total: number): Promise<BoardResult> {
  const m = MEDALS[q.medal];
  // A player holds at most three entries, so the top `limit` players all sit within the first 3 x limit entries in sort order.
  const [edge] = await db.query<EntryKeys>(
    `SELECT e.net_worth, e.par_tick, e.tokens FROM entries e WHERE e.challenge_id = ? AND ${m.where} ORDER BY ${playerOrder(q.medal, 'e')} LIMIT 1 OFFSET ?`,
    [c.id, 3 * q.limit - 1]);
  const top = rankedCte(q.medal, c.id, { upTo: edge });
  const rows = await db.query<RankedRow>(`${top.sql} ${RANKED_SELECT} ORDER BY r.rank LIMIT ?`, [...top.args, q.limit]);

  let me: BoardResult['me'] = null;
  if (q.viewerId) {
    const best = await bestEntry(db, q.medal, c.id, q.viewerId);
    if (best) {
      const own = rankedCte(q.medal, c.id, { upTo: best });
      const [mine] = await db.query<RankedRow>(`${own.sql} ${RANKED_SELECT} WHERE r.user_id = ?`, [...own.args, q.viewerId]);
      if (mine) me = { ...boardRow(mine), percentile: percentileOf(mine.rank, total) };
    }
  }

  const key = `hist:${c.id}:${q.medal}`;
  const now = q.now ?? Date.now();
  const [stored] = await db.query<{ value: string }>('SELECT value FROM arena_meta WHERE key = ?', [key]);
  const cached = stored ? (JSON.parse(stored.value) as { at: number; final: boolean; histogram: Histogram }) : null;
  let histogram: Histogram;
  const closed = isClosed(c, now);
  if (cached && (cached.final || (!closed && now >= cached.at && now - cached.at < HISTOGRAM_TTL_MS))) histogram = cached.histogram;
  else {
    const full = rankedCte(q.medal, c.id);
    histogram = (await histogramOf(db, full.sql, full.args)).histogram;
    await db.execute('INSERT INTO arena_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, JSON.stringify({ at: now, final: closed, histogram })]);
  }
  return { medal: q.medal, entries: rows.map(boardRow), histogram, total, me };
}

// ---- hall of fame ----

export interface SeasonSummary {
  id: string; number: number | null; opensAt: number; closesAt: number | null; players: number;
  winners: Record<Medal, BoardRow | null>;
}

/** Closed seasons that had at least one entry, newest first, with the first-place entry of each medal. */
export async function hallOfFame(db: Db, now: number, limit: number): Promise<{ seasons: SeasonSummary[] }> {
  const closed = await db.query<ChallengeRow & { players: number }>(
    `SELECT c.*, (SELECT COUNT(DISTINCT e.user_id) FROM entries e WHERE e.challenge_id = c.id) AS players
       FROM challenges c WHERE c.kind = 'season' AND c.closes_at IS NOT NULL AND c.closes_at <= ?
        AND EXISTS (SELECT 1 FROM entries e WHERE e.challenge_id = c.id) ORDER BY c.opens_at DESC LIMIT ?`,
    [now, limit]);
  const seasons: SeasonSummary[] = [];
  for (const c of closed) {
    const winners = {} as SeasonSummary['winners'];
    for (const medal of ['wealth', 'speed', 'brevity'] as Medal[]) {
      const { sql, args } = rankedCte(medal, c.id, { friends: false });
      const [top] = await db.query<RankedRow>(`${sql} ${RANKED_SELECT} ORDER BY r.rank LIMIT 1`, args);
      winners[medal] = top ? boardRow(top) : null;
    }
    seasons.push({ id: c.id, number: c.number, opensAt: c.opens_at, closesAt: c.closes_at, players: c.players, winners });
  }
  return { seasons };
}

// ---- single entries ----

async function loadEntry(db: Db, id: string): Promise<EntryRow & { login: string; display_name: string; avatar_url: string | null }> {
  const [row] = await db.query<EntryRow & { login: string; display_name: string; avatar_url: string | null }>(
    'SELECT e.*, u.login, u.display_name, u.avatar_url FROM entries e JOIN users u ON u.id = e.user_id WHERE e.id = ?', [id]);
  if (!row) throw new HttpError(404, 'Entry not found');
  return row;
}

/** Owner always; anyone once the challenge has closed; for duels, anyone who has an entry of their own. */
async function replayVisible(db: Db, c: ChallengeRow, entry: EntryRow, viewerId: string | undefined, now: number): Promise<boolean> {
  if (isClosed(c, now)) return true;
  if (!viewerId) return false;
  if (viewerId === entry.user_id) return true;
  if (c.kind !== 'duel') return false;
  const [mine] = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM entries WHERE challenge_id = ? AND user_id = ?', [c.id, viewerId]);
  return mine!.n > 0;
}

export async function entrySummary(db: Db, id: string, viewerId: string | undefined, now: number) {
  const e = await loadEntry(db, id);
  const [c] = await db.query<ChallengeRow>('SELECT * FROM challenges WHERE id = ?', [e.challenge_id]);
  return {
    id: e.id,
    player: { login: e.login, displayName: e.display_name, avatarUrl: e.avatar_url },
    netWorth: e.net_worth, parTick: e.par_tick, tokens: e.tokens, mosaic: e.mosaic,
    authorKind: e.author_kind, model: e.model, sourceVerified: e.source_verified === 1, sourcePublic: e.source_public === 1,
    createdAt: e.created_at, sealed: !(await replayVisible(db, c!, e, viewerId, now)),
    challenge: { id: c!.id, kind: c!.kind, number: c!.number, seed: c!.seed, ticks: c!.ticks, par: c!.par, opensAt: c!.opens_at, closesAt: c!.closes_at, rulesVersion: c!.rules_version, setupVersion: c!.setup_v },
  };
}

export async function entryReplay(db: Db, id: string, viewerId: string | undefined, now: number) {
  const e = await loadEntry(db, id);
  const [c] = await db.query<ChallengeRow>('SELECT * FROM challenges WHERE id = ?', [e.challenge_id]);
  if (!(await replayVisible(db, c!, e, viewerId, now))) throw new HttpError(403, 'Sealed until the challenge closes');
  if (e.actions === null) throw new HttpError(404, 'No replay stored for this entry');
  return { seed: c!.seed, ticks: c!.ticks, rulesVersion: c!.rules_version, setupVersion: c!.setup_v, kind: c!.kind, actions: JSON.parse(e.actions) as LogEntry[] };
}

/**
 * GET /entries/:id/source. Only programs that passed the source check are stored. The author always sees their own;
 * everyone else needs the author's "publish" tick and the same sealing rule as the replay (closed challenge, or for
 * duels, an entry of your own).
 */
export async function entrySource(db: Db, id: string, viewerId: string | undefined, now: number) {
  const e = await loadEntry(db, id);
  const [c] = await db.query<ChallengeRow>('SELECT * FROM challenges WHERE id = ?', [e.challenge_id]);
  const [row] = await db.query<{ source: string | null }>('SELECT source FROM entries WHERE id = ?', [id]);
  if (row?.source == null || e.source_verified !== 1) throw new HttpError(404, 'No program stored for this entry');
  if (viewerId !== e.user_id) {
    if (!(await replayVisible(db, c!, e, viewerId, now))) throw new HttpError(403, 'Sealed until the challenge closes');
    if (e.source_public !== 1) throw new HttpError(403, 'The author has not published this program');
  }
  return {
    entryId: e.id, source: row.source, tokens: e.tokens, netWorth: e.net_worth, parTick: e.par_tick, sourcePublic: e.source_public === 1,
    player: { login: e.login, displayName: e.display_name, avatarUrl: e.avatar_url }, authorKind: e.author_kind, model: e.model,
    challenge: { id: c!.id, kind: c!.kind, number: c!.number },
  };
}

/** GET /challenges/:id/sources: programs authors chose to publish, best net worth first. Closed challenges only. */
export async function publishedSources(db: Db, c: ChallengeRow, limit: number, now: number) {
  if (!isClosed(c, now)) throw new HttpError(403, 'Sealed until the challenge closes');
  const rows = await db.query<{ id: string; net_worth: number; par_tick: number | null; tokens: number | null; mosaic: string | null; author_kind: AuthorKind; model: string | null; login: string; display_name: string; avatar_url: string | null }>(
    `SELECT e.id, e.net_worth, e.par_tick, e.tokens, e.mosaic, e.author_kind, e.model, u.login, u.display_name, u.avatar_url
     FROM entries e JOIN users u ON u.id = e.user_id
     WHERE e.challenge_id = ? AND e.source_public = 1 AND e.source_verified = 1 AND e.source IS NOT NULL
     ORDER BY e.net_worth DESC, e.created_at ASC, e.id ASC LIMIT ?`, [c.id, limit]);
  return {
    challenge: { id: c.id, kind: c.kind, number: c.number },
    entries: rows.map((r) => ({
      entryId: r.id, login: r.login, displayName: r.display_name, avatarUrl: r.avatar_url, netWorth: r.net_worth, parTick: r.par_tick,
      tokens: r.tokens, mosaic: r.mosaic, authorKind: r.author_kind, model: r.model,
    })),
  };
}

// ---- old /api/daily* routes ----

export async function legacySubmit(db: Db, userId: string, date: string, actions: LogEntry[], now: number, setupV: number = SETUP_VERSION) {
  if (date !== utcDate(now) && date !== utcDate(now - DAY_MS)) throw new HttpError(422, 'Only today or yesterday (UTC) can be submitted');
  const c = await loadChallenge(db, dailyId(date), now, undefined, setupV);
  const input: EntryInput = { rulesVersion: RULES_VERSION, actions, source: null, sourcePublic: false, authorKind: 'human', model: null };
  const result = await submitEntry(db, userId, c, input, actions, now, { graceMs: LEGACY_GRACE_MS, repeatOk: true });
  const [best] = await db.query<{ best: number }>('SELECT MAX(net_worth) AS best FROM entries WHERE challenge_id = ? AND user_id = ?', [c.id, userId]);
  return { netWorth: result.netWorth, rank: result.ranks.wealth!, best: best!.best };
}

export async function legacyLeaderboard(db: Db, date: string, limit: number) {
  const [c] = await db.query<ChallengeRow>('SELECT * FROM challenges WHERE id = ?', [dailyId(date)]);
  if (!c) return [];
  const { entries } = await board(db, c, { medal: 'wealth', friends: false, limit });
  return entries.map((e) => ({ rank: e.rank, userId: e.userId, displayName: e.displayName, netWorth: e.value, achievedAtMs: e.createdAt }));
}

/** Copies daily_entries into challenges/entries once. The old table stays as an archive. Safe to re-run. */
/** Rebuilds a challenge's per-medal player counters from its entries (after a bulk move, or to repair drift). */
export async function recountPlayers(q: Queryable, challengeId: string): Promise<void> {
  await q.execute(
    `UPDATE challenges SET
       n_wealth  = (SELECT COUNT(DISTINCT user_id) FROM entries e WHERE e.challenge_id = ?1),
       n_speed   = (SELECT COUNT(DISTINCT user_id) FROM entries e WHERE e.challenge_id = ?1 AND e.par_tick IS NOT NULL),
       n_brevity = (SELECT COUNT(DISTINCT user_id) FROM entries e WHERE e.challenge_id = ?1 AND e.tokens IS NOT NULL)
     WHERE id = ?1`, [challengeId]);
}

export async function moveLegacyDaily(db: Db): Promise<void> {
  const [done] = await db.query<{ value: string }>("SELECT value FROM arena_meta WHERE key = 'daily_entries_moved'");
  if (done) return;
  const rows = await db.query<{ date: string; user_id: string; net_worth: number; achieved_at: number }>('SELECT date, user_id, net_worth, achieved_at FROM daily_entries ORDER BY date, user_id');
  await db.transaction(async (tx) => {
    for (const date of new Set(rows.map((r) => r.date))) await insertChallenge(tx, newDailyRow(date, SETUP_LEGACY));
    for (const r of rows) {
      const hash = `legacy:${r.date}:${r.user_id}`;
      const id = createHash('sha256').update(hash).digest('base64url').slice(0, 12);
      await tx.execute(
        `INSERT OR IGNORE INTO entries (id, challenge_id, user_id, net_worth, par_tick, tokens, actions, actions_count, log_hash, mosaic, source, source_public, source_verified, author_kind, model, created_at)
         VALUES (?, ?, ?, ?, NULL, NULL, NULL, 0, ?, NULL, NULL, 0, 0, 'human', NULL, ?)`,
        [id, dailyId(r.date), r.user_id, r.net_worth, hash, r.achieved_at],
      );
    }
    for (const date of new Set(rows.map((r) => r.date))) await recountPlayers(tx, dailyId(date));
    await tx.execute("INSERT OR IGNORE INTO arena_meta (key, value) VALUES ('daily_entries_moved', '1')");
  });
}

// ---- stats ----

export async function stats(db: Db): Promise<{ players: number; farms: number; dailyEntries: number; entriesPerDay: { date: string; entries: number }[] }> {
  const [row] = await db.query<{ players: number; farms: number; daily: number }>(
    `SELECT (SELECT COUNT(*) FROM users) AS players, (SELECT COUNT(*) FROM farms) AS farms,
       (SELECT COUNT(*) FROM (SELECT DISTINCT e.challenge_id, e.user_id FROM entries e JOIN challenges c ON c.id = e.challenge_id WHERE c.kind = 'daily')) AS daily`,
  );
  // Stored entries only (at most three per player per challenge), by UTC day of creation, newest first.
  const perDay = await db.query<{ date: string; entries: number }>(
    "SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS date, COUNT(*) AS entries FROM entries GROUP BY date ORDER BY date DESC LIMIT 30",
  );
  return { players: row!.players, farms: row!.farms, dailyEntries: row!.daily, entriesPerDay: perDay };
}
