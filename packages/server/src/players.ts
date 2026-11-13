import type { Db } from './db.ts';
import { DAY_MS } from './game.ts';
import { isSettled } from './arena.ts';
import { hiddenSql } from './moderation.ts';
import type { ChallengeRow } from './arena.ts';
import { PLACEMENT_EVENTS, tierOf } from '@tendril/rating/src/index.ts';
import { ratingSummary } from './ratings.ts';
import { HttpError } from './validation.ts';

/** B5: player pages, streaks, follows and the README badge. Self-contained; routes are wired in app.ts. */

export const MAX_FOLLOWING = 500;
const RECENT_ENTRIES = 10;
export const MAX_PINNED = 3;
/** Days of play returned for the portfolio garden (20 weeks plus the partial current week fits in 140). */
export const GARDEN_DAYS = 140;
const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface PlayerRef { id: string; login: string; displayName: string; avatarUrl: string | null }
interface UserRow { id: string; login: string; display_name: string; avatar_url: string | null }

export function loginParam(value: string): string {
  if (!LOGIN_RE.test(value)) throw new HttpError(400, 'Invalid login');
  return value;
}

const ref = (r: UserRow): PlayerRef => ({ id: r.id, login: r.login, displayName: r.display_name, avatarUrl: r.avatar_url });

/** Logins compare case-insensitively. If a renamed account and a new one share a login, the newest account wins. */
export async function findPlayer(db: Db, login: string): Promise<PlayerRef | null> {
  const [row] = await db.query<UserRow>('SELECT id, login, display_name, avatar_url FROM users WHERE login = ? COLLATE NOCASE ORDER BY created_at DESC, id LIMIT 1', [login]);
  return row ? ref(row) : null;
}

async function requirePlayer(db: Db, login: string): Promise<PlayerRef> {
  const p = await findPlayer(db, loginParam(login));
  if (!p) throw new HttpError(404, 'Player not found');
  return p;
}

// ---- streaks ----

const dayNumber = (date: string): number => Date.parse(`${date}T00:00:00Z`) / DAY_MS;

export interface Streaks { current: number; best: number; lastDay: string | null }

/**
 * Streaks over the UTC dates of daily challenges the player has an entry for (an entry counts for the day of its
 * challenge, so a run submitted just after midnight for yesterday still counts for yesterday). The current streak is the
 * run ending today or yesterday: today not being played yet does not break it.
 */
export function computeStreaks(dates: string[], today: string): Streaks {
  const days = [...new Set(dates)].map(dayNumber).filter(Number.isFinite).sort((a, b) => a - b);
  let best = 0, run = 0, prev = NaN;
  for (const d of days) {
    run = d === prev + 1 ? run + 1 : 1;
    if (run > best) best = run;
    prev = d;
  }
  const last = days[days.length - 1];
  const t = dayNumber(today);
  const current = last !== undefined && last >= t - 1 && last <= t ? run : 0;
  return { current, best, lastDay: last === undefined ? null : new Date(last * DAY_MS).toISOString().slice(0, 10) };
}

async function streaksOf(db: Db, userId: string, today: string): Promise<Streaks> {
  const rows = await db.query<{ d: string }>(
    "SELECT DISTINCT substr(e.challenge_id, 3) AS d FROM entries e JOIN challenges c ON c.id = e.challenge_id WHERE e.user_id = ? AND c.kind = 'daily'", [userId]);
  return computeStreaks(rows.map((r) => r.d), today);
}

// ---- medals and percentile ----

type Medal = 'wealth' | 'speed' | 'brevity';
/** `better(a, b)`: SQL true when entry a beats entry b. Mirrors the board order in arena.ts (earlier entry wins ties). */
const SPEC: Record<Medal, { where: string; order: string; better: (a: string, b: string) => string }> = {
  wealth: {
    where: '1 = 1', order: 'e.net_worth DESC, e.created_at ASC, e.id ASC',
    better: (a, b) => `(${a}.net_worth > ${b}.net_worth OR (${a}.net_worth = ${b}.net_worth AND (${a}.created_at < ${b}.created_at OR (${a}.created_at = ${b}.created_at AND ${a}.id < ${b}.id))))`,
  },
  speed: {
    where: 'e.par_tick IS NOT NULL', order: 'e.par_tick ASC, e.net_worth DESC, e.created_at ASC, e.id ASC',
    better: (a, b) => `(${a}.par_tick < ${b}.par_tick OR (${a}.par_tick = ${b}.par_tick AND (${a}.net_worth > ${b}.net_worth OR (${a}.net_worth = ${b}.net_worth AND (${a}.created_at < ${b}.created_at OR (${a}.created_at = ${b}.created_at AND ${a}.id < ${b}.id))))))`,
  },
  brevity: {
    where: 'e.tokens IS NOT NULL', order: 'e.tokens ASC, e.net_worth DESC, e.created_at ASC, e.id ASC',
    better: (a, b) => `(${a}.tokens < ${b}.tokens OR (${a}.tokens = ${b}.tokens AND (${a}.net_worth > ${b}.net_worth OR (${a}.net_worth = ${b}.net_worth AND (${a}.created_at < ${b}.created_at OR (${a}.created_at = ${b}.created_at AND ${a}.id < ${b}.id))))))`,
  },
};

