import { inflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, createDb, migrate } from '../src/index.ts';
import type { Db } from '../src/index.ts';
import { DAY_MS } from '../src/game.ts';
import { statsCardSvg } from '../src/players.ts';
import type { RatingCardData } from '../src/players.ts';

const NOW = Date.UTC(2026, 11, 20, 12);
const MOSAIC = '00tt1100t11t2200tt2t3300t3t3440t44t5500t5t5660tB6t6hc';
let db: Db;
let app: (r: Request) => Promise<Response>;
beforeEach(async () => { db = createDb({ url: ':memory:' }); await migrate(db); app = createApp({ db, env: { TENDRIL_DEV_AUTH: '1', TENDRIL_RATING: 'off', PUBLIC_ORIGIN: 'https://tendril.example' }, setupVersion: 0, now: () => NOW }); });
afterEach(() => db.close());

/** A rated player with a hand-written history: `ratings` are the overall rating after each of the last days. */
async function player(id: string, ratings: number[], opts: { closesAt?: number; extra?: boolean } = {}): Promise<void> {
  await db.execute('INSERT INTO users (id, github_id, login, display_name, created_at) VALUES (?, ?, ?, ?, ?)', [id, Math.abs(hash(id)), id, `Name ${id}`, 1]);
  await db.execute("INSERT INTO challenges (id, kind, number, seed, ticks, par, opens_at, closes_at, rules_version, setup_v) VALUES ('d-2026-12-19', 'daily', 1, 1, 3000, 100, 1, ?, 3, 0)", [NOW - DAY_MS]).catch(() => undefined);
  await db.execute("INSERT INTO entries (id, challenge_id, user_id, net_worth, par_tick, tokens, actions_count, log_hash, author_kind, mosaic, created_at) VALUES (?, 'd-2026-12-19', ?, 500, 90, 20, 1, ?, 'human', ?, 5)", [`e-${id}`, id, `h${id}`, MOSAIC]);
  const closes = opts.closesAt ?? NOW - DAY_MS;
  const h = ratings.map((r, i) => ({ c: 'd-2026-12-19', k: 'd', at: closes - (ratings.length - 1 - i) * DAY_MS, p: 3, f: 40, pf: r, d: r - (ratings[i - 1] ?? 1200), b: ratings[i - 1] ?? 1200, r, e: `e-${id}` }));
  const x = { r: ratings[ratings.length - 1]!, n: ratings.length, pk: Math.max(...ratings), h };
  const data = { v: 1, d: { overall: x, ...(opts.extra ? { brevity: { ...x, r: 2104 }, speed: { ...x, r: 1650 } } : {}) } };
  const n = ratings.length, r = x.r, l = closes;
  await db.execute('INSERT INTO rating_profiles (user_id, data, updated_at, r_overall, n_overall, l_overall) VALUES (?, ?, 1, ?, ?, ?)', [id, JSON.stringify(data), r, n, l]);
}
function hash(s: string): number { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }
async function plain(id: string): Promise<void> { await db.execute('INSERT INTO users (id, github_id, login, display_name, created_at) VALUES (?, ?, ?, ?, ?)', [id, Math.abs(hash(id)), id, id, 1]); }
const get = async (path: string) => { const t = Date.now(); const res = await app(new Request(`http://localhost:8787/api${path}`)); const body = Buffer.from(await res.arrayBuffer()); return { res, body, ms: Date.now() - t }; };

