// E1b: the shared daily market on the server (SIM_SPEC 4). Day before the epoch, the epoch day, the day after,
// fewer than 10 players, the table CAS, the 0.1.x refusal, par and source checks under the table, duels.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BASE_RULES_VERSION, MARKET_EPOCH, RULES_VERSION, baseMarket, challengeSetup, createWorld, dailySeed, marketPrices, nextMarket, parFromReference,
  replayStats, replayWithPar,
} from '@tendril/sim/src/index.ts';
import type { LogEntry } from '@tendril/sim/src/index.ts';
import { createRun } from '../../lang/src/index.ts';
import { verifySource } from '../../lang/src/verify.ts';
import { createApp, createDb } from '../src/index.ts';
import type { Db } from '../src/index.ts';
import { challengeInfo, loadChallenge, marketOf } from '../src/arena.ts';
import { computeDailyMarket } from '../src/market.ts';
import { REFERENCE_SOURCE } from '../src/reference.ts';
import type { VerifyRequest } from '../src/verify-client.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const at = (date: string, hour = 12): number => Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00Z`);
/** A short legal harvest that sells 4 carrots on any seed. */
const SELLS_CARROTS: LogEntry[] = [[0, 0, 0, 1], [2, 0, 1], [5, 0, 2, 1], [7, 0, 3], [9, 0, 3], [300, 0, 4], [303, 0, 0, 3], [305, 0, 5], [306, 0, 8, 1, 4]];
const BEFORE = '2026-12-07', EPOCH = '2026-12-08', AFTER = '2026-12-09';

let db: Db;
let app: (request: Request) => Promise<Response>;
let time = at(EPOCH);
let seen: VerifyRequest[] = [];

beforeEach(() => {
  seen = []; time = at(EPOCH);
  db = createDb({ url: ':memory:' });
  app = createApp({ db, env: { TENDRIL_DEV_AUTH: '1' }, now: () => time, verifySource: async (r) => { seen.push(r); return verifySource(r); } });
});
afterEach(() => db.close());

async function call(path: string, o: { token?: string; body?: unknown } = {}) {
  const headers = new Headers();
  if (o.token) headers.set('Authorization', `Bearer ${o.token}`);
  if (o.body !== undefined) headers.set('Content-Type', 'application/json');
  const res = await app(new Request(`http://localhost:8787/api${path}`, { method: o.body !== undefined ? 'POST' : 'GET', headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined }));
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Json };
}
const players = new Map<string, string>();
async function login(name: string): Promise<string> {
  const cached = players.get(name);
  if (cached) return cached;
  const r = await call('/dev/login', { body: { displayName: name } });
  players.set(name, r.json.token);
  return r.json.token;
}
beforeEach(() => players.clear());
const enter = async (id: string, actions: LogEntry[], name: string, rulesVersion = BASE_RULES_VERSION, extra: Json = {}) =>
  call(`/challenges/${id}/entries`, { token: await login(name), body: { rulesVersion, actions, ...extra } });
const dayId = (d: string) => `d-${d}`;

/** `n` players each submit SELLS_CARROTS on `date` (the clock stands on that day). */
async function crowd(date: string, n: number, rulesVersion: number): Promise<void> {
  time = at(date);
  await call(`/challenges/${dayId(date)}`);
  for (let i = 0; i < n; i++) expect((await enter(dayId(date), SELLS_CARROTS, `p${i}`, rulesVersion)).status).toBe(200);
}

describe('the day before the epoch', () => {
  it('is rules v3 at base prices, with no table, and its entries record what they sold', async () => {
    time = at(BEFORE);
    const info = (await call(`/challenges/${dayId(BEFORE)}`)).json;
    expect(info).toMatchObject({ rulesVersion: 3, market: null });
    const row = (await db.query<{ market: string | null; rules_version: number }>('SELECT market, rules_version FROM challenges WHERE id = ?', [dayId(BEFORE)]))[0]!;
    expect(row).toEqual({ market: null, rules_version: 3 });
    const r = await enter(dayId(BEFORE), SELLS_CARROTS, 'ann');
    expect(r.status).toBe(200);
    const [e] = await db.query<{ sold: string }>('SELECT sold FROM entries WHERE challenge_id = ?', [dayId(BEFORE)]);
    const world = createWorld({ id: dayId(BEFORE), seed: dailySeed(BEFORE) }, challengeSetup('daily', dailySeed(BEFORE), 1).setup);
    expect(JSON.parse(e!.sold)).toEqual(replayStats(world, SELLS_CARROTS, 3000).slice(1, 8));
    expect(JSON.parse(e!.sold)[0]).toBe(4);
    // base prices: the score is what version 3 always gave
    expect(r.json.netWorth).toBe(replayWithPar(createWorld({ id: 'x', seed: dailySeed(BEFORE) }, challengeSetup('daily', dailySeed(BEFORE), 1).setup), SELLS_CARROTS, 3000, 0).netWorth);
  });

  it('v3 rows replay and verify after the migration (a v3 verify request carries no table)', async () => {
    time = at(BEFORE);
    await call(`/challenges/${dayId(BEFORE)}`);
    expect(seen.every((r) => r.rulesVersion === 3 && !r.market)).toBe(true);
    const source = 'x = 1\n';
    expect((await enter(dayId(BEFORE), [], 'ann', 3, { source })).status).toBe(200);
    expect(seen.at(-1)).toMatchObject({ rulesVersion: 3, market: null });
    const replay = await call(`/entries/${(await db.query<{ id: string }>('SELECT id FROM entries'))[0]!.id}/replay`);
    expect(replay.status === 403 || replay.json.market === null).toBe(true);
  });
});

