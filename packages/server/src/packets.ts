import { randomBytes } from 'node:crypto';
import type { Db } from './db.ts';
import { isSettled } from './arena.ts';
import type { ChallengeRow } from './arena.ts';
import { DAY_MS } from './game.ts';
import { hiddenSql as entryHiddenSql, HIDE_THRESHOLD, MIN_REPORTER_AGE_MS, cleanText } from './moderation.ts';
import { programHash, recordEntryProgram } from './program-hash.ts';
import { HttpError } from './validation.ts';

/**
 * H8 seed packets: a named Sprout program with a note, an author and (for a remix) a parent packet.
 * The server never runs player code; the client compiles before it offers Share, and the text is only ever shown escaped.
 */

export const MAX_PACKET_BYTES = 16 * 1024;
export const PACKET_TAGS = ['starter', 'tiny', 'fast', 'wealth', 'orchard', 'bees', 'market', 'silo', 'multi-bot', 'tricks'] as const;
export const PACKET_ORIGINS = ['endless', 'sandbox', 'cli'] as const;
const WEEK_MS = 7 * DAY_MS;
const FAMILY_LIMIT = 60;
const ID = /^[A-Za-z0-9_-]{8,16}$/;

const newId = (): string => randomBytes(8).toString('base64url');

/** SQL: true when the packet row `p` has enough counted reports. */
const hiddenSql = (col = 'p.id'): string => `(SELECT COUNT(*) FROM packet_reports r WHERE r.packet_id = ${col} AND r.counted = 1) >= ${HIDE_THRESHOLD}`;

// ---- entry program hashes (written by arena.ts through program-hash.ts, backfilled here for older entries) ----

const backfilled = new WeakMap<Db, Promise<void>>();
async function backfill(db: Db): Promise<void> {
  if (!backfilled.has(db)) {
    backfilled.set(db, (async () => {
      for (;;) {
        const rows = await db.query<{ id: string; source: string }>(
          'SELECT e.id, e.source FROM entries e WHERE e.source IS NOT NULL AND e.source_verified = 1 AND NOT EXISTS (SELECT 1 FROM entry_programs p WHERE p.entry_id = e.id) LIMIT 200');
        if (rows.length === 0) return;
        for (const r of rows) await recordEntryProgram(db, r.id, r.source);
      }
    })().catch((e: unknown) => { backfilled.delete(db); throw e; }));
  }
  await backfilled.get(db);
}

// ---- reading ----

interface Row {
  id: string; user_id: string; name: string; note: string; tags: string; source?: string; parent_id: string | null; origin: string; created_at: number;
  login: string; display_name: string; avatar_url: string | null; plants: number; week: number;
}

const SELECT = `SELECT p.id, p.user_id, p.name, p.note, p.tags, p.parent_id, p.origin, p.created_at, u.login, u.display_name, u.avatar_url,
    (SELECT COUNT(*) FROM packet_plants pl WHERE pl.packet_id = p.id) AS plants,
    (SELECT COUNT(*) FROM packet_plants pl WHERE pl.packet_id = p.id AND pl.last_at >= ?) AS week`;

const summary = (r: Row) => ({
  id: r.id, name: r.name, note: r.note, tags: r.tags === '' ? [] : r.tags.split(','), origin: r.origin, plants: r.plants, plantsThisWeek: r.week, parentId: r.parent_id, createdAt: r.created_at,
  author: { login: r.login, displayName: r.display_name, avatarUrl: r.avatar_url },
});

export type PacketSort = 'popular' | 'new';

export function packetTag(value: string | null): string | null {
  if (value === null || value === '') return null;
  if (!(PACKET_TAGS as readonly string[]).includes(value)) throw new HttpError(400, 'Invalid tag');
  return value;
}

