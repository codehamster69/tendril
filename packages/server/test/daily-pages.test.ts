import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASE_RULES_VERSION } from '@tendril/sim/src/index.ts';
import { createApp, createDb } from '../src/index.ts';
import type { Db } from '../src/index.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ORIGIN = 'https://tendril.example';
const DAY = Date.UTC(2026, 11, 3, 12, 0, 0); // daily #3
const SMALL = [[0, 0, 0, 1], [2, 0, 1], [5, 0, 2, 1], [7, 0, 3], [9, 0, 3], [300, 0, 4], [303, 0, 0, 3], [305, 0, 5], [306, 0, 8, 1, 4]];
const SOURCE = 'plant(wheat) -- <b>published</b>\n';

let db: Db;
let app: (r: Request) => Promise<Response>;
let time: number;

const get = (path: string, method = 'GET') => app(new Request(`http://localhost:8787${path}`, { method }));
async function enter(name: string): Promise<string> {
  const l = await (await app(new Request('http://localhost:8787/api/dev/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: name }) }))).json() as Json;
  const r = await app(new Request('http://localhost:8787/api/challenges/today/entries', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${l.token}` }, body: JSON.stringify({ rulesVersion: BASE_RULES_VERSION, actions: SMALL }) }));
  expect(r.status).toBe(200);
  return ((await r.json()) as Json).entryId as string;
}

beforeEach(() => {
  time = DAY;
  db = createDb({ url: ':memory:' });
  app = createApp({ db, env: { TENDRIL_DEV_AUTH: '1', PUBLIC_ORIGIN: ORIGIN }, setupVersion: 0, now: () => time });
});
afterEach(() => db.close());

describe('daily pages', () => {
  it('an open daily says so and lists no entries', async () => {
    await enter('Ada');
    const res = await get('/daily/3');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('still open');
    expect(html).toContain('noindex');
    expect(html).not.toContain('Watch replay');
    expect(html).not.toContain('Ada');
    expect(res.headers.get('cache-control')).toContain('max-age=60');
  });

  it('a closed daily lists winners, mosaics, replay links and the histogram in plain HTML', async () => {
    const id = await enter('Ada');
    await enter('Bob <script>alert(1)</script>');
    const [u] = await db.query<{ login: string }>('SELECT u.login FROM users u JOIN entries e ON e.user_id = u.id WHERE e.id = ?', [id]);
    await db.execute("UPDATE entries SET source = ?, source_public = 1, source_verified = 1 WHERE id = ?", [SOURCE, id]);
    time = DAY + 2 * 86_400_000; // past the legacy grace
    const res = await get('/daily/3');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('<script');
    expect(html).toContain('Wealth medal');
    expect(html).toContain('Speed medal');
    expect(html).toContain(u!.login);
    expect(html).toContain(`/play/replay.html?e=${id}`);
    expect(html).toContain('class="m"');
    expect(html).toContain('Net worth distribution');
    expect(html).toContain('Published programs');
    expect(html).toContain('&#60;b&#62;published');
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/daily/3">`);
    expect(html).not.toContain('noindex');
    expect(res.headers.get('cache-control')).toContain('s-maxage=86400');
    expect((await get('/daily/3', 'HEAD')).status).toBe(200);
  });

  it('leaves out programs that moderation hid', async () => {
    const id = await enter('Ada');
    await db.execute("UPDATE entries SET source = ?, source_public = 1, source_verified = 1 WHERE id = ?", [SOURCE, id]);
    const [e] = await db.query<{ user_id: string }>('SELECT user_id FROM entries WHERE id = ?', [id]);
    for (let i = 0; i < 3; i++) {
      await db.execute("INSERT INTO users (id, login, display_name, created_at) VALUES (?, ?, ?, 0)", [`r${i}`, `rep${i}`, `rep${i}`]).catch(() => undefined);
      await db.execute('INSERT INTO reports (entry_id, reporter_id, counted, created_at) VALUES (?, ?, 1, 0)', [id, `r${i}`]);
    }
    expect(e).toBeTruthy();
    time = DAY + 2 * 86_400_000;
    const html = await (await get('/daily/3')).text();
    expect(html).not.toContain('Published programs');
    expect(html).toContain('Wealth medal');
  });

  it('indexes closed dailies with entries and puts them in the sitemap', async () => {
    await enter('Ada');
    time = DAY + 2 * 86_400_000;
    const index = await (await get('/daily/')).text();
    expect(index).toContain(`href="${ORIGIN}/daily/3"`);
    const sm = await get('/sitemap-daily.xml');
    expect(sm.headers.get('content-type')).toContain('xml');
    const xml = await sm.text();
    expect(xml).toContain(`<loc>${ORIGIN}/daily/3</loc>`);
    expect(xml).toContain(`<loc>${ORIGIN}/daily/</loc>`);
  });

  it('keeps open dailies out of the index and sitemap, and 404s unknown numbers', async () => {
    await enter('Ada');
    expect(await (await get('/daily/')).text()).not.toContain('/daily/3');
    expect(await (await get('/sitemap-daily.xml')).text()).not.toContain('/daily/3<');
    expect((await get('/daily/9')).status).toBe(404);
    expect((await get('/daily/0')).status).toBe(404);
    expect((await get('/daily/1')).status).toBe(404); // past, nobody played
  });

  it('redirects variants to the canonical URL and leaves /api/daily alone', async () => {
    expect((await get('/daily/3?utm=x')).status).toBe(308);
    expect((await get('/daily/3/')).headers.get('location')).toBe('/daily/3');
    expect((await get('/daily')).headers.get('location')).toBe('/daily/');
    const api = await get('/api/daily');
    expect(api.headers.get('content-type')).toContain('json');
  });
});