describe('the epoch day', () => {
  it('is rules v4 with the base table, even when the day before had a crowd', async () => {
    await crowd(BEFORE, 12, 3);
    time = at(EPOCH);
    const info = (await call(`/challenges/${dayId(EPOCH)}`)).json;
    expect(info.rulesVersion).toBe(4);
    expect(info.market).toEqual({ prices: [0, 200, 300, 100, 600, 400, 500, 800], multipliers: [0, 1000, 1000, 1000, 1000, 1000, 1000, 1000], shares: null });
    const [row] = await db.query<{ market: string }>('SELECT market FROM challenges WHERE id = ?', [dayId(EPOCH)]);
    expect(JSON.parse(row!.market)).toEqual(baseMarket());
    expect(JSON.parse(row!.market)).toMatchObject({ n: 0, from: null, sh: null });
  });

  it('par is measured by the reference program on the v4 world and the verify function is sent the table', async () => {
    const info = (await call(`/challenges/${dayId(EPOCH)}`)).json;
    const asked = seen.filter((r) => r.challengeId === dayId(EPOCH));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ rulesVersion: 4, market: { p: info.market.prices } });
    const ref = verifySource(asked[0]!);
    expect(ref.ok && info.par).toBe(ref.ok ? parFromReference(ref.netWorth) : -1);
  });

  it('scores a run under the day\'s table: a v4 row without its table is never played', async () => {
    const id = dayId(EPOCH);
    await call(`/challenges/${id}`);
    const row = (await db.query<any>('SELECT * FROM challenges WHERE id = ?', [id]))[0]; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(marketOf(row)!.p).toEqual(baseMarket().p);
    expect(() => marketOf({ ...row, market: null })).toThrow('no valid price table');
    expect(() => marketOf({ ...row, market: '{"m":[0]}' })).toThrow('no valid price table');
    expect(marketOf({ ...row, rules_version: 3, market: null })).toBeNull();
  });

  it('a source check on a market day runs under the table and the entry carries that net worth', async () => {
    const id = dayId(EPOCH);
    const info = (await call(`/challenges/${id}`)).json;
    const seed = dailySeed(EPOCH);
    const cs = challengeSetup('daily', seed, info.setupVersion, { p: info.market.prices });
    const run = createRun(createWorld({ id, seed }, cs.setup), REFERENCE_SOURCE); run.step(cs.ticks);
    const actions = run.pending.filter((a) => a[0] < cs.ticks);
    const r = await enter(id, actions, 'ann', 4, { source: REFERENCE_SOURCE });
    expect(r.status).toBe(200);
    expect(seen.at(-1)).toMatchObject({ rulesVersion: 4, market: { p: info.market.prices } });
    expect(r.json.netWorth).toBe(replayWithPar(createWorld({ id, seed }, cs.setup), actions, cs.ticks, 0).netWorth);
  });
});

