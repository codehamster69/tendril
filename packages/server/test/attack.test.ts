// Adversarial tests for the Tendril server. Every test is an attack that must FAIL to cheat.
// Everything runs in-process against :memory: databases with an injected clock; there is no network.
// Findings that currently succeed are kept as `it.fails('VULN: ...')` so the suite documents them and
// flips red the day they are fixed. See brain/notes/ATTACK1.md for the written report.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorld, dailySeed, DAILY_TICKS, deserialize, hashWorld, netWorth, replayChunk, RULES_VERSION, serialize } from '@tendril/sim/src/index.ts';
import type { LogEntry, World } from '@tendril/sim/src/index.ts';
import { addPlot } from '@tendril/sim/src/tiles.ts';
import { createApp, createDb } from '../src/index.ts';
import type { Db, FarmResponse, FetchFn, Profile } from '../src/index.ts';
import { DAY_MS, HOUR_MS } from '../src/game.ts';
import { MAX_BODY_BYTES } from '../src/validation.ts';

type Login = { token: string; profile: Profile };
type Accepted = { tick: number; checkpointHash: string; netWorth: number; rank: number };
type Env = Record<string, string | undefined>;
type Reply = { status: number; headers: Headers; text: string; json: any; ms: number }; // eslint-disable-line @typescript-eslint/no-explicit-any
type Opts = { method?: string; token?: string; body?: unknown; raw?: string | Uint8Array; headers?: Record<string, string>; cookie?: string; csrf?: boolean; contentType?: string | null };

const BASE = Date.UTC(2026, 10, 12, 12, 0, 0);
const ORIGIN = 'https://tendril.example';
const MAX = Number.MAX_SAFE_INTEGER;
const timings: Record<string, number> = {};

let db: Db;
let app: (request: Request) => Promise<Response>;
let time: number;
let env: Env;
let user: Login;
let farm: FarmResponse;

const noNetwork: FetchFn = () => { throw new Error('network is forbidden in attack tests'); };
function makeApp(): void { app = createApp({ db, env, fetch: noNetwork, now: () => time }); }

/** Low-level call. `path` is the full path including `/api` so odd paths can be probed verbatim. */
async function send(path: string, o: Opts = {}): Promise<Reply> {
  const headers = new Headers(o.headers);
  if (o.token) headers.set('Authorization', `Bearer ${o.token}`);
  if (o.cookie) headers.set('Cookie', o.cookie);
  if (o.csrf) headers.set('X-Tendril-Client', '1');
  const hasBody = o.body !== undefined || o.raw !== undefined;
  if (hasBody && o.contentType !== null) headers.set('Content-Type', o.contentType ?? 'application/json');
  const body = o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined);
  const started = performance.now();
  const response = await app(new Request(`http://localhost:8787${path}`, { method: o.method ?? (hasBody ? 'POST' : 'GET'), headers, body: body as BodyInit | undefined }));
  const ms = performance.now() - started;
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, headers: response.headers, text, json, ms };
}
const api = (path: string, o: Opts = {}): Promise<Reply> => send(`/api${path}`, o);

async function login(name = 'Farmer'): Promise<Login> {
  const r = await api('/dev/login', { body: { displayName: name } });
  expect(r.status).toBe(201);
  return r.json as Login;
}
async function newPlayer(name = 'Player'): Promise<{ user: Login; farm: FarmResponse }> {
  const u = await login(name);
  const r = await api('/farms', { token: u.token, body: {} });
  expect(r.status).toBe(201);
  return { user: u, farm: r.json as FarmResponse };
}
const myFarm = async (token = user.token): Promise<FarmResponse> => (await api('/farms/me', { token })).json as FarmResponse;

function chunkBody(actions: unknown = [], toTick = 100, source: FarmResponse = farm): Record<string, unknown> {
  return { fromTick: source.tick, toTick, actions, rulesVersion: source.rulesVersion, checkpointHash: source.checkpointHash };
}
const submit = (body: unknown, token = user.token, id = farm.id, extra: Opts = {}): Promise<Reply> =>
  api(`/farms/${id}/chunks`, typeof body === 'string' ? { token, raw: body, ...extra } : { token, body, ...extra });

/** Everything an attacker could hope to change, serialised so that "unchanged" means byte for byte. */
async function snapshot(): Promise<string> {
  return JSON.stringify({
    farm: (await api('/farms/me', { token: user.token })).text,
    farms: await db.query('SELECT * FROM farms ORDER BY id'),
    chunks: await db.query('SELECT * FROM chunks ORDER BY farm_id, from_tick'),
    history: await db.query('SELECT * FROM worth_history ORDER BY id'),
    daily: await db.query('SELECT * FROM daily_entries ORDER BY date, user_id'),
    board: (await api('/leaderboard?limit=100')).text,
  });
}
async function expectRejected(body: unknown, status: number | number[], run: () => Promise<Reply> = () => submit(body)): Promise<Reply> {
  const before = await snapshot();
  const r = await run();
  expect(Array.isArray(status) ? status : [status]).toContain(r.status);
  expect(r.json).toEqual({ error: expect.any(String) });
  expect(r.text).not.toMatch(/\bat .*\.(ts|js):\d+/); // no stack traces
  expect(await snapshot()).toBe(before);
  return r;
}

/** What an honest replay of the stored checkpoint plus these actions gives. */
function expected(source: FarmResponse, actions: LogEntry[], toTick: number): { hash: string; worth: number; world: World } {
  const world = deserialize(source.checkpoint);
  replayChunk(world, actions, toTick);
  return { hash: hashWorld(world), worth: netWorth(world), world };
}

/** Overwrites the stored checkpoint with a crafted world. Only reachable by tampering with the database. */
async function seedCheckpoint(world: World, id = farm.id): Promise<FarmResponse> {
  await db.execute('UPDATE farms SET tick = ?, checkpoint = ?, checkpoint_hash = ?, coins = ?, net_worth = ? WHERE id = ?', [world.tick, serialize(world), hashWorld(world), world.coins, netWorth(world), id]);
  return await myFarm();
}
const freshWorld = (): World => createWorld({ id: farm.id, seed: farm.seed });

// A legal 400 tick game: move east, till, plant carrots, water twice, harvest, walk home, deposit, sell. Earns coins.
const GOOD: LogEntry[] = [[0, 0, 0, 1], [2, 0, 1], [5, 0, 2, 1], [7, 0, 3], [9, 0, 3], [300, 0, 4], [303, 0, 0, 3], [305, 0, 5], [306, 0, 8, 1, 4]];
const GOOD_TO = 400;
const waits = (n: number): LogEntry[] => Array.from({ length: n }, (_, t): LogEntry => [t, 0, 7, 1]);

beforeEach(async () => {
  db = createDb({ url: ':memory:' });
  time = BASE;
  env = { TENDRIL_DEV_AUTH: '1', GITHUB_CLIENT_ID: 'client-id', GITHUB_CLIENT_SECRET: 'client-secret-value', PUBLIC_ORIGIN: ORIGIN };
  makeApp();
  user = await login();
  const r = await api('/farms', { token: user.token, body: {} });
  expect(r.status).toBe(201);
  farm = r.json as FarmResponse;
  time += 2_000_000; // 20,000 ticks of real time have elapsed
});
afterEach(() => { db.close(); });