function pngInfo(b: Buffer): { w: number; h: number; pixels: Buffer } {
  expect(b.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
  let off = 8; const idat: Buffer[] = [];
  while (off < b.length) { const len = b.readUInt32BE(off); if (b.toString('latin1', off + 4, off + 8) === 'IDAT') idat.push(b.subarray(off + 8, off + 8 + len)); off += 12 + len; }
  return { w, h, pixels: inflateSync(Buffer.concat(idat)) };
}
const climb = (from: number, to: number, n: number): number[] => Array.from({ length: n }, (_, i) => Math.round(from + ((to - from) * (i + 1)) / n));

describe('R5 images', () => {
  beforeEach(async () => {
    await player('rated', climb(1200, 1842, 12), { extra: true, closesAt: NOW - 20 * DAY_MS });
    await player('placing', [1260, 1330]);
    await plain('fresh');
    await player('promoted', [1500, 1600, 1700, 1790, 1811]);
  });

  it('SVG card: rated, placement, unrated and unknown are valid, small, README-safe and cached an hour', async () => {
    for (const [login, text] of [['rated', '1,842'], ['placing', 'placement 2/5'], ['fresh', 'Not rated yet'], ['nobody', 'unknown player'], ['bad%20name', 'unknown player']] as const) {
      const { res, body, ms } = await get(`/card/${login}.svg`);
      const svg = body.toString();
      expect(res.status, login).toBe(200);
      expect(res.headers.get('content-type')).toContain('image/svg+xml');
      expect(res.headers.get('cache-control')).toContain('max-age=3600');
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg).toContain(text);
      expect(body.length).toBeLessThan(300_000);
      expect(ms).toBeLessThan(2000);
      // README-safe: GitHub strips scripts and drops anything that points elsewhere.
      expect(svg).not.toMatch(/<script|<style|<image|<foreignObject|<a[ >]|<use|xlink:|href=|url\(|@import|javascript:|\son[a-z]+=/i);
    }
    const rated = (await get('/card/rated.svg')).body.toString();
    expect(rated).toContain('Brevity 2,104');
    expect(rated).toContain('<polyline');
    expect(rated).toContain('Orchard');
  });

  it('SVG card escapes display names', () => {
    const d: RatingCardData = { state: 'rated', login: 'x', name: '<b>"&</b>', rating: 1500, tier: { key: 'vine', name: 'Vine' }, events: 9, peak: 1500, topPercent: 12, speed: null, brevity: null, streak: 2, spark: [1400, 1500], mosaic: null, promotion: null };
    const svg = statsCardSvg(d);
    expect(svg).not.toContain('<b>');
    expect(svg).toContain('&lt;b&gt;');
  });

  it('rating badge for rated, placement, unrated and unknown players', async () => {
    const texts: Record<string, string> = { rated: '1,842 Orchard', placing: 'placement 2/5', fresh: 'unrated', nobody: 'unknown player' };
    for (const [login, text] of Object.entries(texts)) {
      const { res, body } = await get(`/badge/rating/${login}.svg`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toContain('max-age=3600');
      expect(body.toString()).toContain(text);
      expect(body.toString()).toContain('tendril rating');
    }
    expect((await get('/card/rated.svg?v=2')).res.status).toBe(400);
  });

  it('profile preview PNGs: rated, promotion, placement, unrated and unknown are valid 1200x630 images under 300 KB', async () => {
    const sizes: Record<string, number> = {};
    const raw: Record<string, Buffer> = {};
    for (const login of ['rated', 'promoted', 'placing', 'fresh', 'nobody', 'bad%20name']) {
      const { res, body, ms } = await get(`/og/u/${login}.png`);
      expect(res.status, login).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('cache-control')).toContain('max-age=3600');
      const info = pngInfo(body);
      expect([info.w, info.h]).toEqual([1200, 630]);
      expect(info.pixels.length).toBe((1200 * 3 + 1) * 630);
      expect(body.length).toBeLessThan(300_000);
      expect(ms).toBeLessThan(2000);
      sizes[login] = body.length; raw[login] = body;
    }
    // Distinct variants: promotion differs from the plain rated image, which differs from the generic one.
    expect(raw.promoted!.equals(raw.rated!)).toBe(false);
    expect(raw.rated!.equals(raw.nobody!)).toBe(false);
    expect(raw.nobody!.equals(raw['bad%20name']!)).toBe(true);
    expect((await app(new Request('http://localhost:8787/og/u/rated.png'))).status).toBe(200);
    expect((await get('/og/u/rated.png?x=1')).res.status).toBe(308);
    expect((await app(new Request('http://localhost:8787/api/og/u/rated.png', { method: 'POST' }))).status).toBe(405);
  });

  it('shows the promotion only when the newest result crossed a tier floor in the last week', async () => {
    await player('up', [1600, 1700, 1750, 1790, 1811]);       // 1790 Bloom -> 1811 Orchard, yesterday
    await player('oldup', [1600, 1700, 1750, 1790, 1811], { closesAt: NOW - 30 * DAY_MS });
    await player('placeup', [1190, 1210]);        // crossed Shoot but still in placement
    const { loadRatingCard } = await import('../src/players.ts');
    expect((await loadRatingCard(db, 'up', NOW)).promotion).toMatchObject({ tier: { key: 'orchard' }, rating: 1811 });
    expect((await loadRatingCard(db, 'oldup', NOW)).promotion).toBeNull();
    expect((await loadRatingCard(db, 'placeup', NOW)).promotion).toBeNull();
    expect((await loadRatingCard(db, 'rated', NOW)).promotion).toBeNull();
  });
});