/** GET /packets: the public lists. Popular = most players who planted in the last 7 days, then all time, then newest. */
export async function listPackets(db: Db, sort: PacketSort, tag: string | null, limit: number, now: number) {
  const week = now - WEEK_MS;
  const where = `NOT ${hiddenSql()}${tag ? " AND (',' || p.tags || ',') LIKE ?" : ''}`;
  const args = [week, ...(tag ? [`%,${tag},%`] : []), limit];
  const order = sort === 'popular' ? 'week DESC, plants DESC, p.created_at DESC, p.id' : 'p.created_at DESC, p.id';
  const rows = await db.query<Row>(`${SELECT} FROM packets p JOIN users u ON u.id = p.user_id WHERE ${where} ORDER BY ${order} LIMIT ?`, args);
  return { sort, tag, packets: rows.map(summary) };
}

async function loadVisible(db: Db, id: string, now: number): Promise<Row & { source: string; hash: string }> {
  if (!ID.test(id)) throw new HttpError(404, 'Packet not found');
  const [row] = await db.query<Row & { source: string; hash: string }>(
    `${SELECT}, p.source, p.hash FROM packets p JOIN users u ON u.id = p.user_id WHERE p.id = ? AND NOT ${hiddenSql()}`, [now - WEEK_MS, id]);
  if (!row) throw new HttpError(404, 'Packet not found');
  return row;
}

/** The family of remixes around one packet: walk up to the root, then take descendants (breadth first), capped. */
async function family(db: Db, start: Row, now: number) {
  let root = start;
  for (let i = 0; i < 30 && root.parent_id; i++) {
    const [up] = await db.query<Row>(`${SELECT} FROM packets p JOIN users u ON u.id = p.user_id WHERE p.id = ? AND NOT ${hiddenSql()}`, [now - WEEK_MS, root.parent_id]);
    if (!up) break;
    root = up;
  }
  const nodes = new Map<string, Row>([[root.id, root]]);
  let frontier = [root.id];
  for (let depth = 0; depth < 12 && frontier.length > 0 && nodes.size < FAMILY_LIMIT; depth++) {
    const marks = frontier.map(() => '?').join(',');
    const kids = await db.query<Row>(
      `${SELECT} FROM packets p JOIN users u ON u.id = p.user_id WHERE p.parent_id IN (${marks}) AND NOT ${hiddenSql()} ORDER BY p.created_at, p.id LIMIT ?`,
      [now - WEEK_MS, ...frontier, FAMILY_LIMIT - nodes.size]);
    frontier = [];
    for (const k of kids) if (!nodes.has(k.id)) { nodes.set(k.id, k); frontier.push(k.id); }
  }
  return { rootId: root.id, nodes: [...nodes.values()].map((r) => ({ id: r.id, name: r.name, parentId: nodes.has(r.parent_id ?? '') ? r.parent_id : null, login: r.login, plants: r.plants, createdAt: r.created_at })) };
}

/**
 * The best verified result of any entry that ran this exact program, from a closed daily or season. Only entries whose
 * author published their program (or the packet's own author) count, so this never reveals a private program.
 */
async function bestResult(db: Db, hash: string, authorId: string, now: number) {
  await backfill(db);
  const rows = await db.query<{ id: string; score: number; challenge_id: string; kind: string; number: number | null; opens_at: number; closes_at: number; login: string; display_name: string }
    & Pick<ChallengeRow, 'id'>>(
    `SELECT e.id, COALESCE(e.final_score, e.score, e.net_worth) AS score, e.challenge_id, c.kind, c.number, c.opens_at, c.closes_at, u.login, u.display_name
     FROM entry_programs ep JOIN entries e ON e.id = ep.entry_id JOIN challenges c ON c.id = e.challenge_id JOIN users u ON u.id = e.user_id
     WHERE ep.hash = ? AND c.kind IN ('daily', 'season') AND c.closes_at IS NOT NULL AND (e.source_public = 1 OR e.user_id = ?) AND NOT ${entryHiddenSql('e.id')}
     ORDER BY score DESC, e.created_at, e.id LIMIT 30`, [hash, authorId]);
  const settled = rows.filter((r) => isSettled({ kind: r.kind, closes_at: r.closes_at } as ChallengeRow, now));
  const best = settled[0];
  return best ? {
    entryId: best.id, score: best.score, challengeId: best.challenge_id, kind: best.kind, number: best.number,
    player: { login: best.login, displayName: best.display_name }, entries: settled.length,
  } : null;
}