// ---------------------------------------------------------------------------------------------------
describe('1. score forgery', () => {
  it('sanity: GOOD earns coins and the server agrees with an independent replay', async () => {
    const want = expected(farm, GOOD, GOOD_TO);
    expect(want.worth).toBeGreaterThan(0);
    const r = await submit(chunkBody(GOOD, GOOD_TO));
    expect(r.status).toBe(200);
    const got = r.json as Accepted;
    expect(got.netWorth).toBe(want.worth);
    expect(got.checkpointHash).toBe(want.hash);
    const stored = await myFarm();
    expect(stored.netWorth).toBe(want.worth);
    expect(stored.coins).toBe(want.world.coins);
    expect(stored.checkpoint).toBe(serialize(want.world));
  });

  it.each([
    ['netWorth', { netWorth: 1_000_000_000 }],
    ['coins', { coins: 1_000_000_000 }],
    ['hash', { hash: 'deadbeef' }],
    ['checkpoint', { checkpoint: '{"coins":999999999}' }],
    ['spent', { spent: 999999 }],
    ['stock', { stock: [0, 99, 99] }],
    ['__proto__', JSON.parse('{"__proto__":{"netWorth":999999}}') as object],
    ['all of them', { netWorth: 1e9, coins: 1e9, hash: 'deadbeef', checkpoint: 'x' }],
  ])('extra field %s is ignored or rejected, never stored', async (_name, extra) => {
    const raw = JSON.stringify({ ...chunkBody(GOOD, GOOD_TO), ...extra }).replace(/}$/, Object.prototype.hasOwnProperty.call(extra, '__proto__') ? ',"__proto__":{"netWorth":999999}}' : '}');
    const want = expected(farm, GOOD, GOOD_TO);
    const r = await submit(raw);
    if (r.status === 200) {
      expect((r.json as Accepted).netWorth).toBe(want.worth);
    } else {
      expect(r.status).toBe(422);
    }
    const stored = await myFarm();
    expect(stored.netWorth === want.worth || stored.netWorth === 0).toBe(true);
    expect(stored.netWorth).toBeLessThan(1_000_000);
    expect(stored.coins).toBeLessThan(1_000_000);
    const rows = await db.query<{ net_worth: number }>('SELECT net_worth FROM worth_history');
    expect(rows.every((row) => row.net_worth < 1_000_000)).toBe(true);
    // A clean follow-up is still accepted and scored by replay alone.
    if (r.status !== 200) {
      const ok = await submit(chunkBody(GOOD, GOOD_TO));
      expect(ok.status).toBe(200);
      expect((ok.json as Accepted).netWorth).toBe(want.worth);
    }
  });

  it('a forged checkpointHash for a different state is a 409', async () => {
    for (const hash of ['00000000', 'ffffffff', 'DEADBEEF', farm.checkpointHash.toUpperCase() === farm.checkpointHash ? 'zzzzzzzz' : farm.checkpointHash.toUpperCase()]) {
      const r = await submit({ ...chunkBody(GOOD, GOOD_TO), checkpointHash: hash });
      expect([409, 422]).toContain(r.status);
    }
    expect((await myFarm()).netWorth).toBe(0);
  });

  it('cannot claim a better farm state via POST /farms or /farms/me', async () => {
    expect((await api('/farms', { token: user.token, body: { coins: 1e9, netWorth: 1e9, checkpoint: 'x' } })).status).toBe(400);
    expect((await api('/farms/me', { token: user.token, method: 'POST', body: { netWorth: 1e9 } })).status).toBe(404);
    expect((await myFarm()).netWorth).toBe(0);
  });

  it('leaderboard shows exactly the replayed worth', async () => {
    const want = expected(farm, GOOD, GOOD_TO);
    expect((await submit(chunkBody(GOOD, GOOD_TO))).status).toBe(200);
    const board = (await api('/leaderboard')).json as { entries: { netWorth: number; farmId: string }[] };
    expect(board.entries.map((e) => [e.farmId, e.netWorth])).toEqual([[farm.id, want.worth]]);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('2. time travel', () => {
  it('toTick one past floor((now - startedAt) / 100) is refused, the boundary is accepted', async () => {
    time = BASE + 5_050; // 50 whole ticks have elapsed
    await expectRejected(chunkBody([], 51), 422);
    expect((await submit(chunkBody([], 50))).status).toBe(200);
  });

  it('a clock before startedAt allows nothing', async () => {
    time = BASE - 1;
    await expectRejected(chunkBody([], 1), 422);
  });

  it('an action may not hide beyond the allowed tick by sitting at toTick - 1 of an oversized chunk', async () => {
    time = BASE + 1_000; // 10 ticks
    await expectRejected(chunkBody([[500, 0, 7, 1]], 600), 422);
    await expectRejected(chunkBody([[11, 0, 7, 1]], 11), 422);
  });

  it('chunk ranges are bounded: more than 20,000 ticks is a 413 even when the clock allows it', async () => {
    time = BASE + 10_000_000;
    await expectRejected(chunkBody([], 20_001), 413);
    expect((await submit(chunkBody([], 20_000))).status).toBe(200);
  });

  it.each([
    ['fromTick ahead (gap)', { fromTick: 5 }, 409],
    ['fromTick negative', { fromTick: -1 }, 422],
    ['fromTick fractional', { fromTick: 0.5 }, 422],
    ['fromTick string', { fromTick: '0' }, 422],
    ['fromTick null', { fromTick: null }, 422],
    ['fromTick missing', { fromTick: undefined }, 422],
    ['fromTick 1e308', { fromTick: 1e308 }, 422],
    ['fromTick MAX_SAFE (>= toTick)', { fromTick: MAX }, 422],
    ['toTick equal fromTick', { toTick: 0 }, 422],
    ['toTick negative', { toTick: -100 }, 422],
    ['toTick fractional', { toTick: 100.5 }, 422],
    ['toTick string', { toTick: '100' }, 422],
    ['toTick null', { toTick: null }, 422],
    ['toTick 1e308', { toTick: 1e308 }, 422],
    ['toTick MAX_SAFE', { toTick: MAX }, 413],
    ['toTick array', { toTick: [100] }, 422],
    ['toTick object', { toTick: { valueOf: 100 } }, 422],
    ['toTick true', { toTick: true }, 422],
    ['rulesVersion 2', { rulesVersion: 2 }, 409],
    ['rulesVersion 4', { rulesVersion: 4 }, 409],
    ['rulesVersion string', { rulesVersion: '3' }, 422],
    ['rulesVersion 3.0000001', { rulesVersion: 3.0000001 }, 422],
  ] as [string, Record<string, unknown>, number][])('%s', async (_name, patch, status) => {
    await expectRejected({ ...chunkBody([], 100), ...patch }, status);
  });

  it.each([
    ['NaN', '{"fromTick":NaN,"toTick":100,"actions":[],"rulesVersion":3,"checkpointHash":"%H"}', 400],
    ['Infinity', '{"fromTick":0,"toTick":Infinity,"actions":[],"rulesVersion":3,"checkpointHash":"%H"}', 400],
    ['2^53', '{"fromTick":0,"toTick":9007199254740992,"actions":[],"rulesVersion":3,"checkpointHash":"%H"}', 422],
    ['2^53+1 literal', '{"fromTick":0,"toTick":9007199254740993,"actions":[],"rulesVersion":3,"checkpointHash":"%H"}', 422],
    ['1e308 literal', '{"fromTick":0,"toTick":1e308,"actions":[],"rulesVersion":3,"checkpointHash":"%H"}', 422],
    ['1e400 literal (parses to Infinity)', '{"fromTick":0,"toTick":1e400,"actions":[],"rulesVersion":3,"checkpointHash":"%H"}', 422],
    ['exponent form 1e2', '{"fromTick":0,"toTick":1e2,"actions":[],"rulesVersion":3,"checkpointHash":"%H"}', 200],
    ['negative zero fromTick', '{"fromTick":-0,"toTick":100,"actions":[],"rulesVersion":3,"checkpointHash":"%H"}', 200],
    ['leading zeros', '{"fromTick":00,"toTick":100,"actions":[],"rulesVersion":3,"checkpointHash":"%H"}', 400],
  ] as [string, string, number][])('raw JSON %s', async (_name, template, status) => {
    const raw = template.replace('%H', farm.checkpointHash);
    if (status === 200) {
      expect((await submit(raw)).status).toBe(200);
    } else {
      await expectRejected(raw, status);
    }
  });

  it('overlap, gap and replay of an accepted chunk are all 409, and the state stays at the first chunk', async () => {
    const first = await submit(chunkBody(GOOD, GOOD_TO));
    expect(first.status).toBe(200);
    const after = await myFarm();
    expect(after.tick).toBe(GOOD_TO);
    // exact replay of the accepted request (double-counting the sell)
    await expectRejected(chunkBody(GOOD, GOOD_TO), 409);
    // replay with the old hash, shifted forward
    await expectRejected({ ...chunkBody([], GOOD_TO + 100, farm), fromTick: GOOD_TO }, 409);
    // overlap: starts before the checkpoint
    await expectRejected({ ...chunkBody([], GOOD_TO + 100, after), fromTick: GOOD_TO - 100 }, 409);
    // gap: skips ahead of the checkpoint
    await expectRejected({ ...chunkBody([], GOOD_TO + 200, after), fromTick: GOOD_TO + 100 }, 409);
  });

  it('a rate limit does not let an old chunk re-apply after time passes', async () => {
    expect((await submit(chunkBody(GOOD, GOOD_TO))).status).toBe(200);
    time += 2 * HOUR_MS;
    const before = await snapshot();
    expect((await submit(chunkBody(GOOD, GOOD_TO))).status).toBe(409);
    expect(await snapshot()).toBe(before);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('3. illegal moves hidden among legal ones', () => {
  const legal: LogEntry[] = [[0, 0, 0, 1], [2, 0, 1]]; // move east, till: both legal

  const illegal: [string, unknown[]][] = [
    ['bot acting while busy', [[1, 0, 1]]],
    ['bot busy after wait', [[0, 0, 7, 50], [10, 0, 0, 1]]],
    ['bot index out of range', [[5, 5, 3]]],
    ['bot index 1 with a single bot', [[5, 1, 3]]],
    ['bot index -1 on a bot op', [[5, -1, 3]]],
    ['bot index -2', [[5, -2, 3]]],
    ['bot index huge', [[5, MAX, 3]]],
    ['bot index 2^53 (unsafe)', [[5, 2 ** 53, 3]]],
    ['bot op with farm bot (-1) on plant', [[5, -1, 2, 1]]],
    ['farm op with a real bot (buyBot)', [[5, 0, 10]]],
    ['farm op with a real bot (buyPlot)', [[5, 0, 9, 1, 0]]],
    ['unknown op 16', [[5, 0, 16]]],
    ['unknown op 99', [[5, 0, 99]]],
    ['unknown op -1', [[5, 0, -1]]],
    ['direction 4', [[5, 0, 0, 4]]],
    ['direction -1', [[5, 0, 0, -1]]],
    ['crop 99', [[5, 0, 2, 99]]],
    ['crop 0', [[5, 0, 2, 0]]],
    ['wait 0', [[5, 0, 7, 0]]],
    ['wait 1001', [[5, 0, 7, 1001]]],
    ['wait negative', [[5, 0, 7, -5]]],
    ['wait missing arg', [[5, 0, 7]]],
    ['sell 0 units', [[5, 0, 8, 1, 0]]],
    ['sell negative units', [[5, 0, 8, 1, -4]]],
    ['sell unsafe units 2^53', [[5, 0, 8, 1, 2 ** 53]]],
    ['sell item 0', [[5, 0, 8, 0, 1]]],
    ['sell item 99', [[5, 0, 8, 99, 1]]],
    ['sell item negative', [[5, 0, 8, -1, 1]]],
    ['sell missing units', [[5, 0, 8, 1]]],
    ['deliver order id 0', [[5, 0, 6, 0]]],
    ['deliver negative order id', [[5, 0, 6, -1]]],
    ['buyPlot coordinate beyond 1e9', [[5, -1, 9, 2_000_000_000, 0]]],
    ['buyPlot missing y', [[5, -1, 9, 1]]],
    ['actions out of tick order', [[20, 0, 7, 1], [10, 0, 7, 1]]],
    ['action before the chunk start', [[-1, 0, 7, 1]]],
    ['action at toTick', [[100, 0, 7, 1]]],
    ['action beyond toTick', [[101, 0, 7, 1]]],
    ['not arrays: object', [{ 0: 5, 1: 0, 2: 7, 3: 1 }]],
    ['not arrays: number', [5]],
    ['not arrays: null', [null]],
    ['not arrays: string', ['5,0,7,1']],
    ['not arrays: boolean', [true]],
    ['empty entry', [[]]],
    ['too short', [[5, 0]]],
    ['extra element on 4-long op', [[5, 0, 7, 1, 2]]],
    ['extra element on 3-long op', [[5, 0, 3, 1]]],
    ['extra element on sell', [[5, 0, 8, 1, 1, 1]]],
    ['trailing undefined/null', [[5, 0, 3, null]]],
    ['float tick', [[5.5, 0, 3]]],
    ['float bot', [[5, 0.5, 3]]],
    ['float op', [[5, 0, 3.5]]],
    ['float arg', [[5, 0, 7, 1.5]]],
    ['string tick', [['5', 0, 3]]],
    ['string bot', [[5, '0', 3]]],
    ['string op', [[5, 0, '3']]],
    ['string arg', [[5, 0, 7, '1']]],
    ['null tick', [[null, 0, 3]]],
    ['null op', [[5, 0, null]]],
    ['nested array as tick', [[[5], 0, 3]]],
    ['nested array as arg', [[5, 0, 7, [1]]]],
    ['nested entry', [[[5, 0, 3]]]],
    ['boolean fields', [[5, 0, true]]],
    ['1e308 field', [[5, 0, 7, 1e308]]],
    ['NaN becomes null', [[5, 0, 7, Number.NaN]]],
    ['__proto__ object entry', [JSON.parse('{"__proto__":[5,0,3]}') as object]],
    ['array with __proto__-like object element', [[5, 0, 7, JSON.parse('{"__proto__":1}') as object]]],
  ];

  it.each(illegal)('%s is rejected whole (legal moves around it are not applied)', async (_name, bad) => {
    const before = await snapshot();
    const r = await submit(chunkBody([...legal, ...bad], 100));
    expect([413, 422]).toContain(r.status);
    expect(r.json).toEqual({ error: expect.any(String) });
    expect(await snapshot()).toBe(before);
    expect((await myFarm()).tick).toBe(0);
  });

  it('an illegal move after a rejected prefix cannot be smuggled in a later chunk', async () => {
    await expectRejected(chunkBody([...legal, [1, 0, 1]], 100), 422);
    expect((await submit(chunkBody(legal, 100))).status).toBe(200);
  });

  it('buying a non-adjacent plot is a legal result 0 and grants nothing', async () => {
    const r = await submit(chunkBody([[0, -1, 9, 5, 5], [0, -1, 9, 0, 0], [0, -1, 9, -3, 7]], 50));
    expect(r.status).toBe(200);
    const world = deserialize((await myFarm()).checkpoint);
    expect(world.plots).toHaveLength(1);
    expect(world.coins + world.spent).toBe(0);
    expect((r.json as Accepted).netWorth).toBe(0);
  });

  it('buying with too few coins (plot, bot) is a legal result 0 that grants nothing', async () => {
    const r = await submit(chunkBody([[0, -1, 9, 1, 0], [0, -1, 10], [0, -1, 10], [0, -1, 9, 0, 1]], 50));
    expect(r.status).toBe(200);
    const world = deserialize((await myFarm()).checkpoint);
    expect(world.plots).toHaveLength(1);
    expect(world.bots).toHaveLength(1);
    expect(world.coins).toBe(0);
    expect(world.spent).toBe(0);
  });

  it('a bot cannot be spawned for free by buyBot with coins below the price', async () => {
    const poor = await seedCheckpoint(Object.assign(freshWorld(), { coins: 79 }));
    const r = await submit(chunkBody([[0, -1, 10]], 10, poor));
    expect(r.status).toBe(200);
    expect(deserialize((await myFarm()).checkpoint).bots).toHaveLength(1);
  });

  it('with the exact coins the purchase works, and net worth does not inflate (spent counts)', async () => {
    const rich = await seedCheckpoint(Object.assign(freshWorld(), { coins: 80 }));
    const r = await submit(chunkBody([[0, -1, 10]], 10, rich));
    expect(r.status).toBe(200);
    expect((r.json as Accepted).netWorth).toBe(80);
    expect(deserialize((await myFarm()).checkpoint).bots).toHaveLength(2);
  });

  it('selling more than the stock, or from a tile that is not the barn, is result 0 and grants nothing', async () => {
    const r = await submit(chunkBody([[0, 0, 8, 1, 5], [1, 0, 0, 1], [3, 0, 8, 1, 1], [4, 0, 6, 1]], 50));
    expect(r.status).toBe(200);
    expect(deserialize((await myFarm()).checkpoint).coins).toBe(0);
  });

  // The server's validation is STRICTER than the sim spec. That cannot inflate a score, but it rejects moves the
  // rules call legal. Kept as documented findings (see report, finding F1/F2).
  it('FIXED(F1, functional): legal ops 11..15 (build, clear, compost, fertilize, unlock) are accepted', async () => {
    // Each entry is submitted alone on a fresh farm (one bot can start only one action per tick).
    for (const entry of [[0, -1, 15, 1], [0, 0, 11, 1], [0, 0, 12], [0, 0, 13], [0, 0, 14]]) {
      const player = await newPlayer();
      time += 1000; // 10 ticks of game time, so toTick 5 is not ahead of the clock
      const r = await submit(chunkBody([entry], 5, player.farm), player.user.token, player.farm.id);
      expect(r.status).toBe(200);
    }
  });
  it('FIXED(F2, functional): legal plant crops 5..6 and sell items 5..7 (berry, apple, honey) are accepted', async () => {
    for (const entry of [[0, 0, 2, 5], [0, 0, 2, 6], [0, 0, 8, 5, 1], [0, 0, 8, 6, 1], [0, 0, 8, 7, 1]]) {
      const player = await newPlayer();
      time += 1000; // 10 ticks of game time, so toTick 5 is not ahead of the clock
      const r = await submit(chunkBody([entry], 5, player.farm), player.user.token, player.farm.id);
      expect(r.status).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
describe('4. rejected chunks leave no trace', () => {
  const bads: [string, () => unknown][] = [
    ['stale hash', () => ({ ...chunkBody(GOOD, GOOD_TO), checkpointHash: '12345678' })],
    ['future toTick', () => chunkBody(GOOD, 50_000)],
    ['illegal action at the end of a long legal run', () => chunkBody([...GOOD, [307, 0, 0, 9]], GOOD_TO)],
    ['illegal action in the middle (busy bot)', () => chunkBody([[0, 0, 0, 1], [1, 0, 1], ...GOOD.slice(1)], GOOD_TO)],
    ['out of order', () => chunkBody([GOOD[5], GOOD[1]], GOOD_TO)],
    ['extra field', () => ({ ...chunkBody(GOOD, GOOD_TO), netWorth: 9 })],
    ['gap', () => ({ ...chunkBody(GOOD, GOOD_TO + 100), fromTick: 100 })],
    ['not JSON', () => '{"fromTick":'],
    ['unsupported rules version', () => ({ ...chunkBody(GOOD, GOOD_TO), rulesVersion: 99 })],
  ];

  it.each(bads)('%s: state is byte-for-byte unchanged and the next valid chunk is still accepted', async (_name, make) => {
    const before = await snapshot();
    const r = await submit(make() as never);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(await snapshot()).toBe(before);
    const stored = await myFarm();
    expect(stored.tick).toBe(0);
    expect(stored.checkpoint).toBe(farm.checkpoint);
    expect(stored.checkpointHash).toBe(farm.checkpointHash);
    expect(stored.netWorth).toBe(0);
    const ok = await submit(chunkBody(GOOD, GOOD_TO));
    expect(ok.status).toBe(200);
    expect((ok.json as Accepted).netWorth).toBe(expected(farm, GOOD, GOOD_TO).worth);
  });

  it('a failing chunk after a good one keeps the good checkpoint exactly', async () => {
    expect((await submit(chunkBody(GOOD, GOOD_TO))).status).toBe(200);
    const good = await myFarm();
    const before = await snapshot();
    const r = await submit(chunkBody([[GOOD_TO, 0, 8, 1, MAX], [GOOD_TO + 1, 0, 3, 1]], GOOD_TO + 50, good));
    expect(r.status).toBe(422);
    expect(await snapshot()).toBe(before);
    expect((await myFarm()).checkpoint).toBe(good.checkpoint);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('5. resource exhaustion', () => {
  it('20,001 actions is a 413 and nothing is stored', async () => {
    const t0 = performance.now();
    const r = await expectRejected(chunkBody(waits(20_001), 20_000), 413);
    timings['20,001 actions (413)'] = Math.round(performance.now() - t0);
    expect(r.ms).toBeLessThan(2000);
  });

  it('a body one byte over 2 MB is a 413, a body exactly 2 MB is parsed', async () => {
    const json = JSON.stringify(chunkBody([], 100));
    const over = json + ' '.repeat(MAX_BODY_BYTES + 1 - json.length);
    expect(over.length).toBe(MAX_BODY_BYTES + 1);
    const t0 = performance.now();
    await expectRejected(over, 413);
    timings['2 MB + 1 body (413)'] = Math.round(performance.now() - t0);
    const exact = json + ' '.repeat(MAX_BODY_BYTES - json.length);
    expect((await submit(exact)).status).toBe(200);
  });

  it('a Content-Length header over the cap is refused before reading, a lying one is harmless', async () => {
    const huge = await submit(chunkBody([], 100), user.token, farm.id, { headers: { 'Content-Length': String(MAX_BODY_BYTES + 1) } });
    expect(huge.status).toBe(413);
    const junk = await submit(chunkBody([], 100), user.token, farm.id, { headers: { 'Content-Length': '-5' } });
    expect(junk.status).toBe(400);
    const nan = await submit(chunkBody([], 100), user.token, farm.id, { headers: { 'Content-Length': '12abc' } });
    expect(nan.status).toBe(400);
    expect((await myFarm()).tick).toBe(0);
  });

  it.each([
    ['100k nested arrays', () => '['.repeat(100_000) + ']'.repeat(100_000)],
    ['500k nested arrays (just under 1 MB)', () => '['.repeat(500_000) + ']'.repeat(500_000)],
    ['nested arrays inside actions', () => `{"fromTick":0,"toTick":100,"rulesVersion":3,"checkpointHash":"${farm.checkpointHash}","actions":${'['.repeat(200_000)}${']'.repeat(200_000)}}`],
    ['nested objects', () => '{"a":'.repeat(100_000) + '1' + '}'.repeat(100_000)],
    ['unterminated nesting', () => '['.repeat(1_000_000)],
    ['2 MB of digits', () => '1'.repeat(MAX_BODY_BYTES)],
    ['huge string', () => `"${'a'.repeat(MAX_BODY_BYTES - 2)}"`],
  ])('deeply nested / pathological JSON: %s', async (_name, make) => {
    const before = await snapshot();
    const r = await submit(make());
    expect([400, 413, 422]).toContain(r.status);
    expect(r.ms).toBeLessThan(2000);
    expect(await snapshot()).toBe(before);
    timings[`pathological JSON: ${_name}`] = Math.round(r.ms);
  });

  it('invalid UTF-8 is a 400; a BOM is harmless', async () => {
    const before = await snapshot();
    expect((await api(`/farms/${farm.id}/chunks`, { token: user.token, raw: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]) })).status).toBe(400);
    expect(await snapshot()).toBe(before);
    // A UTF-8 BOM is stripped by the decoder: benign, same object as without it.
    expect((await submit('\uFEFF' + JSON.stringify(chunkBody([], 100)))).status).toBe(200);
  });

  it('20,000 valid wait entries over 20,000 ticks verify in under 2 seconds', async () => {
    const actions = waits(20_000);
    const body = JSON.stringify(chunkBody(actions, 20_000));
    expect(body.length).toBeLessThan(MAX_BODY_BYTES);
    const want = expected(farm, actions, 20_000);
    const r = await submit(body);
    timings['20,000 waits / 20,000 ticks, small farm (HTTP round trip)'] = Math.round(r.ms);
    expect(r.status).toBe(200);
    expect(r.ms).toBeLessThan(2000);
    expect((r.json as Accepted).checkpointHash).toBe(want.hash);
    expect((r.json as Accepted).tick).toBe(20_000);
  });

  it('a maximum 20,000 tick chunk on a farm with 1,024 plots verifies in under 2 seconds', async () => {
    const world = freshWorld();
    for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) if (x !== 0 || y !== 0) addPlot(world, x, y);
    expect(world.plots).toHaveLength(1024);
    const big = await seedCheckpoint(world);
    timings['seeded 1,024 plot checkpoint size (bytes)'] = big.checkpoint.length;
    const actions = waits(20_000);
    const r = await submit(chunkBody(actions, 20_000, big));
    timings['20,000 waits / 20,000 ticks, 1,024 plots (HTTP round trip)'] = Math.round(r.ms);
    expect(r.status).toBe(200);
    expect(r.ms).toBeLessThan(2000);
  });

  it('serving the big checkpoint back does not blow up either (GET /farms/me)', async () => {
    const world = freshWorld();
    for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) if (x !== 0 || y !== 0) addPlot(world, x, y);
    await seedCheckpoint(world);
    const r = await api('/farms/me', { token: user.token });
    timings['GET /farms/me with 1,024 plots'] = Math.round(r.ms);
    expect(r.status).toBe(200);
    expect(r.ms).toBeLessThan(2000);
  });

  it('daily replay with many actions finishes quickly', async () => {
    const actions = waits(DAILY_TICKS);
    const r = await api('/daily/submit', { token: user.token, body: { date: '2026-11-12', rulesVersion: RULES_VERSION, actions } });
    timings['daily 3,000 waits'] = Math.round(r.ms);
    expect(r.status).toBe(200);
    expect(r.ms).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('6. overflow', () => {
  it('selling and delivering with extreme args cannot mint coins', async () => {
    const r = await submit(chunkBody([
      [0, 0, 8, 1, MAX], [0, 0, 8, 7, MAX], [1, 0, 8, 3, 1], [2, 0, 6, MAX], [3, 0, 6, 1],
    ], 50));
    // Either a legal result 0 (accepted) or a rejection; never a gain.
    expect([200, 422]).toContain(r.status);
    const stored = await myFarm();
    expect(stored.coins).toBe(0);
    expect(stored.netWorth).toBe(0);
  });

  it('the largest legal args at the type limits are all result 0', async () => {
    const entries: unknown[] = [[0, 0, 8, 1, MAX], [1, 0, 6, MAX], [2, 0, 9, 1_000_000_000, 1_000_000_000]];
    // The third is a farm op with bot 0 -> illegal; use -1.
    entries[2] = [2, -1, 9, 1_000_000_000, -1_000_000_000];
    const r = await submit(chunkBody(entries, 50));
    expect(r.status).toBe(200);
    expect((await myFarm()).coins).toBe(0);
  });

  it('(tampered DB) a delivery that would push coins past 2^53 is refused, not wrapped or rounded', async () => {
    const world = freshWorld();
    world.coins = MAX - 10;
    world.stock[3] = 1;
    world.orders.push({ id: 1, crop: 3, qty: 1, reward: 1_000_000, opensAt: 0, deadline: 100_000 });
    world.nextOrderAt = 1_000_000;
    const seeded = await seedCheckpoint(world);
    expect(seeded.netWorth).toBe(MAX - 9);
    await expectRejected(chunkBody([[0, 0, 6, 1]], 20, seeded), 422);
  });

  it('(tampered DB) a state whose net worth is already unsafe cannot be advanced and cannot out-rank the board', async () => {
    const world = freshWorld();
    world.coins = MAX - 1;
    world.stock[1] = 100; // worth 2 * 100 over the limit
    await seedCheckpoint(Object.assign(freshWorld(), { coins: 0 }));
    await db.execute('UPDATE farms SET checkpoint = ?, checkpoint_hash = ?, coins = ?, net_worth = 1 WHERE id = ?', [serialize(world), hashWorld(world), MAX - 1, farm.id]);
    const seeded = await myFarm();
    await expectRejected(chunkBody([], 20, seeded), 422);
  });

  it('(tampered DB) sell at the limit is accepted only while coins + spent + stock value stays a safe integer', async () => {
    const world = freshWorld();
    world.coins = MAX - 3;
    world.stock[3] = 3; // price 1 -> worth exactly MAX
    const seeded = await seedCheckpoint(world);
    const r = await submit(chunkBody([[0, 0, 8, 3, 3]], 20, seeded));
    expect(r.status).toBe(200);
    expect((r.json as Accepted).netWorth).toBe(MAX);
    expect(Number.isSafeInteger((r.json as Accepted).netWorth)).toBe(true);
  });

  it('spending cannot make `spent` wrap: buying with exactly the coins keeps coins + spent constant', async () => {
    const world = freshWorld();
    world.coins = 80 * 1 + 150;
    const seeded = await seedCheckpoint(world);
    const r = await submit(chunkBody([[0, -1, 10], [0, -1, 9, 1, 0]], 20, seeded));
    expect(r.status).toBe(200);
    expect((r.json as Accepted).netWorth).toBe(230);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('7. cross-user', () => {
  it("submitting to another user's farm id is 403, the victim is untouched and the attacker's quota is spent", async () => {
    const victim = await newPlayer('Victim');
    time += 2_000_000;
    const before = JSON.stringify(await db.query('SELECT * FROM farms WHERE id = ?', [victim.farm.id]));
    const r = await submit(chunkBody([], 100, victim.farm), user.token, victim.farm.id);
    expect(r.status).toBe(403);
    expect(JSON.stringify(await db.query('SELECT * FROM farms WHERE id = ?', [victim.farm.id]))).toBe(before);
    expect(await db.query('SELECT * FROM chunks WHERE farm_id = ?', [victim.farm.id])).toHaveLength(0);
    // and a bad guess at someone's farm id with a valid-looking body is a 404, not an oracle for chunk contents
    expect((await submit(chunkBody([], 100), user.token, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
    // the victim can still submit normally
    expect((await submit(chunkBody(GOOD, GOOD_TO, victim.farm), victim.user.token, victim.farm.id)).status).toBe(200);
  });

  it("an attacker cannot burn the victim's rate limit by spamming their farm id", async () => {
    const victim = await newPlayer('Victim2');
    time += 2_000_000;
    for (let i = 0; i < 10; i++) expect((await submit(chunkBody([], 100, victim.farm), user.token, victim.farm.id)).status).toBe(403);
    expect((await submit(chunkBody([], 100, victim.farm), user.token, victim.farm.id)).status).toBe(429);
    expect((await submit(chunkBody(GOOD, GOOD_TO, victim.farm), victim.user.token, victim.farm.id)).status).toBe(200);
  });

  it("no endpoint exposes another user's checkpoint, token hash or session", async () => {
    const victim = await newPlayer('Victim3');
    time += 2_000_000;
    expect((await submit(chunkBody(GOOD, GOOD_TO, victim.farm), victim.user.token, victim.farm.id)).status).toBe(200);
    const secret = (await myFarm(victim.user.token)).checkpoint;
    for (const path of [`/farms/${victim.farm.id}`, `/farms/${victim.farm.id}/checkpoint`, `/farms/${victim.farm.id}/chunks`, '/farms/me', '/me', `/users/${victim.user.profile.id}`, '/leaderboard?limit=100', '/leaderboard?board=growth', '/stats', `/farms/${victim.farm.id}/replay`]) {
      const r = await api(path, { token: user.token });
      expect(r.text).not.toContain(secret);
      expect(r.text).not.toContain(victim.user.token);
      expect(r.text).not.toMatch(/token_hash/);
    }
    // /farms/me with the attacker token is the attacker's farm
    expect(((await api('/farms/me', { token: user.token })).json as FarmResponse).id).toBe(farm.id);
    // no-auth access
    expect((await api('/farms/me')).status).toBe(401);
    expect((await api(`/farms/${victim.farm.id}/chunks`, { body: chunkBody([], 100, victim.farm) })).status).toBe(401);
  });

  it('replay is public by contract but only for verified farms, and exposes seed + actions, not the checkpoint', async () => {
    const victim = await newPlayer('Victim4');
    time += 2_000_000;
    expect((await api(`/farms/${victim.farm.id}/replay`)).status).toBe(404); // unverified farm
    expect((await submit(chunkBody(GOOD, GOOD_TO, victim.farm), victim.user.token, victim.farm.id)).status).toBe(200);
    const r = await api(`/farms/${victim.farm.id}/replay?limit=2`);
    expect(r.status).toBe(200);
    expect(Object.keys(r.json).sort()).toEqual(['chunks', 'nextFromTick', 'rulesVersion', 'seed']);
    expect(r.text).not.toContain('checkpoint');
  });

  it('a second farm cannot be created to multiply rank: POST /farms is idempotent per user', async () => {
    const again = await api('/farms', { token: user.token, body: {} });
    expect(again.status).toBe(200);
    expect((again.json as FarmResponse).id).toBe(farm.id);
    const raced = await Promise.all(Array.from({ length: 10 }, () => api('/farms', { token: user.token, body: {} })));
    expect(raced.every((r) => r.status === 200 && (r.json as FarmResponse).id === farm.id)).toBe(true);
    expect(await db.query('SELECT * FROM farms WHERE user_id = ?', [user.profile.id])).toHaveLength(1);
    // the schema itself forbids it, even bypassing the handler
    await expect(db.execute("INSERT INTO farms (id, user_id, seed, started_at, tick, checkpoint, checkpoint_hash, rules_version, coins, net_worth) VALUES ('x', ?, 1, 0, 0, '{}', '00000000', 3, 0, 0)", [user.profile.id])).rejects.toThrow();
  });

  it('concurrent first-time farm creation from one fresh user yields exactly one farm', async () => {
    const fresh = await login('Racer');
    const raced = await Promise.all(Array.from({ length: 10 }, () => api('/farms', { token: fresh.token, body: {} })));
    expect(raced.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
    expect(new Set(raced.map((r) => (r.json as FarmResponse).id)).size).toBe(1);
  });

  it('an unverified farm never appears on the leaderboard', async () => {
    const board = (await api('/leaderboard')).json as { entries: unknown[] };
    expect(board.entries).toEqual([]);
  });

  it('a logged-out token is dead for reads and writes', async () => {
    const out = await api('/auth/logout', { token: user.token, body: {} });
    expect(out.status).toBe(204);
    expect((await api('/farms/me', { token: user.token })).status).toBe(401);
    expect((await submit(chunkBody([], 100))).status).toBe(401);
    expect(await db.query('SELECT * FROM sessions WHERE user_id = ?', [user.profile.id])).toHaveLength(0);
  });

  it('an expired session token (31 days) is dead; a deleted one is dead', async () => {
    time += 31 * DAY_MS;
    expect((await api('/farms/me', { token: user.token })).status).toBe(401);
    expect((await submit(chunkBody([], 100))).status).toBe(401);
    time -= 31 * DAY_MS;
    expect((await api('/farms/me', { token: user.token })).status).toBe(200);
    await db.execute('DELETE FROM sessions');
    expect((await api('/farms/me', { token: user.token })).status).toBe(401);
  });

  it.each([
    ['lower-case scheme', (t: string) => ({ headers: { Authorization: `bearer ${t}` } })],
    ['token with trailing junk', (t: string) => ({ headers: { Authorization: `Bearer ${t}x` } })],
    ['token truncated', (t: string) => ({ headers: { Authorization: `Bearer ${t.slice(1)}` } })],
    ['two tokens', (t: string) => ({ headers: { Authorization: `Bearer ${t} ${t}` } })],
    ['Basic scheme', (t: string) => ({ headers: { Authorization: `Basic ${t}` } })],
    ['token in query string', (t: string) => ({ query: `?token=${t}` })],
    ['token in a custom header', (t: string) => ({ headers: { 'X-Tendril-Token': t, 'X-Session': t } })],
    ['SQL in the token', () => ({ headers: { Authorization: "Bearer ' OR '1'='1" } })],
  ])('auth bypass attempt: %s', async (_name, make) => {
    const part = make(user.token) as { headers?: Record<string, string>; query?: string };
    const r = await send(`/api/farms/me${part.query ?? ''}`, { headers: part.headers });
    expect(r.status).toBe(401);
  });

  it('a bad Bearer never falls back to a good cookie', async () => {
    const r = await api('/farms/me', { headers: { Authorization: 'Bearer ' + 'A'.repeat(43) }, cookie: `tendril_session=${user.token}` });
    expect(r.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('8. concurrency', () => {
  it('10 simultaneous submissions of the same valid chunk: exactly one is accepted', async () => {
    const body = chunkBody(GOOD, GOOD_TO);
    const results = await Promise.all(Array.from({ length: 10 }, () => submit(body)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409, 409, 409, 409, 409, 409, 409]);
    expect(await db.query('SELECT * FROM chunks')).toHaveLength(1);
    expect(await db.query('SELECT * FROM worth_history')).toHaveLength(2); // creation + the one accepted chunk
    const want = expected(farm, GOOD, GOOD_TO);
    const stored = await myFarm();
    expect(stored.netWorth).toBe(want.worth); // the sell was applied once, not ten times
    expect(stored.checkpointHash).toBe(want.hash);
  });

  it('10 simultaneous different valid chunks from one checkpoint: exactly one wins, no mix of states', async () => {
    const variants = Array.from({ length: 10 }, (_, i) => chunkBody([[0, 0, 7, i + 1]], 20 + i));
    const results = await Promise.all(variants.map((v) => submit(v)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    const stored = await myFarm();
    const winner = variants[results.findIndex((r) => r.status === 200)]!;
    const want = expected(farm, winner.actions as LogEntry[], winner.toTick as number);
    expect(stored.checkpointHash).toBe(want.hash);
  });

  it('simultaneous submissions racing the rate limiter never exceed 10 attempts', async () => {
    const results = await Promise.all(Array.from({ length: 25 }, () => submit(chunkBody(GOOD, GOOD_TO))));
    expect(results.filter((r) => r.status === 429)).toHaveLength(15);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await db.query("SELECT * FROM submission_attempts WHERE kind = 'chunk'")).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('9. rate limit bypass', () => {
  const exhaust = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) expect((await submit(chunkBody([], 100, { ...farm, checkpointHash: '00000000' }))).status).toBe(409);
  };

  it('the 11th attempt is a 429 even for a perfectly valid chunk', async () => {
    await exhaust();
    expect((await submit(chunkBody(GOOD, GOOD_TO))).status).toBe(429);
  });

  it('varying headers (XFF, UA, Origin, Referer, Accept-Language, Via, CF-Connecting-IP) does not reset the counter', async () => {
    const variants: Record<string, string>[] = [
      { 'X-Forwarded-For': '1.2.3.4' }, { 'X-Forwarded-For': '9.9.9.9, 8.8.8.8' }, { 'X-Real-IP': '5.5.5.5' }, { 'CF-Connecting-IP': '6.6.6.6' },
      { 'User-Agent': 'curl/9' }, { 'User-Agent': 'Mozilla/5.0' }, { Origin: ORIGIN }, { Referer: `${ORIGIN}/play/` }, { 'Accept-Language': 'fr' }, { Via: '1.1 proxy' },
    ];
    for (const headers of variants) expect((await submit(chunkBody([], 100, { ...farm, checkpointHash: '00000000' }), user.token, farm.id, { headers })).status).toBe(409);
    for (const headers of [{ 'X-Forwarded-For': '7.7.7.7' }, { 'User-Agent': 'x' }, { 'X-Tendril-Client': '1' }, {}] as Record<string, string>[]) {
      expect((await submit(chunkBody(GOOD, GOOD_TO), user.token, farm.id, { headers })).status).toBe(429);
    }
  });

  it('path casing, trailing slash, double slash, dot segments and query strings are not a way around the cap', async () => {
    await exhaust();
    const id = farm.id;
    const body = chunkBody(GOOD, GOOD_TO);
    const paths = [
      `/api/farms/${id}/chunks`, `/api/farms/${id}/chunks?x=1`, `/api/farms/${id}/chunks?`, `/api/farms/${id}/chunks#frag`,
      `/api/farms/${id}/chunks/`, `/API/farms/${id}/chunks`, `/api/FARMS/${id}/chunks`, `/api/farms/${id}/CHUNKS`, `/api/farms/${id.toUpperCase()}/chunks`,
      `//api/farms/${id}/chunks`, `/api//farms/${id}/chunks`, `/api/farms//${id}/chunks`, `/api/./farms/${id}/chunks`, `/api/x/../farms/${id}/chunks`,
      `/api/farms/${id}/chunks;a=b`, `/api/farms/${id}/chunks%20`, `/api/farms/%2e/${id}/chunks`, `/api/farms/${id}/chunks/.`,
    ];
    const before = await snapshot();
    for (const path of paths) {
      const r = await send(path, { token: user.token, body });
      // Either throttled (429) or never routed (404/400); never processed.
      expect([429, 404, 400, 403], `${path} -> ${r.status}`).toContain(r.status);
      expect(r.status).not.toBe(200);
    }
    expect(await snapshot()).toBe(before);
    expect((await myFarm()).tick).toBe(0);
  });

  it('queries and bad content types still count as attempts (they are reserved before the body is read)', async () => {
    for (let i = 0; i < 5; i++) expect((await submit(chunkBody([], 100), user.token, farm.id, {})).status).toBe(i === 0 ? 200 : 409);
    const farmNow = await myFarm();
    for (let i = 0; i < 3; i++) expect((await send(`/api/farms/${farm.id}/chunks?q=${i}`, { token: user.token, body: chunkBody([], 200, farmNow) })).status).toBe(400);
    for (let i = 0; i < 2; i++) expect((await send(`/api/farms/${farm.id}/chunks`, { token: user.token, raw: 'x', contentType: 'text/plain' })).status).toBe(400);
    expect((await submit(chunkBody([], 200, farmNow))).status).toBe(429);
  });

  it('cookie and bearer for the same user share one budget', async () => {
    for (let i = 0; i < 5; i++) await submit(chunkBody([], 100, { ...farm, checkpointHash: '00000000' }));
    for (let i = 0; i < 5; i++) await send(`/api/farms/${farm.id}/chunks`, { cookie: `tendril_session=${user.token}`, csrf: true, body: chunkBody([], 100, { ...farm, checkpointHash: '00000000' }) });
    expect((await submit(chunkBody(GOOD, GOOD_TO))).status).toBe(429);
    expect((await send(`/api/farms/${farm.id}/chunks`, { cookie: `tendril_session=${user.token}`, csrf: true, body: chunkBody(GOOD, GOOD_TO) })).status).toBe(429);
  });

  it('the budget returns after an hour, not before', async () => {
    await exhaust();
    time += HOUR_MS - 1;
    expect((await submit(chunkBody(GOOD, GOOD_TO))).status).toBe(429);
    time += 2;
    expect((await submit(chunkBody(GOOD, GOOD_TO))).status).toBe(200);
  });

  it('the daily limit (20 per UTC day) holds across query/casing variants', async () => {
    const body = { date: '2026-11-12', rulesVersion: RULES_VERSION, actions: [] };
    for (let i = 0; i < 20; i++) expect((await api('/daily/submit', { token: user.token, body })).status).toBe(200);
    for (const path of ['/api/daily/submit', '/api/daily/submit?x=1']) expect((await send(path, { token: user.token, body })).status).toBe(429);
    for (const path of ['/api/daily/submit/', '/API/daily/submit', '/api/Daily/submit']) expect((await send(path, { token: user.token, body })).status).toBe(404);
  });

  it('unauthenticated floods hit only the cheap 401 path and consume no quota', async () => {
    for (let i = 0; i < 30; i++) expect((await submit(chunkBody(GOOD, GOOD_TO), 'A'.repeat(43))).status).toBe(401);
    expect(await db.query('SELECT * FROM submission_attempts')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('10. daily challenge', () => {
  const TODAY = '2026-11-12';
  const YESTERDAY = '2026-11-11';
  const daily = (body: unknown, token = user.token): Promise<Reply> => api('/daily/submit', { token, body });
  const dailyExpected = (date: string, actions: LogEntry[]): number => {
    const w = createWorld({ id: `daily-${date}`, seed: dailySeed(date) });
    replayChunk(w, actions, DAILY_TICKS);
    return netWorth(w);
  };

  it('the stored score is the server-side replay on the SUBMITTED date seed, whichever date the log was tuned for', async () => {
    expect(dailySeed(TODAY)).not.toBe(dailySeed(YESTERDAY));
    const t = await daily({ date: TODAY, rulesVersion: RULES_VERSION, actions: GOOD });
    const y = await daily({ date: YESTERDAY, rulesVersion: RULES_VERSION, actions: GOOD });
    expect(t.status).toBe(200);
    expect(y.status).toBe(200);
    expect((t.json as { netWorth: number }).netWorth).toBe(dailyExpected(TODAY, GOOD));
    expect((y.json as { netWorth: number }).netWorth).toBe(dailyExpected(YESTERDAY, GOOD));
    expect((t.json as { netWorth: number }).netWorth).toBeGreaterThan(0);
  });

  it.each([
    ['3 days ago', '2026-11-09', 422],
    ['tomorrow', '2026-11-13', 422],
    ['far future', '2099-01-01', 422],
    ['not a date', 'today', 422],
    ['impossible date', '2026-02-30', 422],
    ['wrong format', '11/12/2026', 422],
    ['with time', '2026-11-12T00:00:00Z', 422],
    ['array', ['2026-11-12'], 422],
    ['number', 20261112, 422],
    ['null', null, 422],
    ['padded', ' 2026-11-12', 422],
  ] as [string, unknown, number][])('date %s is refused', async (_name, date, status) => {
    await expectRejected(null, status, () => daily({ date, rulesVersion: RULES_VERSION, actions: GOOD }));
  });

  it('claimed fields (netWorth, seed, ticks) are rejected, and a wrong rules version is a 409', async () => {
    await expectRejected(null, 422, () => daily({ date: TODAY, rulesVersion: RULES_VERSION, actions: GOOD, netWorth: 1e9 }));
    await expectRejected(null, 422, () => daily({ date: TODAY, rulesVersion: RULES_VERSION, actions: GOOD, seed: 1 }));
    await expectRejected(null, 409, () => daily({ date: TODAY, rulesVersion: 2, actions: GOOD }));
    await expectRejected(null, 422, () => daily({ date: TODAY, rulesVersion: RULES_VERSION }));
  });

  it('actions at or past tick 3000 are refused; tick 2999 is fine', async () => {
    await expectRejected(null, 422, () => daily({ date: TODAY, rulesVersion: RULES_VERSION, actions: [[3000, 0, 7, 1]] }));
    await expectRejected(null, 422, () => daily({ date: TODAY, rulesVersion: RULES_VERSION, actions: [[3001, 0, 3]] }));
    await expectRejected(null, 422, () => daily({ date: TODAY, rulesVersion: RULES_VERSION, actions: [[1e9, 0, 3]] }));
    expect((await daily({ date: TODAY, rulesVersion: RULES_VERSION, actions: [[2999, 0, 3]] })).status).toBe(200);
  });

  it('illegal moves in a daily log reject the whole run', async () => {
    await expectRejected(null, 422, () => daily({ date: TODAY, rulesVersion: RULES_VERSION, actions: [...GOOD, [307, 5, 3]] }));
    await expectRejected(null, 422, () => daily({ date: TODAY, rulesVersion: RULES_VERSION, actions: [[0, 0, 0, 1], [1, 0, 1]] }));
    await expectRejected(null, 413, () => daily({ date: TODAY, rulesVersion: RULES_VERSION, actions: waits(20_001) }));
  });

  it('resubmitting a lower or equal score does not replace the best, nor move achievedAt or rank', async () => {
    const good = await daily({ date: TODAY, rulesVersion: RULES_VERSION, actions: GOOD });
    const best = (good.json as { netWorth: number }).netWorth;
    expect(best).toBeGreaterThan(0);
    const rival = await login('Rival');
    time += 60_000;
    const rivalRun = await daily({ date: TODAY, rulesVersion: RULES_VERSION, actions: GOOD }, rival.token);
    expect((rivalRun.json as { rank: number }).rank).toBe(2); // tie broken by earlier achievement
    const lower = await daily({ date: TODAY, rulesVersion: RULES_VERSION, actions: [] });
    expect(lower.status).toBe(200);
    expect(lower.json).toMatchObject({ netWorth: 0, best, rank: 1 });
    const equal = await daily({ date: TODAY, rulesVersion: RULES_VERSION, actions: GOOD });
    expect(equal.json).toMatchObject({ netWorth: best, best, rank: 1 });
    const entries = ((await api(`/daily/leaderboard?date=${TODAY}`)).json as { entries: { userId: string; netWorth: number; achievedAtMs: number }[] }).entries;
    expect(entries.map((e) => [e.userId, e.netWorth, e.achievedAtMs])).toEqual([[user.profile.id, best, time - 60_000], [rival.profile.id, best, time]]);
  });

  it('only a strictly higher score replaces the best', async () => {
    const small = await daily({ date: TODAY, rulesVersion: RULES_VERSION, actions: [[0, 0, 0, 1], [2, 0, 1], [5, 0, 2, 1], [7, 0, 3], [9, 0, 3], [300, 0, 4], [303, 0, 0, 3], [305, 0, 5], [306, 0, 8, 1, 2]] });
    const full = await daily({ date: TODAY, rulesVersion: RULES_VERSION, actions: GOOD });
    expect((full.json as { best: number }).best).toBeGreaterThanOrEqual((small.json as { netWorth: number }).netWorth);
    const rows = await db.query<{ net_worth: number }>('SELECT net_worth FROM daily_entries WHERE user_id = ?', [user.profile.id]);
    expect(rows).toEqual([{ net_worth: dailyExpected(TODAY, GOOD) }]);
  });

  it("a user's daily score never touches the farm leaderboard, and farm scores never touch the daily board", async () => {
    await daily({ date: TODAY, rulesVersion: RULES_VERSION, actions: GOOD });
    expect(((await api('/leaderboard')).json as { entries: unknown[] }).entries).toEqual([]);
    expect((await submit(chunkBody(GOOD, GOOD_TO))).status).toBe(200);
    expect(((await api(`/daily/leaderboard?date=${YESTERDAY}`)).json as { entries: unknown[] }).entries).toEqual([]);
  });

  it('the day rolls over by the injected clock: after midnight UTC yesterday-of-yesterday is closed', async () => {
    time = Date.UTC(2026, 10, 13, 0, 0, 0);
    expect((await daily({ date: YESTERDAY, rulesVersion: RULES_VERSION, actions: [] })).status).toBe(422);
    expect((await daily({ date: TODAY, rulesVersion: RULES_VERSION, actions: [] })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('11. HTTP layer', () => {
  it.each([
    ['text/plain', 'text/plain'],
    ['form-urlencoded', 'application/x-www-form-urlencoded'],
    ['multipart', 'multipart/form-data; boundary=x'],
    ['application/jsonp', 'application/jsonp'],
    ['application/json5', 'application/json5'],
    ['text/json', 'text/json'],
    ['empty', ''],
    ['missing', null],
  ])('content type %s is a 400', async (_name, contentType) => {
    await expectRejected(null, 400, () => send(`/api/farms/${farm.id}/chunks`, { token: user.token, raw: JSON.stringify(chunkBody(GOOD, GOOD_TO)), contentType }));
  });

  it('application/json with charset and odd casing is accepted', async () => {
    const r = await send(`/api/farms/${farm.id}/chunks`, { token: user.token, raw: JSON.stringify(chunkBody([], 100)), contentType: 'Application/JSON; charset=utf-8' });
    expect(r.status).toBe(200);
  });

  it.each(['', '{', '{"a":', 'null', '[]', '"str"', '1', 'true', '{} {}', '{"fromTick":0,}', "{'a':1}", '\u0000', '{"a":1}garbage', 'undefined'])('invalid / non-object JSON %j is rejected', async (raw) => {
    const r = await expectRejected(raw, [400, 422]);
    expect(r.status).not.toBe(500);
  });

  it('duplicate keys: the last value wins consistently in validation and replay', async () => {
    const raw = `{"fromTick":0,"toTick":999999,"actions":[],"toTick":100,"rulesVersion":3,"checkpointHash":"${farm.checkpointHash}"}`;
    const r = await submit(raw);
    expect(r.status).toBe(200);
    expect((r.json as Accepted).tick).toBe(100);
  });

  it.each(['PUT', 'DELETE', 'PATCH', 'GET', 'HEAD', 'TRACE', 'CONNECT'])('method %s on the chunks route is not a write', async (method) => {
    const before = await snapshot();
    let status: number;
    try {
      status = (await send(`/api/farms/${farm.id}/chunks`, { method, token: user.token })).status;
    } catch { return; } // the Fetch API itself refuses forbidden methods
    expect([404, 405]).toContain(status);
    expect(await snapshot()).toBe(before);
  });

  it.each([
    ['POST', '/api/leaderboard'], ['POST', '/api/stats'], ['POST', '/api/daily'], ['GET', '/api/daily/submit'], ['GET', '/api/farms'],
    ['DELETE', '/api/farms/me'], ['PUT', '/api/farms'], ['GET', '/api/auth/logout'], ['GET', '/api/auth/desktop/poll'], ['POST', '/api/me'],
  ])('%s %s is 404, not a handler', async (method, path) => {
    const r = await send(path, { method, token: user.token, body: method === 'POST' || method === 'PUT' ? {} : undefined });
    expect(r.status).toBe(404);
  });

  it.each([
    ['dot-dot', '/api/farms/../me/chunks'],
    ['encoded dot-dot', '/api/farms/%2e%2e/me/chunks'],
    ['encoded dot-dot slash', '/api/farms/..%2Fme/chunks'],
    ['encoded slash', `/api/farms/${'a'.repeat(8)}%2F${'b'.repeat(8)}/chunks`],
    ['double-encoded slash', '/api/farms/%252e%252e%252fme/chunks'],
    ['backslash', '/api/farms/..%5Cme/chunks'],
    ['null byte', '/api/farms/%00/chunks'],
    ['sql', "/api/farms/'%20OR%201=1--/chunks"],
    ['sql union', '/api/farms/x%27%20UNION%20SELECT%20checkpoint%20FROM%20farms--/chunks'],
    ['empty id', '/api/farms//chunks'],
    ['wildcard', '/api/farms/%25/chunks'],
    ['uuid + suffix', '/api/farms/00000000-0000-4000-8000-000000000000x/chunks'],
    ['uuid with newline', '/api/farms/00000000-0000-4000-8000-000000000000%0A/chunks'],
    ['very long id', `/api/farms/${'a'.repeat(100_000)}/chunks`],
    ['very long uuid-ish id', `/api/farms/${'0'.repeat(8)}-${'0'.repeat(10_000)}/chunks`],
  ])('farm id %s is refused and nothing is written', async (_name, path) => {
    const before = await snapshot();
    const r = await send(path, { token: user.token, body: chunkBody(GOOD, GOOD_TO) });
    expect([400, 404, 429]).toContain(r.status);
    expect(r.status).not.toBe(200);
    expect(r.text.length).toBeLessThan(500);
    expect(await snapshot()).toBe(before);
    const rp = await send(path.replace('/chunks', '/replay'), {});
    expect([400, 404]).toContain(rp.status);
  });

  it('replay and leaderboard parameters are validated', async () => {
    for (const q of ['fromTick=-1', 'fromTick=1.5', 'fromTick=abc', 'fromTick=99999999999999999999', 'limit=0', 'limit=3', 'limit=-1', 'limit=1e1', 'fromTick=0&fromTick=1', 'x=1']) {
      expect((await api(`/farms/${farm.id}/replay?${q}`)).status, q).toBe(400);
    }
    for (const q of ['limit=0', 'limit=101', 'limit=-5', 'limit=1.5', 'limit=abc', 'limit=99999999999', 'board=drop', 'board=networth;DROP', 'limit=1&limit=2', 'q=1']) {
      expect((await api(`/leaderboard?${q}`)).status, q).toBe(400);
    }
  });

  it('cookie-authenticated POST without X-Tendril-Client is a 403 (no attempt reserved, no change)', async () => {
    const cookie = `tendril_session=${user.token}`;
    const before = await snapshot();
    const r = await send(`/api/farms/${farm.id}/chunks`, { cookie, body: chunkBody(GOOD, GOOD_TO) });
    expect(r.status).toBe(403);
    expect(await snapshot()).toBe(before);
    expect(await db.query('SELECT * FROM submission_attempts')).toHaveLength(0);
    for (const headers of [{ 'X-Tendril-Client': '0' }, { 'X-Tendril-Client': 'true' }, { 'X-Tendril-Client': '' }, { 'X-Tendril-Client': '1 ' + 'x' }]) {
      expect((await send(`/api/farms/${farm.id}/chunks`, { cookie, headers, body: chunkBody(GOOD, GOOD_TO) })).status).toBe(403);
    }
    expect((await send('/api/farms', { cookie, body: {} })).status).toBe(403);
    expect((await send('/api/daily/submit', { cookie, body: { date: '2026-11-12', rulesVersion: 3, actions: [] } })).status).toBe(403);
    expect((await send('/api/auth/logout', { cookie, body: {} })).status).toBe(403);
    expect((await api('/farms/me', { cookie })).status).toBe(200); // reads need no header
    expect((await send(`/api/farms/${farm.id}/chunks`, { cookie, csrf: true, body: chunkBody(GOOD, GOOD_TO) })).status).toBe(200);
  });

  it('a form-encoded cross-site style POST (simple request) can never carry the cookie into a mutation', async () => {
    const r = await send(`/api/farms/${farm.id}/chunks`, { cookie: `tendril_session=${user.token}`, raw: `fromTick=0&toTick=100&actions=[]&rulesVersion=3&checkpointHash=${farm.checkpointHash}`, contentType: 'application/x-www-form-urlencoded' });
    expect(r.status).toBe(403);
    const t = await send(`/api/farms/${farm.id}/chunks`, { cookie: `tendril_session=${user.token}`, raw: JSON.stringify(chunkBody([], 100)), contentType: 'text/plain' });
    expect(t.status).toBe(403);
  });

  it('a foreign Origin is refused on every method, with a valid token, and gets no CORS headers', async () => {
    for (const origin of ['https://evil.example', 'http://tendril.example', 'https://tendril.example.evil.example', 'https://sub.tendril.example', 'null', 'file://', 'http://localhost:9999', 'app://tendril.evil']) {
      if (origin === 'http://localhost:9999') env.TENDRIL_DEV_AUTH = undefined;
      const g = await api('/farms/me', { token: user.token, headers: { Origin: origin } });
      expect(g.status, origin).toBe(403);
      expect(g.headers.get('access-control-allow-origin')).toBeNull();
      expect(g.headers.get('access-control-allow-credentials')).toBeNull();
      const p = await submit(chunkBody(GOOD, GOOD_TO), user.token, farm.id, { headers: { Origin: origin } });
      expect(p.status, origin).toBe(403);
      env.TENDRIL_DEV_AUTH = '1';
    }
    expect((await myFarm()).tick).toBe(0);
  });

  it('CORS preflight from a foreign origin is refused with no allow headers', async () => {
    for (const origin of ['https://evil.example', 'null', 'https://tendril.example.evil.example']) {
      const r = await send(`/api/farms/${farm.id}/chunks`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type,x-tendril-client' } });
      expect(r.status).toBe(403);
      expect(r.headers.get('access-control-allow-origin')).toBeNull();
      expect(r.headers.get('access-control-allow-methods')).toBeNull();
      expect(r.headers.get('access-control-allow-credentials')).toBeNull();
    }
  });

  it('same-origin preflight cannot widen methods or headers; desktop origin is Bearer-only without credentials', async () => {
    const bad = await send('/api/farms', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'DELETE' } });
    expect(bad.status).toBe(400);
    const badHeaders = await send('/api/farms', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-evil' } });
    expect(badHeaders.status).toBe(400);
    const notApi = await send('/index.html', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET' } });
    expect(notApi.status).toBe(400);
    const desk = await send('/api/farms', { method: 'OPTIONS', headers: { Origin: 'app://tendril', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    expect(desk.status).toBe(204);
    expect(desk.headers.get('access-control-allow-origin')).toBe('app://tendril');
    expect(desk.headers.get('access-control-allow-credentials')).toBeNull();
    // a cookie sent from the desktop origin is ignored: it never authenticates
    expect((await api('/farms/me', { headers: { Origin: 'app://tendril' }, cookie: `tendril_session=${user.token}` })).status).toBe(401);
    expect((await api('/farms/me', { headers: { Origin: 'app://tendril' }, token: user.token })).status).toBe(200);
  });

  it('loopback origins are trusted only while dev auth is on (never in production)', async () => {
    expect((await api('/stats', { headers: { Origin: 'http://localhost:5173' } })).status).toBe(200);
    env.VERCEL_ENV = 'production';
    expect((await api('/stats', { headers: { Origin: 'http://localhost:5173' } })).status).toBe(403);
    expect((await api('/dev/login', { body: { displayName: 'Nope' } })).status).toBe(404);
    expect((await api('/dev/login', { headers: { Origin: ORIGIN }, body: { displayName: 'Nope' } })).status).toBe(404);
    env.VERCEL_ENV = undefined;
    env.TENDRIL_DEV_AUTH = '0';
    expect((await api('/dev/login', { body: { displayName: 'Nope' } })).status).toBe(404);
  });

  it('the session cookie is HttpOnly, Secure, SameSite=Lax, Path=/ and has a bounded lifetime', async () => {
    const r = await api('/dev/login', { body: { displayName: 'Cookie Monster' } });
    const header = r.headers.get('set-cookie') ?? '';
    expect(header).toMatch(/^tendril_session=[A-Za-z0-9_-]{43};/);
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=2592000']) expect(header).toContain(flag);
    expect(header).not.toMatch(/Domain=/i);
    const out = await api('/auth/logout', { cookie: header.split(';')[0]!, csrf: true, body: {} });
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toMatch(/tendril_session=;.*Max-Age=0.*HttpOnly.*Secure/);
  });

  it('security headers are present on every response, including errors', async () => {
    for (const r of [await api('/stats'), await api('/nope'), await api('/farms/me'), await send('/not-api')]) {
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(r.headers.get('x-frame-options')).toBe('DENY');
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(r.headers.get('content-type')).toContain('application/json');
    }
  });

  it('error bodies never echo request data or internals', async () => {
    const canary = 'CANARY-7c1d';
    const rs = [
      await api(`/farms/${canary}/chunks`, { token: user.token, body: {} }),
      await submit(`{"${canary}": 1}`),
      await submit(chunkBody([[0, 0, 7, canary]], 100)),
      await api('/farms', { token: user.token, body: { [canary]: 1 } }),
      await api('/daily/submit', { token: user.token, body: { date: canary, rulesVersion: 3, actions: [] } }),
    ];
    for (const r of rs) expect(r.text).not.toContain(canary);
  });

  it('a random-mutation fuzz never produces a 500, and every acceptance equals an independent replay', async () => {
    let seed = 0x1234abcd;
    const rnd = (): number => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const pool: unknown[] = [null, -1, 0, 1, 2, 3, 4, 5, 10, 11, 99, 1000, 1001, 20000, 1.5, '1', [], {}, true, MAX, 2 ** 53, 1e308, -0];
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const stats = { accepted: 0, rejected: 0 };
    for (let i = 0; i < 120; i++) {
      const p = await newPlayer(`Fuzz${i}`);
      time += 2_000_000;
      const actions: unknown[] = (JSON.parse(JSON.stringify(GOOD)) as unknown[][]).map((e) => [...e]);
      const body = chunkBody(actions, GOOD_TO, p.farm);
      for (let m = 0; m < 1 + Math.floor(rnd() * 3); m++) {
        const roll = rnd();
        const entry = pick(actions as unknown[][]);
        if (roll < 0.5) entry[Math.floor(rnd() * entry.length)] = pick(pool);
        else if (roll < 0.65) entry.push(pick(pool));
        else if (roll < 0.8) entry.pop();
        else if (roll < 0.9) actions.splice(Math.floor(rnd() * actions.length), 0, [Math.floor(rnd() * 400), pick([0, -1, 1]), Math.floor(rnd() * 18), pick(pool), pick(pool)]);
        else body[pick(['fromTick', 'toTick', 'rulesVersion', 'checkpointHash'])] = pick(pool);
      }
      const r = await submit(body, p.user.token, p.farm.id);
      expect(r.status, JSON.stringify(body)).not.toBe(500);
      expect([200, 400, 409, 413, 422]).toContain(r.status);
      if (r.status === 200) {
        stats.accepted++;
        const want = expected(p.farm, body.actions as LogEntry[], body.toTick as number);
        expect((r.json as Accepted).checkpointHash).toBe(want.hash);
        expect((r.json as Accepted).netWorth).toBe(want.worth);
      } else {
        stats.rejected++;
        expect((await myFarm(p.user.token)).checkpoint).toBe(p.farm.checkpoint);
      }
    }
    timings['fuzz accepted/rejected'] = stats.accepted * 1000 + stats.rejected;
    expect(stats.rejected).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('12. determinism', () => {
  it('the same chunk on two fresh app instances yields the same checkpoint hash, checkpoint and net worth', async () => {
    const second = createDb({ url: ':memory:' });
    try {
      const otherApp = createApp({ db: second, env, fetch: noNetwork, now: () => time });
      const login2 = await (await otherApp(new Request('http://localhost:8787/api/dev/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: 'Twin' }) }))).json() as Login;
      // Clone the first farm (same id, seed, start time, checkpoint) into the second instance.
      const created = await otherApp(new Request('http://localhost:8787/api/farms', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login2.token}` }, body: '{}' }));
      const twin = await created.json() as FarmResponse;
      await second.execute('DELETE FROM worth_history');
      await second.execute('UPDATE farms SET id = ?, seed = ?, started_at = ?, checkpoint = ?, checkpoint_hash = ? WHERE id = ?', [farm.id, farm.seed, farm.startedAtMs, farm.checkpoint, farm.checkpointHash, twin.id]);
      const body = JSON.stringify(chunkBody(GOOD, GOOD_TO));
      const one = await submit(body);
      const two = await otherApp(new Request(`http://localhost:8787/api/farms/${farm.id}/chunks`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login2.token}` }, body }));
      expect(one.status).toBe(200);
      expect(two.status).toBe(200);
      const a = one.json as Accepted;
      const b = await two.json() as Accepted;
      expect(b.checkpointHash).toBe(a.checkpointHash);
      expect(b.netWorth).toBe(a.netWorth);
      expect(b.tick).toBe(a.tick);
      const [rowA] = await db.query<{ checkpoint: string }>('SELECT checkpoint FROM farms WHERE id = ?', [farm.id]);
      const [rowB] = await second.query<{ checkpoint: string }>('SELECT checkpoint FROM farms WHERE id = ?', [farm.id]);
      expect(rowB!.checkpoint).toBe(rowA!.checkpoint);
      expect(a.checkpointHash).toBe(expected(farm, GOOD, GOOD_TO).hash);
    } finally { second.close(); }
  });

  it('replaying the stored chunks from the seed reproduces the stored checkpoint hash', async () => {
    expect((await submit(chunkBody(GOOD, GOOD_TO))).status).toBe(200);
    const next = await myFarm();
    expect((await submit(chunkBody([[GOOD_TO, 0, 7, 5]], GOOD_TO + 100, next))).status).toBe(200);
    const final = await myFarm();
    const replay = (await api(`/farms/${farm.id}/replay?limit=2`)).json as { seed: number; chunks: { fromTick: number; toTick: number; actions: LogEntry[] }[] };
    const world = createWorld({ id: farm.id, seed: replay.seed });
    for (const c of replay.chunks) replayChunk(world, c.actions, c.toTick);
    expect(hashWorld(world)).toBe(final.checkpointHash);
    expect(netWorth(world)).toBe(final.netWorth);
  });

  it('the harness finishes by printing its timing numbers', () => {
    process.stdout.write(`\nATTACK TIMINGS (ms unless noted): ${JSON.stringify(timings, null, 1)}\n`);
    expect(Object.keys(timings).length).toBeGreaterThan(0);
  });
});
