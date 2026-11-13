// G2: public, crawlable pages for closed dailies: /daily/ (index), /daily/<number> and /sitemap-daily.xml.
// Real server-rendered HTML (no script), so crawlers see the winners. A closed daily never changes, so pages carry long CDN
// cache headers: one render per closed daily per cache lifetime. Only logins are shown (never display names or model names),
// replays and programs only once the challenge is settled, and programs hidden by moderation are left out.
import { challengeSetup, DAILY_EPOCH, describeModifiers } from '@tendril/sim/src/index.ts';
import type { Db } from './db.ts';
import { board, isSettled } from './arena.ts';
import type { BoardRow, ChallengeRow, Medal } from './arena.ts';
import { DAY_MS, utcDate } from './game.ts';
import { hiddenSql } from './moderation.ts';
import { TILE_HEX } from './share.ts';

const MEDALS: { medal: Medal; title: string; unit: string }[] = [
  { medal: 'wealth', title: 'Wealth', unit: 'net worth' },
  { medal: 'speed', title: 'Speed', unit: 'ticks to par' },
  { medal: 'brevity', title: 'Brevity', unit: 'tokens' },
];
const PROGRAMS_SHOWN = 3;
const PROGRAM_CHARS = 3000;
export const INDEX_MAX = 500;
export const SITEMAP_MAX = 5000;

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; frame-ancestors 'none'",
};
/** Closed dailies never change (moderation hides are the one exception, and they may take a day to show). */
const CLOSED_CACHE = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800';
const SHORT_CACHE = 'public, max-age=60, s-maxage=300';

/** Date of daily number n (1 = DAILY_EPOCH). */
export const dateOfNumber = (n: number): string => utcDate(Date.parse(`${DAILY_EPOCH}T00:00:00Z`) + (n - 1) * DAY_MS);

export interface DailyPagesCtx { db: Db; now: number; origin: string; search?: string }

// ---------- html ----------
const CSS = `body{font:16px/1.55 system-ui,sans-serif;background:#12201a;color:#f4f1e6;margin:0;padding:1.5rem}main{max-width:52rem;margin:0 auto}
a{color:#7bc96f}h1{font-size:1.9rem;margin:.2em 0}h2{font-size:1.2rem;margin-top:2em;color:#f2c230}table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:.35rem .6rem;border-bottom:1px solid #2a3d33}th{color:#9fb3a4;font-weight:600}.dim{color:#9fb3a4}
.m{display:inline-grid;grid-template-columns:repeat(8,10px);gap:1px;vertical-align:middle}.m i{display:block;width:10px;height:10px}
pre{background:#0b1410;padding:.8rem;overflow:auto;border-radius:6px;font-size:.85rem}.bar{display:inline-block;background:#7bc96f;height:.8rem}nav a{margin-right:1rem}`;

function mosaicHtml(mosaic: string | null): string {
  if (!mosaic || mosaic.length !== 64) return '';
  let cells = '';
  for (const ch of mosaic) cells += `<i style="background:${TILE_HEX[ch] ?? TILE_HEX['0']}"></i>`;
  return `<span class="m" role="img" aria-label="Farm mosaic">${cells}</span>`;
}

function shell(title: string, desc: string, canonical: string | null, body: string, origin: string, index: boolean): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}"><meta name="viewport" content="width=device-width,initial-scale=1">
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ''}${index ? '' : '<meta name="robots" content="noindex">'}
<meta property="og:type" content="website"><meta property="og:site_name" content="Tendril"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<style>${CSS}</style></head><body><main><nav><a href="${esc(origin)}/">Tendril</a><a href="${esc(origin)}/daily/">Past dailies</a><a href="${esc(origin)}/play/?mode=daily">Play today's daily</a></nav>${body}</main></body></html>`;
}

const fmtDate = (date: string): string => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });

function winnersHtml(origin: string, medal: { title: string; unit: string }, rows: BoardRow[]): string {
  if (!rows.length) return `<h2>${medal.title} medal</h2><p class="dim">No entries for this medal.</p>`;
  const trs = rows.map((r) => `<tr><td>${r.rank}</td><td>${esc(r.login)}${r.authorKind === 'model' ? ' <span class="dim">(AI)</span>' : ''}</td><td>${r.value}</td><td>${mosaicHtml(r.mosaic)}</td>` +
    `<td>${r.mosaic ? `<a href="${esc(origin)}/play/replay.html?e=${esc(r.entryId)}">Watch replay</a>` : '<span class="dim">no replay</span>'}</td></tr>`).join('');
  return `<h2>${medal.title} medal</h2><table><thead><tr><th>#</th><th>Player</th><th>${esc(medal.unit)}</th><th>Farm</th><th></th></tr></thead><tbody>${trs}</tbody></table>`;
}