/** GET /packets/:id: the packet with its code, the family tree and its best result. Hidden packets are 404. */
export async function packetPage(db: Db, id: string, now: number) {
  const row = await loadVisible(db, id, now);
  return { ...summary(row), source: row.source, family: await family(db, row, now), bestResult: await bestResult(db, row.hash, row.user_id, now) };
}

/** The packets one player shared, newest first (for the profile page). */
export async function packetsOf(db: Db, userId: string, now: number) {
  const rows = await db.query<Row>(`${SELECT} FROM packets p JOIN users u ON u.id = p.user_id WHERE p.user_id = ? AND NOT ${hiddenSql()} ORDER BY p.created_at DESC, p.id LIMIT 50`, [now - WEEK_MS, userId]);
  return { list: rows.map((r) => ({ id: r.id, name: r.name, plants: r.plants, parentId: r.parent_id, createdAt: r.created_at })), totalPlants: rows.reduce((n, r) => n + r.plants, 0) };
}

// ---- writing ----

export interface PacketInput { name: string; note: string; tags: string[]; source: string; parentId: string | null; origin: string }

export function packetInput(value: unknown): PacketInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(422, 'Invalid request');
  const b = value as Record<string, unknown>;
  if (Object.keys(b).some((k) => !['name', 'note', 'tags', 'source', 'parentId', 'origin'].includes(k))) throw new HttpError(422, 'Invalid request fields');
  const name = cleanText(b.name, 'The name', 3, 40);
  const note = b.note === undefined || b.note === '' ? '' : cleanText(b.note, 'The note', 1, 280);
  const tags = b.tags ?? [];
  if (!Array.isArray(tags) || tags.length > 3 || tags.some((t) => typeof t !== 'string' || !(PACKET_TAGS as readonly string[]).includes(t))) throw new HttpError(422, `Pick up to 3 tags from: ${PACKET_TAGS.join(', ')}`);
  if (typeof b.source !== 'string' || b.source.trim() === '') throw new HttpError(422, 'A packet needs a program');
  if (new TextEncoder().encode(b.source).length > MAX_PACKET_BYTES) throw new HttpError(413, 'That program is too long for a packet (16 KB at most)');
  if ([...b.source].some((c) => { const n = c.charCodeAt(0); return (n < 32 && n !== 9 && n !== 10 && n !== 13) || n === 127; })) throw new HttpError(422, 'The program has characters we cannot store');
  const parentId = b.parentId ?? null;
  if (parentId !== null && (typeof parentId !== 'string' || !ID.test(parentId))) throw new HttpError(422, 'Invalid parent packet');
  const origin = b.origin ?? 'endless';
  if (typeof origin !== 'string' || !(PACKET_ORIGINS as readonly string[]).includes(origin)) throw new HttpError(422, 'A program from an open daily or season can only be shared after it closes');
  return { name, note, tags: [...new Set(tags as string[])], source: b.source.replace(/\r\n?/g, '\n'), parentId, origin };
}

/**
 * POST /packets. Fair play: a program that an entry is using on a daily or season that has not settled yet cannot be shared,
 * whoever entered it. Endless and sandbox programs can be shared any time.
 */
