import { inflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RULES_VERSION } from '@tendril/sim/src/index.ts';
import { createApp, createDb } from '../src/index.ts';
import type { Db } from '../src/index.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const BASE = Date.UTC(2026, 10, 12, 12, 0, 0);
const SMALL = [[0, 0, 0, 1], [2, 0, 1], [5, 0, 2, 1], [7, 0, 3], [9, 0, 3], [300, 0, 4], [303, 0, 0, 3], [305, 0, 5], [306, 0, 8, 1, 4]];
const ORIGIN = 'https://tendril.example';

let db: Db;
let app: (r: Request) => Promise<Response>;

const get = (path: string, method = 'GET') => app(new Request(`http://localhost:8787${path}`, { method }));
async function submit(name: string): Promise<string> {
  const l = await (await app(new Request('http://localhost:8787/api/dev/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: name }) }))).json() as Json;
  const r = await app(new Request('http://localhost:8787/api/challenges/today/entries', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${l.token}` }, body: JSON.stringify({ rulesVersion: RULES_VERSION, actions: SMALL }) }));
  expect(r.status).toBe(200);
  return ((await r.json()) as Json).entryId as string;
}

beforeEach(() => {
  db = createDb({ url: ':memory:' });
  app = createApp({ db, env: { TENDRIL_DEV_AUTH: '1', PUBLIC_ORIGIN: ORIGIN }, now: () => BASE });
});
afterEach(() => db.close());

function pngSize(buf: Buffer): [number, number] {
  expect(buf.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

describe('share page', () => {
  it('serves Open Graph and Twitter tags and a redirect to the replay', async () => {
    const id = await submit('Ada <script>');
    const res = await get(`/r/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toContain('s-maxage');
    const html = await res.text();
    expect(html).toContain(`<meta property="og:image" content="${ORIGIN}/api/og/${id}.png">`);
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toMatch(/<meta property="og:title" content="Ada &#60;script&#62; scored \d+ on Tendril/);
    expect(html).not.toContain('<script>');
    expect(html).toContain(`url=${ORIGIN}/play/?replay=${id}`);
    expect((await get(`/api/r/${id}`)).status).toBe(200);
  });

  it('answers an unknown or malformed id with a generic card page, not an error', async () => {
    for (const id of ['AAAAAAAAAAAA', 'nope', 'x'.repeat(40)]) {
      const res = await get(`/r/${id}`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('og:image');
      expect(html).toContain(`${ORIGIN}/play/`);
    }
  });

  it('rejects other methods', async () => {
    expect((await get('/r/AAAAAAAAAAAA', 'POST')).status).toBe(405);
  });
});

describe('preview image', () => {
  it('returns a 1200x630 PNG under 300 KB within two seconds', async () => {
    const id = await submit('Ada');
    const t0 = Date.now();
    const res = await get(`/api/og/${id}.png`);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toContain('s-maxage');
    expect(buf.length).toBeLessThan(300 * 1024);
    expect(pngSize(buf)).toEqual([1200, 630]);
    expect(inflateSync(Buffer.concat(idat(buf))).length).toBe((1200 * 3 + 1) * 630);
  });

  it('returns a valid generic card for an unknown id', async () => {
    const res = await get('/api/og/AAAAAAAAAAAA.png');
    expect(res.status).toBe(200);
    expect(pngSize(Buffer.from(await res.arrayBuffer()))).toEqual([1200, 630]);
  });
});

function idat(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let o = 8; o < buf.length;) {
    const len = buf.readUInt32BE(o);
    if (buf.toString('latin1', o + 4, o + 8) === 'IDAT') out.push(buf.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  return out;
}

describe('hit counting', () => {
  it('counts page and card hits per entry per day, and not unknown ids', async () => {
    const id = await submit('Ada');
    await get(`/r/${id}`); await get(`/r/${id}`); await get(`/api/og/${id}.png`); await get('/r/AAAAAAAAAAAA');
    const rows = await db.query<{ entry_id: string; day: string; kind: string; hits: number }>('SELECT * FROM share_hits ORDER BY kind');
    expect(rows).toEqual([
      { entry_id: id, day: '2026-11-12', kind: 'card', hits: 1 },
      { entry_id: id, day: '2026-11-12', kind: 'page', hits: 2 },
    ]);
  });
});