function histogramHtml(h: { min: number; width: number; counts: number[] }, total: number): string {
  if (!total) return '';
  const peak = Math.max(...h.counts, 1);
  const rows = h.counts.map((n, i) => `<tr><td>${h.min + i * h.width} to ${h.min + (i + 1) * h.width - 1}</td><td>${n}</td><td><span class="bar" style="width:${Math.round((n / peak) * 100)}%"></span></td></tr>`).join('');
  return `<h2>Net worth distribution</h2><table><thead><tr><th>Net worth</th><th>Players</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

interface ProgramRow { id: string; net_worth: number; author_kind: string; login: string; source: string }
async function programs(db: Db, c: ChallengeRow): Promise<ProgramRow[]> {
  return db.query<ProgramRow>(
    `SELECT e.id, e.net_worth, e.author_kind, u.login, e.source FROM entries e JOIN users u ON u.id = e.user_id
     WHERE e.challenge_id = ? AND e.source_public = 1 AND e.source_verified = 1 AND e.source IS NOT NULL AND NOT ${hiddenSql('e.id')}
     ORDER BY e.net_worth DESC, e.created_at ASC, e.id ASC LIMIT ?`, [c.id, PROGRAMS_SHOWN]);
}

export function openPage(c: { number: number | null }, date: string, origin: string): string {
  const title = `Tendril daily #${c.number} (${date}): still open`;
  return shell(title, 'This daily challenge is still open. Results are published here once it closes.', `${origin}/daily/${c.number}`,
    `<h1>Daily #${c.number} is still open</h1><p>This challenge (${esc(fmtDate(date))}) has not closed yet, so its results are not public. Results, replays and published programs appear here once it closes.</p>` +
    `<p><a href="${esc(origin)}/play/?mode=daily">Play it now</a></p>`, origin, false);
}

export async function closedPage(db: Db, c: ChallengeRow, origin: string): Promise<string> {
  const date = c.id.slice(2);
  const mods = describeModifiers(challengeSetup('daily', c.seed, c.setup_v).modifiers, 'daily');
  const boards = await Promise.all(MEDALS.map((m) => board(db, c, { medal: m.medal, friends: false, limit: 3 })));
  const wealth = boards[0]!;
  const progs = await programs(db, c);
  const top = wealth.entries[0];
  const title = `Tendril daily #${c.number}, ${fmtDate(date)}: results and winners`;
  const desc = `Tendril daily challenge #${c.number} (${date}): ${wealth.total} players${top ? `, top net worth ${top.value} by ${top.login}` : ''}. Winners, replays and published Sprout programs.`;
  const body = `<h1>Daily #${c.number}</h1><p class="dim">${esc(fmtDate(date))} · ${c.ticks.toLocaleString('en-US')} ticks · par ${c.par ?? 'none'} · ${wealth.total} player${wealth.total === 1 ? '' : 's'}</p>` +
    `<p>${mods.length ? `Modifiers: ${esc(mods.join(', '))}.` : 'Plain farm, no modifiers.'}</p>` +
    MEDALS.map((m, i) => winnersHtml(origin, m, boards[i]!.entries)).join('') +
    histogramHtml(wealth.histogram, wealth.total) +
    (progs.length ? `<h2>Published programs</h2>${progs.map((p) => `<h3>${esc(p.login)}${p.author_kind === 'model' ? ' (AI)' : ''}: ${p.net_worth}</h3><pre>${esc(p.source.slice(0, PROGRAM_CHARS))}${p.source.length > PROGRAM_CHARS ? '\n...' : ''}</pre>`).join('')}` : '') +
    `<p><a href="${esc(origin)}/daily/${(c.number ?? 0) - 1}">Previous daily</a> · <a href="${esc(origin)}/daily/${(c.number ?? 0) + 1}">Next daily</a> · <a href="${esc(origin)}/daily/">All dailies</a></p>`;
  return shell(title, desc, `${origin}/daily/${c.number}`, body, origin, wealth.total > 0);
}

