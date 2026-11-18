// Daily briefs, server side (K3): secret seeds, hidden farms, the closing pass. The sim owns the brief itself (packages/sim/src/brief.ts).
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { finalOf, HIDDEN_FARMS, SETUP_BRIEF } from '@tendril/sim/src/index.ts';
import type { Db } from './db.ts';
import { HttpError } from './validation.ts';
import type { SourceVerifier, VerifyRequest } from './verify-client.ts';

/** True for a challenge whose setup version draws a brief. Dispatch is by this stored data, never by the clock. */
export const isBriefSetup = (setupV: number): boolean => setupV >= SETUP_BRIEF;

/**
 * The secret behind brief seeds: `CHALLENGE_SALT`, else derived from the Turso token like VERIFY_SECRET. Empty when neither is set;
 * `requireSalt` then refuses to make a brief challenge rather than derive guessable seeds.
 */
export function challengeSalt(env: Record<string, string | undefined>): string {
  if (env.CHALLENGE_SALT) return env.CHALLENGE_SALT;
  return env.TURSO_AUTH_TOKEN ? createHash('sha256').update(`tendril-challenge-salt:${env.TURSO_AUTH_TOKEN}`).digest('hex') : '';
}
export function requireSalt(salt: string | undefined): string {
  if (!salt) throw new HttpError(503, 'Daily briefs are not configured: CHALLENGE_SALT is missing');
  return salt;
}

/**
 * Seed of farm `farm` of challenge `id` (0 = the visible farm, i >= 1 = hidden sibling i). An HMAC, not a plain hash of salt and id:
 * with FNV-1a the sibling seed `hash(salt:id:h1)` is the visible seed with three more bytes folded in, so anyone could compute
 * every hidden seed from the public one. HMAC-SHA-256 keeps the siblings unrelated to the visible seed without the salt.
 */
export function briefSeed(salt: string, id: string, farm = 0): number {
  const mac = createHmac('sha256', requireSalt(salt)).update(`tendril-brief:${id}${farm === 0 ? '' : `:h${farm}`}`).digest();
  return (mac.readUInt32LE(0) >>> 0) || 1;
}

/** Hidden farms of a challenge row: dailies 2, seasons 4, duels none. Challenges below the brief setup have none. */
export const hiddenFarmCount = (c: { kind: 'daily' | 'season' | 'duel'; setup_v: number }): number => (isBriefSetup(c.setup_v) ? HIDDEN_FARMS[c.kind] : 0);
export const siblingSeeds = (salt: string, c: { id: string; kind: 'daily' | 'season' | 'duel'; setup_v: number }): number[] =>
  Array.from({ length: hiddenFarmCount(c) }, (_, i) => briefSeed(salt, c.id, i + 1));

/** Par of a brief: 90% of the reference program's mean score over every farm (whole units, rounded down), at least 1. */
export const briefPar = (scores: readonly number[]): number => Math.max(1, Math.floor((scores.reduce((a, b) => a + b, 0) * 9) / (10 * scores.length)));

// ---- the closing pass ----

const lockKey = (id: string): string => `brief_lock:${id}`;
const doneKey = (id: string): string => `brief_done:${id}`;
export const BRIEF_LOCK_TTL_MS = 5 * 60_000;
/** Entries checked per request. Each costs one verify call per hidden farm (run in parallel), so a request stays near two runs long. */
export const BRIEF_BATCH = 3;

export interface BriefChallenge { id: string; kind: 'daily' | 'season' | 'duel'; seed: number; ticks: number; par: number | null; rules_version: number; setup_v: number; market?: string | null }
interface Pending { id: string; source: string | null; score: number | null; net_worth: number; par_tick: number | null }

export interface ClosingResult { done: boolean; checked: number; locked: boolean }

/**
 * Runs each verified entry's program on the hidden farms of a closed brief challenge, a bounded number of entries per call, and stores
 * `final_score`, `final_par_tick` and `hidden_done = 1`. A program that fails on a hidden farm scores 0 there. A verify outage
 * (the call itself fails) leaves the entry for the next call. Writes per call: lock claim and release, one UPDATE per entry, and one
 * marker row when the challenge has nothing left. Read-only until there is work (the marker row stops later calls after one read).
 */
