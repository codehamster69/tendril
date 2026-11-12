// B4: share links (/r/<entryId>) and preview image cards (/api/og/<entryId>.png).
// No image library: the card is rasterised here (flat colours + a 5x7 bitmap font) and encoded with node:zlib.
import { deflateSync } from 'node:zlib';
import type { Db } from './db.ts';
import { percentileOf } from './arena.ts';

export const CARD_W = 1200;
export const CARD_H = 630;
const ENTRY_ID = /^[A-Za-z0-9_-]{12}$/;

// ---------- raster ----------
type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

class Canvas {
  readonly data = new Uint8Array(CARD_W * CARD_H * 3);
  rect(x: number, y: number, w: number, h: number, c: RGB): void {
    const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(CARD_W, x + w), y1 = Math.min(CARD_H, y + h);
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = (yy * CARD_W + xx) * 3; this.data[i] = c[0]; this.data[i + 1] = c[1]; this.data[i + 2] = c[2]; }
  }
  text(s: string, x: number, y: number, scale: number, c: RGB): void {
    let cx = x;
    for (const ch of s.toUpperCase()) {
      const g = FONT[ch] ?? FONT['?']!;
      for (let r = 0; r < 7; r++) for (let q = 0; q < 5; q++) if (g[r]![q] === '#') this.rect(cx + q * scale, y + r * scale, scale, scale, c);
      cx += 6 * scale;
    }
  }
}
export const textWidth = (s: string, scale: number): number => Math.max(0, s.length * 6 * scale - scale);

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf: Uint8Array): number { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, body: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0); out.write(type, 4, 'latin1'); out.set(body, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}
export function encodePng(rgb: Uint8Array, w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array())]);
}

// 5x7 glyphs, upper case only; anything else prints as "?".
const G = (s: string): string[] => s.split(' ');
const FONT: Record<string, string[]> = {
  ' ': G('..... ..... ..... ..... ..... ..... .....'),
  A: G('.###. #...# #...# ##### #...# #...# #...#'), B: G('####. #...# #...# ####. #...# #...# ####.'),
  C: G('.###. #...# #.... #.... #.... #...# .###.'), D: G('####. #...# #...# #...# #...# #...# ####.'),
  E: G('##### #.... #.... ####. #.... #.... #####'), F: G('##### #.... #.... ####. #.... #.... #....'),
  G: G('.###. #...# #.... #.### #...# #...# .###.'), H: G('#...# #...# #...# ##### #...# #...# #...#'),
  I: G('##### ..#.. ..#.. ..#.. ..#.. ..#.. #####'), J: G('..### ...#. ...#. ...#. ...#. #..#. .##..'),
  K: G('#...# #..#. #.#.. ##... #.#.. #..#. #...#'), L: G('#.... #.... #.... #.... #.... #.... #####'),
  M: G('#...# ##.## #.#.# #.#.# #...# #...# #...#'), N: G('#...# ##..# #.#.# #..## #...# #...# #...#'),
  O: G('.###. #...# #...# #...# #...# #...# .###.'), P: G('####. #...# #...# ####. #.... #.... #....'),
  Q: G('.###. #...# #...# #...# #.#.# #..#. .##.#'), R: G('####. #...# #...# ####. #.#.. #..#. #...#'),
  S: G('.#### #.... #.... .###. ....# ....# ####.'), T: G('##### ..#.. ..#.. ..#.. ..#.. ..#.. ..#..'),
  U: G('#...# #...# #...# #...# #...# #...# .###.'), V: G('#...# #...# #...# #...# #...# .#.#. ..#..'),
  W: G('#...# #...# #...# #.#.# #.#.# ##.## #...#'), X: G('#...# #...# .#.#. ..#.. .#.#. #...# #...#'),
  Y: G('#...# #...# .#.#. ..#.. ..#.. ..#.. ..#..'), Z: G('##### ....# ...#. ..#.. .#... #.... #####'),
  '0': G('.###. #...# #..## #.#.# ##..# #...# .###.'), '1': G('..#.. .##.. ..#.. ..#.. ..#.. ..#.. .###.'),
  '2': G('.###. #...# ....# ...#. ..#.. .#... #####'), '3': G('####. ....# ....# .###. ....# ....# ####.'),
  '4': G('...#. ..##. .#.#. #..#. ##### ...#. ...#.'), '5': G('##### #.... ####. ....# ....# #...# .###.'),
  '6': G('.###. #.... #.... ####. #...# #...# .###.'), '7': G('##### ....# ...#. ..#.. .#... .#... .#...'),
  '8': G('.###. #...# #...# .###. #...# #...# .###.'), '9': G('.###. #...# #...# .#### ....# ....# .###.'),
  '.': G('..... ..... ..... ..... ..... ..##. ..##.'), ',': G('..... ..... ..... ..... ..##. ..#.. .#...'),
  ':': G('..... ..##. ..##. ..... ..##. ..##. .....'), '-': G('..... ..... ..... ##### ..... ..... .....'),
  '#': G('.#.#. .#.#. ##### .#.#. ##### .#.#. .#.#.'), '%': G('##..# ##..# ...#. ..#.. .#... #..## #..##'),
  '/': G('....# ....# ...#. ..#.. .#... #.... #....'), '!': G('..#.. ..#.. ..#.. ..#.. ..#.. ..... ..#..'),
  '?': G('.###. #...# ....# ...#. ..#.. ..... ..#..'), "'": G('..#.. ..#.. .#... ..... ..... ..... .....'),
  '+': G('..... ..#.. ..#.. ##### ..#.. ..#.. .....'), '_': G('..... ..... ..... ..... ..... ..... #####'),
};