async function listed(db: Db, now: number, limit: number): Promise<ChallengeRow[]> {
  const rows = await db.query<ChallengeRow>(
    `SELECT * FROM challenges WHERE kind = 'daily' AND number >= 1 AND n_wealth > 0 AND closes_at IS NOT NULL AND closes_at <= ? ORDER BY number DESC LIMIT ?`, [now, limit]);
  return rows.filter((c) => isSettled(c, now));
}

export async function indexPage(db: Db, now: number, origin: string): Promise<string> {
  const rows = await listed(db, now, INDEX_MAX);
  const trs = rows.map((c) => `<tr><td><a href="${esc(origin)}/daily/${c.number}">Daily #${c.number}</a></td><td>${esc(c.id.slice(2))}</td><td>${c.n_wealth}</td></tr>`).join('');
  return shell('Tendril daily challenges: past results', 'Every closed Tendril daily challenge with its winners, replays and published Sprout programs.', `${origin}/daily/`,
    `<h1>Past dailies</h1><p>Each daily is the same farm for everyone. These are the closed ones, newest first.</p>` +
    (rows.length ? `<table><thead><tr><th>Daily</th><th>Date</th><th>Players</th></tr></thead><tbody>${trs}</tbody></table>` : '<p class="dim">No daily has closed yet.</p>'), origin, true);
}

export async function sitemapXml(db: Db, now: number, origin: string): Promise<string> {
  const rows = await listed(db, now, SITEMAP_MAX);
  const url = (loc: string, lastmod?: string): string => `<url><loc>${esc(loc)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`;
  const lastOf = (c: ChallengeRow): string => utcDate(c.closes_at!);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${url(`${origin}/daily/`, rows[0] ? lastOf(rows[0]) : undefined)}${rows.map((c) => url(`${origin}/daily/${c.number}`, lastOf(c))).join('')}</urlset>\n`;
}

/** Handles /daily, /daily/<n> and /sitemap-daily.xml (not under /api: /api/daily is the JSON route). Returns null for any other path. */
export async function handleDailyPages(path: string, method: string, c: DailyPagesCtx): Promise<Response | null> {
  const m = /^(\/daily\/?|\/daily\/(\d{1,5})\/?|\/sitemap-daily\.xml)$/.exec(path);
  if (!m) return null;
  if (method !== 'GET' && method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  const bare = path;
  const canonical = bare.replace(/(?<=.)\/$/, '').replace(/^\/daily$/, '/daily/');
  if (c.search || canonical !== bare) return new Response(null, { status: 308, headers: { Location: canonical, 'Cache-Control': 'public, max-age=3600, s-maxage=86400', 'X-Content-Type-Options': 'nosniff' } });
  const send = (body: string, type: string, cache: string, status = 200): Response =>
    new Response(method === 'HEAD' ? null : body, { status, headers: { ...BASE_HEADERS, 'Content-Type': type, 'Cache-Control': cache } });
  const html = 'text/html; charset=utf-8';

  if (bare === '/sitemap-daily.xml') return send(await sitemapXml(c.db, c.now, c.origin), 'application/xml; charset=utf-8', SHORT_CACHE);
  if (bare === '/daily/') return send(await indexPage(c.db, c.now, c.origin), html, 'public, max-age=300, s-maxage=3600');

  const n = Number(m[2]);
  const date = n >= 1 ? dateOfNumber(n) : null;
  const notFound = (): Response => send(shell('Daily not found', 'No such daily challenge.', null, '<h1>No such daily</h1><p><a href="/daily/">See all dailies</a></p>', c.origin, false), html, 'public, max-age=60, s-maxage=300', 404);
  if (!date || date > utcDate(c.now)) return notFound();
  const [row] = await c.db.query<ChallengeRow>("SELECT * FROM challenges WHERE id = ? AND kind = 'daily'", [`d-${date}`]);
  if (row && isSettled(row, c.now)) return send(await closedPage(c.db, row, c.origin), html, CLOSED_CACHE);
  // Today's daily, or yesterday's during the legacy grace: nothing is public yet. An old date nobody played has no page.
  if (row || date === utcDate(c.now)) return send(openPage({ number: n }, date, c.origin), html, SHORT_CACHE);
  return notFound();
}