export async function closeBrief(
  db: Db, c: BriefChallenge, salt: string, verify: SourceVerifier | undefined, marketOf: (c: BriefChallenge) => { p: number[] } | null, now: number, batch = BRIEF_BATCH,
): Promise<ClosingResult> {
  const none = (done: boolean, locked = false): ClosingResult => ({ done, checked: 0, locked });
  if (!isBriefSetup(c.setup_v) || c.kind === 'duel' || !verify) return none(!isBriefSetup(c.setup_v) || c.kind === 'duel');
  const [marker] = await db.query('SELECT 1 AS x FROM arena_meta WHERE key = ?', [doneKey(c.id)]);
  if (marker) return none(true);
  const hidden = hiddenFarmCount(c);
  const [first] = await db.query('SELECT 1 AS x FROM entries WHERE challenge_id = ? AND source_verified = 1 AND hidden_done = 0 LIMIT 1', [c.id]);
  if (!first) {
    await db.execute('INSERT OR IGNORE INTO arena_meta (key, value) VALUES (?, ?)', [doneKey(c.id), String(now)]);
    return none(true);
  }
  const token = `${now}:${randomUUID()}`;
  const claim = await db.execute('INSERT INTO arena_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2 WHERE CAST(value AS INTEGER) < ?3', [lockKey(c.id), token, now - BRIEF_LOCK_TTL_MS]);
  if (claim.rowsAffected === 0) return none(false, true);
  let checked = 0;
  try {
    const rows = await db.query<Pending>(
      'SELECT id, source, score, net_worth, par_tick FROM entries WHERE challenge_id = ? AND source_verified = 1 AND hidden_done = 0 ORDER BY created_at, id LIMIT ?', [c.id, batch]);
    const seeds = Array.from({ length: hidden }, (_, i) => briefSeed(salt, c.id, i + 1));
    const market = marketOf(c);
    for (const row of rows) {
      const runs = row.source === null ? seeds.map(() => null) : await Promise.all(seeds.map(async (farmSeed) => {
        const request: VerifyRequest = { source: row.source!, challengeId: c.id, kind: c.kind, seed: c.seed, farmSeed, ticks: c.ticks, rulesVersion: c.rules_version, setupVersion: c.setup_v, market, par: c.par ?? undefined };
        return verify(request); // a rejection (verify unavailable) escapes: nothing is stored for this entry
      }));
      const scores = [row.score ?? row.net_worth], parTicks: (number | null)[] = [row.par_tick];
      for (const r of runs) {
        if (r && r.ok && Number.isSafeInteger(r.score) && r.score! >= 0) { scores.push(r.score!); parTicks.push(r.parTick ?? null); } else { scores.push(0); parTicks.push(null); }
      }
      const { finalScore, finalParTick } = finalOf(scores, parTicks, c.ticks, c.par ?? Number.MAX_SAFE_INTEGER);
      await db.execute('UPDATE entries SET final_score = ?, final_par_tick = ?, hidden_done = 1 WHERE id = ? AND hidden_done = 0', [finalScore, finalParTick, row.id]);
      checked++;
    }
  } catch { /* the check itself failed: keep what is done, retry on the next request */ }
  finally { await db.execute('DELETE FROM arena_meta WHERE key = ? AND value = ?', [lockKey(c.id), token]); }
  return { done: false, checked, locked: false };
}

/** Closed brief dailies and seasons that may still have entries to check (the last few days; ratings stop waiting after 48 h). */
export async function pendingBriefs(db: Db, now: number): Promise<(BriefChallenge & { closes_at: number })[]> {
  return db.query(
    `SELECT c.* FROM challenges c WHERE c.setup_v >= ?1 AND c.kind IN ('daily', 'season') AND c.closes_at IS NOT NULL AND c.closes_at <= ?2 AND c.closes_at > ?3
       AND NOT EXISTS (SELECT 1 FROM arena_meta m WHERE m.key = 'brief_done:' || c.id) ORDER BY c.closes_at LIMIT 10`,
    [SETUP_BRIEF, now, now - 7 * 24 * 3_600_000]);
}

// ---- the lazy runner ----

export interface BriefCloser { tick(force?: boolean): Promise<void> }
const CHECK_EVERY_MS = 60_000;

/**
 * Called on requests, like the rater. At most one scan a minute (`force` skips the wait on routes that show results), a failed pass is not
 * retried for a minute, and only one pass runs at a time per instance (the arena_meta lock covers other instances). The scan reads a
 * handful of challenge rows and one marker per row; nothing is written until a closed brief has entries to check.
 */
export function createBriefCloser(
  db: Db, salt: string, verify: SourceVerifier | undefined, now: () => number, marketOf: (c: BriefChallenge) => { p: number[] } | null, canWrite: () => Promise<boolean> = async () => true,
): BriefCloser {
  let inflight: Promise<unknown> | undefined;
  let lastCheck = Number.NEGATIVE_INFINITY, failedAt = Number.NEGATIVE_INFINITY;
  return {
    async tick(force) {
      if (!verify || !salt) return;
      const t = now();
      if (!force && t >= lastCheck && t - lastCheck < CHECK_EVERY_MS) return;
      if (t >= failedAt && t - failedAt < CHECK_EVERY_MS) return;
      lastCheck = t;
      inflight ??= (async () => {
        if (!(await canWrite())) return;
        for (const c of await pendingBriefs(db, t)) {
          const r = await closeBrief(db, c, salt, verify, marketOf, t);
          if (r.checked > 0) break; // one bounded batch per pass; the next request continues
        }
      })().catch(() => { failedAt = t; console.error('Brief closing pass failed'); }).finally(() => { inflight = undefined; });
      await inflight;
    },
  };
}