/** Per challenge, the player's best entry for the medal plus how many other players beat it and how many play. */
function standings(medal: Medal, extraWhere: string): string {
  const s = SPEC[medal];
  return `WITH mine AS (
      SELECT * FROM (
        SELECT e.id, e.challenge_id, e.net_worth, e.par_tick, e.tokens, e.created_at, e.log_hash, e.actions_count,
          ROW_NUMBER() OVER (PARTITION BY e.challenge_id ORDER BY ${s.order}) AS pick
        FROM entries e JOIN challenges c ON c.id = e.challenge_id
        WHERE e.user_id = ? AND c.kind IN ('daily', 'season') AND ${s.where}${extraWhere}
      ) WHERE pick = 1
    )
    SELECT m.challenge_id,
      1 + (SELECT COUNT(DISTINCT o.user_id) FROM entries o WHERE o.challenge_id = m.challenge_id AND o.user_id <> ? AND ${s.where.replace(/\be\./g, 'o.')} AND ${s.better('o', 'm')}) AS rank,
      (SELECT COUNT(DISTINCT o.user_id) FROM entries o WHERE o.challenge_id = m.challenge_id AND ${s.where.replace(/\be\./g, 'o.')}) AS total,
      -- Identical non-empty logs share a rank (A2): true when my log is the same run as the top entry's, so it is also first.
      EXISTS (SELECT 1 FROM entries t WHERE t.challenge_id = m.challenge_id AND ${s.where.replace(/\be\./g, 't.')} AND m.actions_count > 0 AND t.log_hash = m.log_hash
        AND NOT EXISTS (SELECT 1 FROM entries x WHERE x.challenge_id = m.challenge_id AND ${s.where.replace(/\be\./g, 'x.')} AND ${s.better('x', 't')})) AS shares_first
    FROM mine m`;
}

export interface MedalCounts { wealth: number; speed: number; brevity: number }

/** A medal is a first place (or a share of it, for an identical log) on a closed daily or season board. */
async function medalCounts(db: Db, userId: string, now: number): Promise<MedalCounts> {
  const out: MedalCounts = { wealth: 0, speed: 0, brevity: 0 };
  for (const medal of Object.keys(out) as Medal[]) {
    const rows = await db.query<{ rank: number; shares_first: number }>(`${standings(medal, ' AND c.closes_at IS NOT NULL AND c.closes_at <= ?')}`, [userId, now, userId]);
    out[medal] = rows.filter((r) => r.rank === 1 || r.shares_first).length;
  }
  return out;
}

/** Best (smallest) "top N%" the player has reached on any daily or season wealth board, or null with no entries. */
async function bestTopPercent(db: Db, userId: string): Promise<number | null> {
  const rows = await db.query<{ rank: number; total: number }>(standings('wealth', ''), [userId, userId]);
  let best: number | null = null;
  for (const r of rows) {
    const top = Math.max(1, Math.ceil((100 * r.rank) / r.total));
    if (best === null || top < best) best = top;
  }
  return best;
}

// ---- garden days and pinned programs (R3b) ----

const pinKey = (userId: string) => `pins:${userId}`;