// ---------- card ----------
const TILE: Record<string, RGB> = {
  B: hex('#a0522d'), h: hex('#f2c230'), c: hex('#5b6b3a'), '1': hex('#e8c547'), '2': hex('#e0803f'), '3': hex('#d94f4f'),
  '4': hex('#8bc34a'), '5': hex('#b06fd1'), '6': hex('#4fb3d9'), t: hex('#6b4a2f'), '0': hex('#2f3f33'),
};
const BG = hex('#12201a'), PANEL = hex('#0b1410'), GREEN = hex('#7bc96f'), WHITE = hex('#f4f1e6'), GOLD = hex('#f2c230'), DIM = hex('#9fb3a4');

export interface CardData {
  mosaic: string | null;
  title: string;          // "DAILY #12"
  netWorth: number | null;
  par: number | null;
  topPercent: number | null;
  player: string;
  isModel: boolean;
  host: string;
}

export function renderCard(d: CardData): Buffer {
  const cv = new Canvas();
  cv.rect(0, 0, CARD_W, CARD_H, BG);
  cv.rect(0, 0, CARD_W, 10, GREEN);
  const T = 56, GAP = 4, MX = 60, MY = 77, side = 8 * T + 7 * GAP;
  cv.rect(MX - 12, MY - 12, side + 24, side + 24, PANEL);
  const mosaic = d.mosaic && d.mosaic.length === 64 ? d.mosaic : '00tt1100t11t2200tt2t3300t3t3440t44t5500t5t5660tB6t6hc';
  for (let i = 0; i < 64; i++) {
    const c = TILE[mosaic[i]!] ?? TILE['0']!;
    cv.rect(MX + (i % 8) * (T + GAP), MY + Math.floor(i / 8) * (T + GAP), T, T, c);
  }
  const X = 580, maxW = CARD_W - X - 40;
  cv.text('TENDRIL', X, 52, 6, GREEN);
  cv.text(d.title, X, 118, 5, DIM);
  if (d.netWorth !== null) {
    const nw = String(d.netWorth);
    const s = textWidth(nw, 16) <= maxW ? 16 : 11;
    cv.text(nw, X, 176, s, WHITE);
    cv.text('NET WORTH', X, 176 + 7 * s + 14, 4, DIM);
    let y = 176 + 7 * s + 62;
    if (d.topPercent !== null) { cv.text(`TOP ${d.topPercent}%`, X, y, 6, GOLD); y += 66; }
    if (d.par !== null) cv.text(d.netWorth >= d.par ? `BEATS PAR ${d.par}` : `PAR ${d.par}`, X, y, 4, d.netWorth >= d.par ? GREEN : DIM);
    let name = d.player.toUpperCase() + (d.isModel ? ' (AI)' : '');
    while (name.length > 1 && textWidth(name, 5) > maxW) name = name.slice(0, -1);
    cv.text(name, X, 520, 5, WHITE);
  } else {
    cv.text('FARM. CODE. COMPETE.', X, 190, 5, WHITE);
    cv.text('WRITE A SCRIPT THAT RUNS', X, 280, 4, DIM);
    cv.text('YOUR FARM. BEAT TODAY\'S PAR.', X, 330, 4, DIM);
  }
  cv.text(d.host.toUpperCase().slice(0, 28), X, 586, 3, DIM);
  return encodePng(cv.data, CARD_W, CARD_H);
}

// ---------- data ----------
interface ShareRow {
  user_id: string; net_worth: number; mosaic: string | null; author_kind: string; display_name: string; login: string;
  challenge_id: string; kind: string; number: number | null; par: number | null;
}
export interface ShareInfo extends CardData { entryId: string; login: string; description: string }