describe('the day after the epoch', () => {
  it('with 10 or more players is derived from what they sold', async () => {
    await crowd(EPOCH, 10, 4);
    time = at(AFTER);
    const info = (await call(`/challenges/${dayId(AFTER)}`)).json;
    expect(info.rulesVersion).toBe(4);
    // everyone sold only carrots: carrot falls the full 25 points, everything else rises 25 points
    expect(info.market.multipliers).toEqual([0, 750, 1250, 1250, 1250, 1250, 1250, 1250]);
    expect(info.market.prices).toEqual(marketPrices(info.market.multipliers));
    expect(info.market.prices[1]).toBe(150);
    expect(info.market.shares).toEqual([0, 1000, 0, 0, 0, 0, 0, 0]);
    const [row] = await db.query<{ market: string }>('SELECT market FROM challenges WHERE id = ?', [dayId(AFTER)]);
    expect(JSON.parse(row!.market)).toMatchObject({ n: 10, from: dayId(EPOCH) });
    // the run is scored under that table on the server and a later replay of the entry reproduces it
    const r = await enter(dayId(AFTER), SELLS_CARROTS, 'zed', 4);
    expect(r.status).toBe(200);
    const world = createWorld({ id: dayId(AFTER), seed: dailySeed(AFTER) }, challengeSetup('daily', dailySeed(AFTER), 1, { p: info.market.prices }).setup);
    expect(r.json.netWorth).toBe(replayWithPar(world, SELLS_CARROTS, 3000, 0).netWorth);
  });

  it('with fewer than 10 players stays neutral: no shares, base prices', async () => {
    await crowd(EPOCH, 9, 4);
    time = at(AFTER);
    const info = (await call(`/challenges/${dayId(AFTER)}`)).json;
    expect(info.market.shares).toBeNull();
    expect(info.market.multipliers).toEqual(baseMarket().m);
    expect(info.market.prices).toEqual(baseMarket().p);
    const [row] = await db.query<{ market: string }>('SELECT market FROM challenges WHERE id = ?', [dayId(AFTER)]);
    expect(JSON.parse(row!.market)).toMatchObject({ n: 9, sh: null, from: dayId(EPOCH) });
  });

  it('uses each player\'s best entry only, and a late entry cannot rewrite a stored table', async () => {
    await crowd(EPOCH, 10, 4);
    time = at(AFTER);
    const before = (await call(`/challenges/${dayId(AFTER)}`)).json.market;
    // a grace-period entry for the epoch day arrives after the next day's table exists
    time = at(AFTER, 1);
    const late = await enter(dayId(EPOCH), [], 'p0', 4);
    expect([200, 409]).toContain(late.status);
    expect((await call(`/challenges/${dayId(AFTER)}`)).json.market).toEqual(before);
  });

  it('computes the same table from the same data every time', async () => {
    await crowd(EPOCH, 10, 4);
    const a = await computeDailyMarket(db, AFTER), b = await computeDailyMarket(db, AFTER);
    expect(a).toEqual(b);
    const expected = nextMarket(
      Array.from({ length: 10 }, () => replayStats(createWorld({ id: 'x', seed: dailySeed(EPOCH) }, challengeSetup('daily', dailySeed(EPOCH), 1, baseMarket()).setup), SELLS_CARROTS, 3000)),
      [{ id: dayId(EPOCH), m: baseMarket().m, t: baseMarket().t, sh: null }],
    );
    expect(a).toEqual(expected);
  });
});