export async function publishPacket(db: Db, userId: string, input: PacketInput, now: number): Promise<{ id: string; parentId: string | null }> {
  await backfill(db);
  const hash = programHash(input.source);
  const live = await db.query<{ kind: string; closes_at: number }>(
    `SELECT c.kind, c.closes_at FROM entry_programs ep JOIN entries e ON e.id = ep.entry_id JOIN challenges c ON c.id = e.challenge_id
     WHERE ep.hash = ? AND c.kind IN ('daily', 'season') AND c.closes_at IS NOT NULL ORDER BY c.closes_at DESC LIMIT 10`, [hash]);
  if (live.some((c) => !isSettled({ kind: c.kind, closes_at: c.closes_at } as ChallengeRow, now))) {
    throw new HttpError(409, 'A program in play on an open daily or season can only be shared after it closes.');
  }
  let parent: string | null = null;
  if (input.parentId !== null) {
    const [p] = await db.query<{ id: string; hash: string }>(`SELECT p.id, p.hash FROM packets p WHERE p.id = ? AND NOT ${hiddenSql()}`, [input.parentId]);
    if (!p) throw new HttpError(422, 'The packet you remixed is not available');
    if (p.hash === hash) throw new HttpError(422, 'Change something first: this is the same program as the packet you started from.');
    parent = p.id;
  }
  const [same] = await db.query<{ id: string; user_id: string }>('SELECT id, user_id FROM packets WHERE hash = ? ORDER BY created_at LIMIT 1', [hash]);
  if (same) throw new HttpError(409, same.user_id === userId ? 'You already shared this program as a packet.' : 'This exact program is already a packet. Plant it and change something to share your own version.');
  const id = newId();
  await db.execute('INSERT INTO packets (id, user_id, name, note, tags, source, hash, parent_id, origin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, userId, input.name, input.note, input.tags.join(','), input.source, hash, parent, input.origin, now]);
  return { id, parentId: parent };
}

/** POST /packets/:id/plant: records one plant per player (the author planting their own packet does not count). */
export async function plantPacket(db: Db, userId: string, id: string, now: number): Promise<{ planted: true; plants: number }> {
  const row = await loadVisible(db, id, now);
  if (row.user_id !== userId) {
    await db.execute('INSERT INTO packet_plants (packet_id, user_id, first_at, last_at) VALUES (?, ?, ?, ?) ON CONFLICT (packet_id, user_id) DO UPDATE SET last_at = excluded.last_at', [id, userId, now, now]);
  }
  const [n] = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM packet_plants WHERE packet_id = ?', [id]);
  return { planted: true, plants: n!.n };
}

/** POST /packets/:id/report. Counted like entry reports: the reporter's account is a week old and has a verified entry. */
export async function reportPacket(db: Db, userId: string, id: string, now: number): Promise<{ reported: true; changed: boolean; hidden: boolean }> {
  if (!ID.test(id)) throw new HttpError(404, 'Packet not found');
  const [p] = await db.query<{ user_id: string }>('SELECT user_id FROM packets WHERE id = ?', [id]);
  if (!p) throw new HttpError(404, 'Packet not found');
  if (p.user_id === userId) throw new HttpError(422, 'You cannot report your own packet');
  const [me] = await db.query<{ created_at: number }>('SELECT created_at FROM users WHERE id = ?', [userId]);
  if (!me) throw new HttpError(401, 'Authentication required');
  const [verified] = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM (SELECT 1 FROM entries WHERE user_id = ? AND actions_count > 0 LIMIT 1)', [userId]);
  const counted = now - me.created_at >= MIN_REPORTER_AGE_MS && verified!.n > 0 ? 1 : 0;
  const added = await db.execute('INSERT OR IGNORE INTO packet_reports (packet_id, reporter_id, counted, created_at) VALUES (?, ?, ?, ?)', [id, userId, counted, now]);
  const [h] = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM packet_reports WHERE packet_id = ? AND counted = 1', [id]);
  return { reported: true, changed: added.rowsAffected > 0, hidden: h!.n >= HIDE_THRESHOLD };
}