const titleOf = (kind: string, number: number | null): string => (kind === 'duel' ? 'DUEL' : `${kind === 'season' ? 'WEEKLY' : 'DAILY'}${number !== null && number > 0 ? ` #${number}` : ''}`);

export async function loadShare(db: Db, id: string, host: string): Promise<ShareInfo | null> {
  if (!ENTRY_ID.test(id)) return null;
  const [r] = await db.query<ShareRow>(
    `SELECT e.user_id, e.net_worth, e.mosaic, e.author_kind, u.display_name, u.login, c.id AS challenge_id, c.kind, c.number, c.par
     FROM entries e JOIN users u ON u.id = e.user_id JOIN challenges c ON c.id = e.challenge_id WHERE e.id = ?`, [id]);
  if (!r) return null;
  const [t] = await db.query<{ total: number; better: number }>(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN best > ? THEN 1 ELSE 0 END) AS better FROM
       (SELECT MAX(net_worth) AS best FROM entries WHERE challenge_id = ? GROUP BY user_id)`, [r.net_worth, r.challenge_id]);
  const total = Number(t?.total ?? 0), rank = Number(t?.better ?? 0) + 1;
  const topPercent = total >= 2 ? Math.max(1, 100 - percentileOf(rank, total) + 1) : null;
  const title = titleOf(r.kind, r.number);
  const who = r.display_name || r.login;
  return {
    entryId: id, login: r.login, mosaic: r.mosaic, title, netWorth: r.net_worth, par: r.par, topPercent, player: who, isModel: r.author_kind === 'model', host,
    description: `${who} reached a net worth of ${r.net_worth}${topPercent !== null ? ` (top ${topPercent}%)` : ''} in Tendril ${title.toLowerCase()}. Watch the replay and beat it.`,
  };
}

const GENERIC: Omit<CardData, 'host'> = { mosaic: null, title: 'THE FARMING GAME YOU CODE', netWorth: null, par: null, topPercent: null, player: '', isModel: false };

/** One row per entry, day and kind. The table is created on first use so it needs no migration. */
const hitsReady = new WeakMap<Db, Promise<unknown>>();
export async function countHit(db: Db, id: string, kind: 'page' | 'card', now: number): Promise<void> {
  try {
    if (!hitsReady.has(db)) hitsReady.set(db, db.execute('CREATE TABLE IF NOT EXISTS share_hits (entry_id TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (entry_id, day, kind))').catch((e: unknown) => { hitsReady.delete(db); throw e; }));
    await hitsReady.get(db);
    await db.execute('INSERT INTO share_hits (entry_id, day, kind, hits) VALUES (?, ?, ?, 1) ON CONFLICT (entry_id, day, kind) DO UPDATE SET hits = hits + 1', [id, new Date(now).toISOString().slice(0, 10), kind]);
  } catch { /* metrics must never break a share */ }
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function sharePage(info: ShareInfo | null, origin: string, id: string): string {
  const title = info ? `${info.player} scored ${info.netWorth} on Tendril ${info.title.toLowerCase()}` : 'Tendril: the farming game you code';
  const desc = info ? info.description : 'Write a script that runs your farm. Play the daily challenge and beat par.';
  const image = info ? `${origin}/api/og/${id}.png` : `${origin}/api/og/none.png`;
  const dest = info ? `${origin}/play/?replay=${id}` : `${origin}/play/`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="canonical" href="${esc(info ? `${origin}/r/${id}` : origin)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Tendril"><meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(info ? `${origin}/r/${id}` : origin)}">
<meta property="og:image" content="${esc(image)}"><meta property="og:image:type" content="image/png"><meta property="og:image:width" content="${CARD_W}"><meta property="og:image:height" content="${CARD_H}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(image)}">
<meta http-equiv="refresh" content="0;url=${esc(dest)}"></head>
<body style="font:16px system-ui,sans-serif;background:#12201a;color:#f4f1e6;padding:2rem"><p><a style="color:#7bc96f" href="${esc(dest)}">${esc(info ? 'Open the replay' : 'Open Tendril')}</a></p></body></html>`;
}

export interface ShareCtx { db: Db; now: number; origin: string; host: string }

/** Handles /r/<id> and /api/og/<id>.png (also reached as /og/...). Returns null for any other path. */
export async function handleShare(path: string, method: string, c: ShareCtx): Promise<Response | null> {
  const page = /^(?:\/api)?\/r\/([^/]+)$/.exec(path);
  const card = /^(?:\/api)?\/og\/([^/]+)\.png$/.exec(path);
  if (!page && !card) return null;
  if (method !== 'GET' && method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  const id = (page ?? card)![1]!;
  const info = await loadShare(c.db, id, c.host);
  if (info) await countHit(c.db, id, page ? 'page' : 'card', c.now);
  const base = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  if (page) {
    return new Response(method === 'HEAD' ? null : sharePage(info, c.origin, id), { status: 200, headers: {
      ...base, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': info ? 'public, max-age=60, s-maxage=300' : 'public, max-age=60, s-maxage=60',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; frame-ancestors 'none'" } });
  }
  const png = renderCard(info ?? { ...GENERIC, host: c.host });
  return new Response(method === 'HEAD' ? null : new Uint8Array(png), { status: 200, headers: {
    ...base, 'Content-Type': 'image/png', 'Content-Length': String(png.length),
    'Cache-Control': info ? 'public, max-age=3600, s-maxage=86400' : 'public, max-age=300, s-maxage=3600' } });
}