describe('one table per day', () => {
  it('a race to create the table leaves exactly one, and everyone reads it', async () => {
    await crowd(EPOCH, 10, 4);
    time = at(AFTER);
    // a market-day row with no table (as an old crash could leave): five requests at once
    const seed = dailySeed(AFTER);
    await db.execute('INSERT INTO challenges (id, kind, number, seed, ticks, par, opens_at, closes_at, created_by, rules_version, setup_v, market) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [dayId(AFTER), 'daily', 9, seed, 3000, 100, at(AFTER, 0), at(AFTER, 0) + 86_400_000, null, 4, 1, null]);
    const rows = await Promise.all(Array.from({ length: 5 }, () => loadChallenge(db, dayId(AFTER), time)));
    expect(new Set(rows.map((r) => r.market)).size).toBe(1);
    expect(rows[0]!.market).not.toBeNull();
    const [stored] = await db.query<{ market: string }>('SELECT market FROM challenges WHERE id = ?', [dayId(AFTER)]);
    expect(stored!.market).toBe(rows[0]!.market);
    // and the loser of a write is a no-op: the column never changes once set
    await db.execute('UPDATE challenges SET market = ? WHERE id = ? AND market IS NULL', ['{"x":1}', dayId(AFTER)]);
    expect((await db.query<{ market: string }>('SELECT market FROM challenges WHERE id = ?', [dayId(AFTER)]))[0]!.market).toBe(stored!.market);
    expect((await challengeInfo(db, rows[0]!)).market).not.toBeNull();
  });

  it('simultaneous first requests of a new market day all see one table', async () => {
    time = at(EPOCH);
    const infos = await Promise.all(Array.from({ length: 6 }, () => call(`/challenges/${dayId(EPOCH)}`)));
    expect(new Set(infos.map((i) => JSON.stringify(i.json.market))).size).toBe(1);
    expect(infos.every((i) => i.status === 200)).toBe(true);
  });
});

describe('desktop 0.1.x and old clients', () => {
  it('see rules version 4 on a market day and are refused cleanly, writing no score', async () => {
    time = at(EPOCH);
    const daily = await call('/daily');
    expect(daily.json).toMatchObject({ date: EPOCH, rulesVersion: 4 });
    const token = await login('old');
    const old = await call('/daily/submit', { token, body: { date: EPOCH, rulesVersion: 3, actions: SELLS_CARROTS } });
    expect(old.status).toBe(409);
    expect(old.json.error).toBe('This day uses rules version 4. Update Tendril.');
    const modern = await enter(dayId(EPOCH), SELLS_CARROTS, 'old', 3);
    expect(modern.status).toBe(409);
    expect(modern.json.error).toBe('This day uses rules version 4. Update Tendril.');
    expect(await db.query('SELECT 1 FROM entries WHERE challenge_id = ?', [dayId(EPOCH)])).toEqual([]);
  });

  it('keep working on a v3 day, and a v4 client cannot submit a v3 day as v4', async () => {
    time = at(BEFORE);
    expect((await call('/daily')).json.rulesVersion).toBe(3);
    const token = await login('old');
    expect((await call('/daily/submit', { token, body: { date: BEFORE, rulesVersion: 3, actions: SELLS_CARROTS } })).status).toBe(200);
    const wrong = await enter(dayId(BEFORE), SELLS_CARROTS, 'new', 4);
    expect(wrong.status).toBe(409);
    expect(wrong.json.error).toBe('Rules version mismatch');
  });

  it('endless farms and seasons stay on rules v3 for everyone', async () => {
    time = at(EPOCH);
    const season = (await call('/challenges/week')).json;
    expect(season).toMatchObject({ kind: 'season', rulesVersion: 3, market: null });
    expect(RULES_VERSION).toBe(4);
    const token = await login('farmer');
    const farm = await call('/farms', { token, body: {} });
    expect(farm.status).toBeLessThan(300);
    expect(farm.json.rulesVersion).toBe(3);
  });
});

describe('duels', () => {
  it('copy the version and table of the market daily they are made from, and are v3 otherwise', async () => {
    await crowd(EPOCH, 10, 4);
    time = at(AFTER);
    const daily = (await call(`/challenges/${dayId(AFTER)}`)).json;
    const token = await login('ann');
    const made = await call('/duels', { token, body: { seed: daily.seed, ticks: daily.ticks, from: dayId(AFTER) } });
    expect(made.status).toBe(201);
    const duel = (await call(`/challenges/${made.json.challengeId}`)).json;
    expect(duel).toMatchObject({ kind: 'duel', rulesVersion: 4, seed: daily.seed });
    expect(duel.market).toEqual(daily.market);
    expect((await enter(made.json.challengeId, SELLS_CARROTS, 'ann', 4)).status).toBe(200);
    expect((await enter(made.json.challengeId, SELLS_CARROTS, 'bo', 3)).status).toBe(409);
    // without `from` a duel is plain v3, and a bad source is refused
    const plain = await call('/duels', { token, body: { seed: daily.seed, ticks: 3000 } });
    expect((await call(`/challenges/${plain.json.challengeId}`)).json).toMatchObject({ rulesVersion: 3, market: null });
    expect((await call('/duels', { token, body: { seed: daily.seed + 1, ticks: 3000, from: dayId(AFTER) } })).status).toBe(422);
    expect((await call('/duels', { token, body: { seed: 5, ticks: 3000, from: 'd-2030-01-01' } })).status).toBe(404);
    expect((await call('/duels', { token, body: { seed: 5, ticks: 3000, from: 'x-abcdefgh' } })).status).toBe(422);
  });
});

describe('the entry replay carries the table', () => {
  it('a stored market run replays to the same net worth from the API alone', async () => {
    time = at(EPOCH);
    const id = dayId(EPOCH);
    const r = await enter(id, SELLS_CARROTS, 'ann', 4);
    time = at(AFTER, 13); // legacy grace over: the epoch day is settled
    const entryId = r.json.entryId as string;
    const rep = await call(`/entries/${entryId}/replay`, { token: await login('ann') });
    expect(rep.status).toBe(200);
    expect(rep.json).toMatchObject({ rulesVersion: 4, market: { prices: baseMarket().p } });
    const world = createWorld({ id, seed: rep.json.seed }, challengeSetup(rep.json.kind, rep.json.seed, rep.json.setupVersion, { p: rep.json.market.prices }).setup);
    expect(replayWithPar(world, rep.json.actions, rep.json.ticks, 0).netWorth).toBe(r.json.netWorth);
    expect(MARKET_EPOCH).toBe(EPOCH);
  });
});
