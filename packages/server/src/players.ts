import type { Db } from './db.ts';
import { DAY_MS } from './game.ts';
import { HttpError } from './validation.ts';

/** B5: player pages, streaks, follows and the README badge. Self-contained; routes are wired in app.ts. */

export const MAX_FOLLOWING = 500;
const RECENT_ENTRIES = 10;
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
        SELECT e.id, e.challenge_id, e.net_worth, e.par_tick, e.tokens, e.created_at,
          ROW_NUMBER() OVER (PARTITION BY e.challenge_id ORDER BY ${s.order}) AS pick
        FROM entries e JOIN challenges c ON c.id = e.challenge_id
        WHERE e.user_id = ? AND c.kind IN ('daily', 'season') AND ${s.where}${extraWhere}
      ) WHERE pick = 1
    )
    SELECT m.challenge_id,
      1 + (SELECT COUNT(DISTINCT o.user_id) FROM entries o WHERE o.challenge_id = m.challenge_id AND o.user_id <> ? AND ${s.where.replace(/\be\./g, 'o.')} AND ${s.better('o', 'm')}) AS rank,
      (SELECT COUNT(DISTINCT o.user_id) FROM entries o WHERE o.challenge_id = m.challenge_id AND ${s.where.replace(/\be\./g, 'o.')}) AS total
    FROM mine m`;
}

export interface MedalCounts { wealth: number; speed: number; brevity: number }

/** A medal is a first place on a closed daily or season board. */
async function medalCounts(db: Db, userId: string, now: number): Promise<MedalCounts> {
  const out: MedalCounts = { wealth: 0, speed: 0, brevity: 0 };
  for (const medal of Object.keys(out) as Medal[]) {
    const rows = await db.query<{ rank: number }>(`${standings(medal, ' AND c.closes_at IS NOT NULL AND c.closes_at <= ?')}`, [userId, now, userId]);
    out[medal] = rows.filter((r) => r.rank === 1).length;
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

// ---- player page ----

export async function playerPage(db: Db, login: string, viewerId: string | undefined, now: number, today: string) {
  const p = await requirePlayer(db, login);
  const [streaks, medals, topPercent] = await Promise.all([streaksOf(db, p.id, today), medalCounts(db, p.id, now), bestTopPercent(db, p.id)]);
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
    medals, topPercent,
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

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
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