/** UTC dates (YYYY-MM-DD, ascending) of the daily/season challenges the player entered in the last GARDEN_DAYS days. A season counts for its last open day. */
async function gardenDays(db: Db, userId: string, now: number): Promise<string[]> {
  const rows = await db.query<{ d: string }>(
    `SELECT DISTINCT CASE WHEN c.kind = 'daily' THEN substr(c.id, 3) ELSE strftime('%Y-%m-%d', (c.closes_at - 1) / 1000, 'unixepoch') END AS d
     FROM entries e JOIN challenges c ON c.id = e.challenge_id
     WHERE e.user_id = ? AND c.kind IN ('daily', 'season') AND c.closes_at IS NOT NULL AND c.closes_at > ?`, [userId, now - (GARDEN_DAYS + 2) * DAY_MS]);
  const from = new Date(now - (GARDEN_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
  return rows.map((r) => r.d).filter((d) => d >= from).sort();
}

type PinRow = { id: string; challenge_id: string; kind: string; number: number | null; net_worth: number; par_tick: number | null; tokens: number | null };

/** Entries of `userId` among `ids` that are public programs now: verified, published by the author, challenge settled, not hidden. */
async function publicOwnEntries(db: Db, userId: string, ids: string[], now: number): Promise<Map<string, PinRow>> {
  const out = new Map<string, PinRow>();
  if (ids.length === 0) return out;
  const rows = await db.query<PinRow & ChallengeRow>(
    `SELECT e.id, e.challenge_id, e.net_worth, e.par_tick, e.tokens, c.kind, c.number, c.closes_at
     FROM entries e JOIN challenges c ON c.id = e.challenge_id
     WHERE e.user_id = ? AND e.id IN (${ids.map(() => '?').join(',')}) AND e.source_public = 1 AND e.source_verified = 1 AND e.source IS NOT NULL
       AND c.kind IN ('daily', 'season') AND NOT ${hiddenSql('e.id')}`, [userId, ...ids]);
  for (const r of rows) if (isSettled(r as unknown as ChallengeRow, now)) out.set(r.id, r);
  return out;
}

async function storedPins(db: Db, userId: string): Promise<string[]> {
  const [row] = await db.query<{ value: string }>('SELECT value FROM arena_meta WHERE key = ?', [pinKey(userId)]);
  if (!row) return [];
  try { const v: unknown = JSON.parse(row.value); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, MAX_PINNED) : []; } catch { return []; }
}

/** Pinned programs in the owner's order; entries that stopped being public (hidden, removed) silently drop out. */
async function pinnedOf(db: Db, userId: string, now: number) {
  const ids = await storedPins(db, userId);
  const rows = await publicOwnEntries(db, userId, ids, now);
  const out = [];
  for (const id of ids) {
    const r = rows.get(id);
    if (!r) continue;
    const [pos] = await db.query<{ rank: number; players: number }>(
      `SELECT 1 + (SELECT COUNT(DISTINCT o.user_id) FROM entries o WHERE o.challenge_id = ?1 AND o.user_id <> ?2 AND ${SPEC.wealth.better('o', 'm')}) AS rank,
              (SELECT COUNT(DISTINCT user_id) FROM entries WHERE challenge_id = ?1) AS players
       FROM entries m WHERE m.id = ?3`, [r.challenge_id, userId, id]);
    out.push({ entryId: id, challengeId: r.challenge_id, kind: r.kind, number: r.number, rank: pos!.rank, players: pos!.players, tokens: r.tokens, netWorth: r.net_worth, parTick: r.par_tick });
  }
  return out;
}

/** PUT /players/me/pinned: replaces the list. Entries must be the caller's own, published, verified, settled programs. */
export async function setPinned(db: Db, userId: string, entryIds: string[], now: number) {
  if (entryIds.length > MAX_PINNED) throw new HttpError(422, `You can pin at most ${MAX_PINNED} programs`);
  if (new Set(entryIds).size !== entryIds.length) throw new HttpError(422, 'Duplicate entry');
  const ok = await publicOwnEntries(db, userId, entryIds, now);
  if (ok.size !== entryIds.length) throw new HttpError(422, 'Only your own published programs from closed daily or season challenges can be pinned');
  await db.execute('INSERT INTO arena_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [pinKey(userId), JSON.stringify(entryIds)]);
  return { pinned: await pinnedOf(db, userId, now) };
}

// ---- player page ----

export async function playerPage(db: Db, login: string, viewerId: string | undefined, now: number, today: string) {
  const p = await requirePlayer(db, login);
  const [streaks, medals, topPercent, rating, pinned, days] = await Promise.all([streaksOf(db, p.id, today), medalCounts(db, p.id, now), bestTopPercent(db, p.id), ratingSummary(db, p.id, now), pinnedOf(db, p.id, now), gardenDays(db, p.id, now)]);
  const recent = await db.query<{ id: string; challenge_id: string; kind: string; number: number | null; net_worth: number; par_tick: number | null; tokens: number | null; mosaic: string | null; created_at: number; closes_at: number | null }>(
    `SELECT e.id, e.challenge_id, c.kind, c.number, e.net_worth, e.par_tick, e.tokens, e.mosaic, e.created_at, c.closes_at
     FROM entries e JOIN challenges c ON c.id = e.challenge_id
     WHERE e.user_id = ? AND c.kind IN ('daily', 'season') ORDER BY e.created_at DESC, e.id LIMIT ?`, [p.id, RECENT_ENTRIES]);
  const [counts] = await db.query<{ followers: number; following: number }>(
    'SELECT (SELECT COUNT(*) FROM follows WHERE followee_id = ?) AS followers, (SELECT COUNT(*) FROM follows WHERE follower_id = ?) AS following', [p.id, p.id]);
  let following = false;
  if (viewerId && viewerId !== p.id) {
    following = (await db.query('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?', [viewerId, p.id])).length > 0;
  }
  return {
    login: p.login, displayName: p.displayName, avatarUrl: p.avatarUrl,
    streak: { current: streaks.current, best: streaks.best, lastDay: streaks.lastDay },
    medals, topPercent, rating, pinned, days,
    followers: counts!.followers, following: counts!.following,
    viewer: viewerId ? { isSelf: viewerId === p.id, following } : null,
    // Sealed runs expose only the summary (no replay is linked from here); the mosaic is the same one the board shows.
    recent: recent.map((r) => ({ entryId: r.id, challengeId: r.challenge_id, kind: r.kind, number: r.number, netWorth: r.net_worth, parTick: r.par_tick, tokens: r.tokens, mosaic: r.mosaic, createdAt: r.created_at })),
  };
}

// ---- follows ----

export async function follow(db: Db, userId: string, login: string, now: number): Promise<{ following: true; changed: boolean }> {
  const target = await requirePlayer(db, login);
  if (target.id === userId) throw new HttpError(422, 'You cannot follow yourself');
  return db.transaction(async (tx) => {
    const [row] = await tx.query<{ n: number }>('SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?', [userId]);
    const exists = (await tx.query('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?', [userId, target.id])).length > 0;
    if (exists) return { following: true as const, changed: false };
    if (row!.n >= MAX_FOLLOWING) throw new HttpError(409, `You can follow at most ${MAX_FOLLOWING} players`);
    await tx.execute('INSERT INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)', [userId, target.id, Math.trunc(now)]);
    return { following: true as const, changed: true };
  });
}

export async function unfollow(db: Db, userId: string, login: string): Promise<{ following: false; changed: boolean }> {
  const target = await requirePlayer(db, login);
  const r = await db.execute('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?', [userId, target.id]);
  return { following: false, changed: r.rowsAffected > 0 };
}

export async function listFollowing(db: Db, userId: string): Promise<{ players: Omit<PlayerRef, 'id'>[] }> {
  const rows = await db.query<UserRow>(
    'SELECT u.id, u.login, u.display_name, u.avatar_url FROM follows f JOIN users u ON u.id = f.followee_id WHERE f.follower_id = ? ORDER BY f.created_at DESC, u.id LIMIT ?', [userId, MAX_FOLLOWING]);
  return { players: rows.map((r) => ({ login: r.login, displayName: r.display_name, avatarUrl: r.avatar_url })) };
}

// ---- badge ----

// Characters XML 1.0 forbids (controls, U+FFFE/U+FFFF) are dropped: one in a name would make the whole SVG unparseable and the image break.
// eslint-disable-next-line no-control-regex
const esc = (s: string): string => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const textWidth = (s: string): number => Math.round(s.length * 6.4 + 12);

export function badgeSvg(left: string, right: string, color: string): string {
  const lw = textWidth(left), rw = textWidth(right), w = lw + rw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${esc(left)}: ${esc(right)}">`
    + `<title>${esc(left)}: ${esc(right)}</title>`
    + `<clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>`
    + `<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#3b3b3b"/><rect x="${lw}" width="${rw}" height="20" fill="${color}"/></g>`
    + `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">`
    + `<text x="${lw / 2}" y="14">${esc(left)}</text><text x="${lw + rw / 2}" y="14">${esc(right)}</text></g></svg>`;
}

/** Badge for any login. An unknown or invalid login still gets a valid grey badge, so README images never break. */
export async function badgeFor(db: Db, login: string, today: string): Promise<string> {
  const p = LOGIN_RE.test(login) ? await findPlayer(db, login) : null;
  if (!p) return badgeSvg('tendril', 'unknown player', '#9f9f9f');
  const [s, top] = await Promise.all([streaksOf(db, p.id, today), bestTopPercent(db, p.id)]);
  if (top === null) return badgeSvg('tendril', 'no runs yet', '#9f9f9f');
  const streak = `${s.current} day${s.current === 1 ? '' : 's'} streak`;
  return badgeSvg('tendril', `${streak} · top ${top}%`, s.current > 0 ? '#3f9b4b' : '#6a7f5a');
}

// ---- R5: rating badge and README stats card ----

/** Tier colours: the light-theme set from the profile mockup (white text on each reads fine) and the dark-theme set for the dark card. */
const TIER_ON_LIGHT: Record<string, string> = { seed: '#6b4a32', seedling: '#7d7426', shoot: '#4f8a2a', vine: '#1f7a6b', bloom: '#7b3a86', orchard: '#b8322a', grove: '#b9650f', evergreen: '#0f4d2a' };
const TIER_ON_DARK: Record<string, string> = { seed: '#b08866', seedling: '#d4c86a', shoot: '#9bd16a', vine: '#5fd0bd', bloom: '#c07ac9', orchard: '#e0675c', grove: '#f0a04a', evergreen: '#b7f0c0' };
export const tierColor = (key: string, dark: boolean): string => (dark ? TIER_ON_DARK : TIER_ON_LIGHT)[key] ?? (dark ? '#9fb3a4' : '#9f9f9f');
export const PROMOTION_WINDOW_MS = 7 * DAY_MS;
const SPARK_POINTS = 30;
export const thousands = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');


export type RatingCardState = 'unknown' | 'unrated' | 'placement' | 'rated';
export interface RatingCardData {
  state: RatingCardState;
  login: string; name: string;
  rating: number | null; tier: { key: string; name: string } | null; events: number; peak: number | null;
  /** "Top N%" among established, active players; null in placement or when inactive. */
  topPercent: number | null;
  speed: number | null; brevity: number | null;
  streak: number;
  /** Overall rating after each of the last rated days, oldest first. */
  spark: number[];
  mosaic: string | null;
  /** Set when the newest overall result crossed a tier floor upward within PROMOTION_WINDOW_MS. */
  promotion: { tier: { key: string; name: string }; rating: number; challengeId: string; closesAt: number } | null;
}

const UNKNOWN_CARD: RatingCardData = { state: 'unknown', login: '', name: '', rating: null, tier: null, events: 0, peak: null, topPercent: null, speed: null, brevity: null, streak: 0, spark: [], mosaic: null, promotion: null };

/** Everything the card, the rating badge and the profile preview need, in three small reads. Never throws for a bad login. */
export async function loadRatingCard(db: Db, login: string, now: number): Promise<RatingCardData> {
  const p = LOGIN_RE.test(login) ? await findPlayer(db, login) : null;
  if (!p) return UNKNOWN_CARD;
  const [summary, streaks] = await Promise.all([ratingSummary(db, p.id, now), streaksOf(db, p.id, utcDay(now))]);
  const o = summary.overall;
  const base: RatingCardData = { ...UNKNOWN_CARD, state: 'unrated', login: p.login, name: p.displayName || p.login, streak: streaks.current };
  if (!o) {
    const [m] = await db.query<{ mosaic: string | null }>("SELECT e.mosaic FROM entries e JOIN challenges c ON c.id = e.challenge_id WHERE e.user_id = ? AND c.kind IN ('daily', 'season') ORDER BY e.created_at DESC LIMIT 1", [p.id]);
    return { ...base, mosaic: m?.mosaic ?? null };
  }
  const last = o.history[o.history.length - 1]!;
  const [m] = await db.query<{ mosaic: string | null }>('SELECT mosaic FROM entries WHERE id = ?', [last.entryId]);
  const before = tierOf(last.before), after = tierOf(last.rating);
  const promoted = !o.provisional && after.floor > before.floor && now - last.closesAt < PROMOTION_WINDOW_MS;
  return {
    ...base, state: o.provisional ? 'placement' : 'rated',
    rating: o.rating, tier: { key: o.tier.key, name: o.tier.name }, events: o.events, peak: o.peak,
    topPercent: o.percentile === null ? null : Math.max(1, 100 - o.percentile + 1),
    speed: summary.speed?.rating ?? null, brevity: summary.brevity?.rating ?? null,
    spark: o.history.slice(-SPARK_POINTS).map((h) => h.rating),
    mosaic: m?.mosaic ?? null,
    promotion: promoted ? { tier: { key: after.key, name: after.name }, rating: last.rating, challengeId: last.challengeId, closesAt: last.closesAt } : null,
  };
}
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** `/badge/rating/:login.svg`. Same shape as the streak badge; the right half takes the tier colour. Unknown logins get a grey badge. */
export async function ratingBadgeFor(db: Db, login: string, now: number): Promise<string> {
  const d = await loadRatingCard(db, login, now);
  if (d.state === 'unknown') return badgeSvg('tendril rating', 'unknown player', '#9f9f9f');
  if (d.state === 'unrated') return badgeSvg('tendril rating', 'unrated', '#9f9f9f');
  if (d.state === 'placement') return badgeSvg('tendril rating', `${thousands(d.rating!)} · placement ${d.events}/${PLACEMENT_EVENTS}`, '#6a7f5a');
  return badgeSvg('tendril rating', `${thousands(d.rating!)} ${d.tier!.name}`, tierColor(d.tier!.key, false));
}

/**
 * `/card/:login.svg`, the README stats card (profile mockup). Self-contained: no scripts, no style sheet, no images, no
 * links and no external references, so it survives GitHub's image proxy. System fonts only.
 */
export async function statsCardFor(db: Db, login: string, now: number): Promise<string> {
  const d = await loadRatingCard(db, login, now);
  return statsCardSvg(d);
}

const W = 460, H = 150;
export function statsCardSvg(d: RatingCardData): string {
  const dark = true;
  const accent = d.tier ? tierColor(d.tier.key, dark) : '#9fb3a4';
  const name = d.state === 'unknown' ? 'unknown player' : d.name;
  const title = `${name} on Tendril`;
  const shown = title.length > 30 ? `${title.slice(0, 29)}…` : title;
  let big = '', line = '', foot = '', spark = '', label: string;
  if (d.state === 'unknown') { label = 'No player with that login'; line = 'Check the login in the card URL.'; }
  else if (d.state === 'unrated') { label = 'Not rated yet'; line = d.streak > 0 ? `streak ${d.streak}` : 'Play the daily challenge to get a rating.'; foot = 'tendril.hokora.xyz'; }
  else {
    big = thousands(d.rating!);
    const parts = [d.state === 'placement' ? `placement ${d.events}/${PLACEMENT_EVENTS}` : d.tier!.name];
    if (d.topPercent !== null) parts.push(`top ${d.topPercent}%`);
    if (d.streak > 0) parts.push(`streak ${d.streak}`);
    if (d.brevity !== null) parts.push(`Brevity ${thousands(d.brevity)}`);
    if (d.speed !== null) parts.push(`Speed ${thousands(d.speed)}`);
    label = parts.join(' · ');
    foot = d.state === 'placement' ? 'Provisional rating while placement runs' : `Peak ${thousands(d.peak!)} · ${d.events} rated days`;
    if (d.spark.length >= 2) {
      const lo = Math.min(...d.spark), hi = Math.max(...d.spark), span = Math.max(1, hi - lo);
      const pts = d.spark.map((v, i) => `${(24 + (i * (W - 48)) / (d.spark.length - 1)).toFixed(1)},${(H - 40 - ((v - lo) / span) * 22).toFixed(1)}`).join(' ');
      spark = `<polyline fill="none" stroke="${accent}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${pts}"/>`;
    }
  }
  const desc = [title, big, label].filter(Boolean).join(', ');
  const font = 'font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif"';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(desc)}">`
    + `<title>${esc(desc)}</title>`
    + `<rect width="${W}" height="${H}" rx="10" fill="#12201a"/><rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="9.5" fill="none" stroke="#2d4636"/>`
    + `<text x="24" y="38" ${font} font-size="16" font-weight="700" fill="#f4f1e6">${esc(shown)}</text>`
    + (big ? `<text x="${W - 24}" y="40" ${font} font-size="26" font-weight="700" text-anchor="end" fill="${accent}">${esc(big)}</text>` : '')
    + `<text x="24" y="64" ${font} font-size="13" fill="${big ? accent : '#9fb3a4'}">${esc(label)}</text>`
    + (line ? `<text x="24" y="88" ${font} font-size="12" fill="#9fb3a4">${esc(line)}</text>` : '')
    + spark
    + (foot ? `<text x="24" y="${H - 12}" ${font} font-size="11" fill="#7d9484">${esc(foot)}</text>` : '')
    + `</svg>`;
}
