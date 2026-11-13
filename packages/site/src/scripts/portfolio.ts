// Player portfolio: fills components/Portfolio.astro from GET /api/players/:login (rating, medals, streak, recent).
// Static site, so everything renders at view time and fails soft. Text is always set with textContent.

import { api, arenaCss, el, fmt, mosaicEl } from './arena';

type Disc = 'overall' | 'speed' | 'brevity';
const DISCS: Disc[] = ['overall', 'speed', 'brevity'];
const DISC_LABEL: Record<Disc, string> = { overall: 'Overall', speed: 'Speed', brevity: 'Brevity' };
const PLACEMENT_EVENTS = 5;
/** Tier floors, for the ladder and chart bands. The API's `tier` is authoritative for the player; these are the display table. */
const TIERS = [
  { key: 'seed', name: 'Seed', floor: 0 }, { key: 'seedling', name: 'Seedling', floor: 1000 }, { key: 'shoot', name: 'Shoot', floor: 1200 },
  { key: 'vine', name: 'Vine', floor: 1400 }, { key: 'bloom', name: 'Bloom', floor: 1600 }, { key: 'orchard', name: 'Orchard', floor: 1800 },
  { key: 'grove', name: 'Grove', floor: 2000 }, { key: 'evergreen', name: 'Evergreen', floor: 2300 },
];
const tierAt = (r: number) => TIERS.reduce((t, x) => (r >= x.floor ? x : t), TIERS[0]!);

interface Tier { key: string; name: string; floor: number; next: number | null }
interface HistoryRow { challengeId: string; kind: 'daily' | 'season'; closesAt: string | number; place: number; field: number; performance: number; delta: number; before: number; rating: number; entryId: string }
interface Rating { rating: number; tier: Tier; provisional: boolean; events: number; peak: number; rank: number | null; percentile: number | null; history: HistoryRow[] }
interface Recent { entryId: string; challengeId: string; kind: 'daily' | 'season' | 'duel'; number: number | null; netWorth: number; parTick: number | null; tokens: number | null; mosaic: string | null; createdAt: string | number }
type PinRef = string | { entryId: string; rank?: number; players?: number };
/** Rank among the challenge's players for each pinned entry, from the player API and the PUT response. */
const pinRank = new Map<string, { rank: number; players: number }>();
const noteRanks = (list: PinRef[] | undefined) => { for (const x of list ?? []) if (typeof x !== 'string' && x.rank && x.players) pinRank.set(x.entryId, { rank: x.rank, players: x.players }); };
export interface Profile {
  login: string; displayName?: string; avatarUrl?: string; streak?: { current: number; best: number; lastDay: string | null };
  medals?: Partial<Record<'wealth' | 'speed' | 'brevity', number>>; topPercent?: number | null; viewer?: { isSelf: boolean; following: boolean } | null;
  followers?: number; following?: number; recent?: Recent[];
  rating?: Partial<Record<Disc, Rating | null>>;
  /** Up to three published programs the owner pinned (public ones only). Always present from the server. */
  pinned?: PinRef[];
  /** UTC dates (YYYY-MM-DD) with a daily/season entry in the last 140 days. */
  days?: string[];
}
interface SourceView { entryId: string; source: string; tokens: number | null; netWorth: number; parTick: number | null; challenge: { id: string; kind: string; number: number | null } }

const q = <T extends HTMLElement>(root: ParentNode, s: string) => root.querySelector<T>(s)!;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ms = (t: string | number) => (typeof t === 'number' ? t : Date.parse(t));
const dateKey = (t: number) => new Date(t).toISOString().slice(0, 10);
const shortDate = (key: string) => `${Number(key.slice(8, 10))} ${MON[Number(key.slice(5, 7)) - 1]}`;
const signed = (n: number) => (n > 0 ? `+${fmt.format(n)}` : n < 0 ? `−${fmt.format(-n)}` : '0');
const ord = (n: number) => { const v = n % 100; return `${n}${v >= 11 && v <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`; };

/** UTC day a challenge belongs to: a daily's own date, a season's last open day. */
export function dayOfChallenge(id: string, closesAt: string | number): string {
  const m = /^d-(\d{4}-\d{2}-\d{2})$/.exec(id);
  return m ? m[1]! : dateKey(ms(closesAt) - 1);
}
function challengeName(id: string, kind: string, number: number | null | undefined): string {
  if (kind === 'season') { const w = /W(\d+)$/.exec(id); return w ? `Season W${w[1]}` : 'Season'; }
  return number != null && number > 0 ? `Daily #${number}` : 'Daily';
}

/** Short summary for <title>/<meta>; exported for tests. */
export function describe(p: Profile): { title: string; description: string } {
  const name = p.displayName || p.login;
  const o = p.rating?.overall;
  const bits: string[] = [];
  let title = name;
  if (o && !o.provisional) {
    title = `${name}: ${fmt.format(o.rating)} ${o.tier.name}`;
    bits.push(`${fmt.format(o.rating)} ${o.tier.name}${o.percentile != null ? `, top ${Math.max(1, Math.ceil(o.percentile))}%` : ''} on the Tendril rating ladder`);
  } else if (o) {
    bits.push(`In placement, ${Math.min(o.events, PLACEMENT_EVENTS)} of ${PLACEMENT_EVENTS} rated days`);
  } else {
    bits.push('No rated runs yet');
  }
  if (p.streak?.current) bits.push(`${p.streak.current}-day streak`);
  const m = p.medals ?? {};
  const medals = (m.wealth ?? 0) + (m.speed ?? 0) + (m.brevity ?? 0);
  if (medals) bits.push(`${medals} first place${medals === 1 ? '' : 's'}`);
  return { title, description: `${name} (@${p.login}) on Tendril: ${bits.join(', ')}. Every rating point links to a replay of the run.` };
}

function setMeta(sel: string, attr: string, value: string) {
  let m = document.head.querySelector<HTMLMetaElement>(sel);
  if (!m) { m = document.createElement('meta'); m.setAttribute(attr.split('=')[0]!, attr.split('=')[1]!); document.head.append(m); }
  m.setAttribute('content', value);
}
function setHead(title: string, description: string, login: string | null) {
  document.title = `${title} | Tendril`;
  setMeta('meta[name="description"]', 'name=description', description);
  setMeta('meta[property="og:title"]', 'property=og:title', `${title} | Tendril`);
  setMeta('meta[property="og:description"]', 'property=og:description', description);
  if (login) {
    const href = `${location.origin}/u/?login=${encodeURIComponent(login)}`;
    document.head.querySelector('link[rel="canonical"]')?.setAttribute('href', href);
    setMeta('meta[property="og:url"]', 'property=og:url', href);
  }
}

export async function initPortfolio(root: HTMLElement): Promise<void> {
  const style = document.createElement('style');
  style.textContent = arenaCss;
  document.head.append(style);
  const state = q(root, '[data-state]');
  const login = new URLSearchParams(location.search).get('login')?.trim() ?? '';
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) {
    setHead('Player', "A Tendril player's rating, medals and recent daily farms.", null);
    state.textContent = 'No player chosen. Open a name from the leaderboard.';
    return;
  }
  const p = await api<Profile>(`/players/${encodeURIComponent(login)}`);
  if (!p) {
    setHead(login, `No Tendril player called ${login} was found.`, null);
    state.textContent = `We couldn't find a player called ${login}. Check the spelling, or open a name from the leaderboard.`;
    return;
  }
  const d = describe(p);
  setHead(d.title, d.description, p.login);
  state.hidden = true;
  q(root, '[data-profile]').hidden = false;
  render(root, p);
}

function render(root: HTMLElement, p: Profile) {
  const name = p.displayName || p.login;
  const ratings = p.rating ?? {};
  const over = ratings.overall ?? null;
  const placement = !!over?.provisional;
  const rated = !!over && !placement;
  const tierKey = rated ? over.tier.key : 'shoot';
  root.style.setProperty('--tier', `var(--tier-${tierKey})`);

  // identity band
  q(root, '[data-name]').textContent = name;
  const initials = q(root, '[data-initials]');
  initials.textContent = name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toLowerCase();
  if (p.avatarUrl && /^https:\/\//.test(p.avatarUrl)) {
    const img = q<HTMLImageElement>(root, '[data-avatar]');
    img.src = p.avatarUrl; img.hidden = false; initials.hidden = true;
  }
  const sub = q(root, '[data-sub]');
  const gh = el('a', undefined, `github.com/${p.login}`); gh.href = `https://github.com/${encodeURIComponent(p.login)}`; gh.rel = 'noopener';
  sub.append(gh, el('span', undefined, `${fmt.format(p.followers ?? 0)} followers`), el('span', undefined, `following ${fmt.format(p.following ?? 0)}`));
  if (over) sub.append(el('span', undefined, `Rated days: ${fmt.format(over.events)}`));
  const bigN = q(root, '[data-big-n]'), bigT = q(root, '[data-big-t]');
  if (rated) {
    bigN.textContent = fmt.format(over.rating);
    bigT.textContent = `${over.tier.name}${over.percentile != null ? ` · top ${Math.max(1, Math.ceil(over.percentile))}%` : ''}`;
  } else if (placement) {
    bigN.textContent = `${fmt.format(over.rating)}?`;
    bigT.textContent = `In placement, ${Math.min(over.events, PLACEMENT_EVENTS)} of ${PLACEMENT_EVENTS}`;
    bigT.classList.add('plain');
  } else {
    bigN.textContent = 'Unrated';
    bigN.style.color = 'var(--dim)';
    bigT.textContent = 'No rated runs yet';
    bigT.classList.add('plain');
  }
  const banner = q(root, '[data-banner]');
  if (placement) {
    banner.hidden = false;
    banner.textContent = `Ratings move fast during placement and the tier title appears after ${PLACEMENT_EVENTS} rated days. This one has ${over.events}. Until then the player stays off the rating leaderboard.`;
  } else if (!over) {
    banner.hidden = false;
    banner.textContent = 'A run that reaches par in a daily or weekly season gets a rating when that challenge closes. Streaks and medals below count either way.';
  }

  // facts
  const allHist = DISCS.flatMap((k) => ratings[k]?.history ?? []);
  const bestDaily = (over?.history ?? []).filter((h) => h.kind === 'daily').reduce<HistoryRow | null>((b, h) => (!b || h.place < b.place ? h : b), null);
  const facts = q(root, '[data-facts]');
  const fact = (label: string, value: string, small?: string) => {
    const d = el('div'); const b = el('b', undefined, value);
    if (small) b.append(' ', el('small', undefined, small));
    d.append(el('span', 'label', label), b); facts.append(d);
  };
  if (rated && over.rank != null) fact('Rank', `#${fmt.format(over.rank)}`, over.percentile != null ? `top ${Math.max(1, Math.ceil(over.percentile))}%` : undefined);
  else fact('Rank', 'Unranked', placement ? 'after placement' : undefined);
  fact('Peak rating', over ? fmt.format(over.peak) : '–');
  fact('Streak', `${p.streak?.current ?? 0} day${p.streak?.current === 1 ? '' : 's'}`, `best ${p.streak?.best ?? 0}`);
  fact('Best daily place', bestDaily ? ord(bestDaily.place) : '–', bestDaily ? `of ${fmt.format(bestDaily.field)}` : undefined);

  // medals
  for (const m of ['wealth', 'speed', 'brevity'] as const) q(root, `[data-m-${m}]`).textContent = fmt.format(p.medals?.[m] ?? 0);

  // disciplines
  const disc = q(root, '[data-disc]');
  for (const k of DISCS) {
    const r = ratings[k] ?? null;
    const row = el('div', 'row');
    const val = el('span', 'v mono');
    const bar = el('div', 'bar'); const fill = el('i'); bar.append(fill);
    if (r) {
      const pct = Math.max(2, Math.min(100, Math.round(((r.rating - 800) / (2400 - 800)) * 100)));
      fill.style.width = `${pct}%`;
      const col = r.provisional ? 'var(--dim)' : `var(--tier-${r.tier.key})`;
      fill.style.background = col; val.style.color = col;
      val.textContent = r.provisional ? `${fmt.format(r.rating)}? placement` : `${fmt.format(r.rating)} ${r.tier.name}`;
    } else { val.textContent = 'Not rated'; val.classList.add('dim'); }
    row.append(el('span', undefined, DISC_LABEL[k]), bar, val);
    disc.append(row);
  }

  // ladder
  const ladder = q(root, '[data-ladder]');
  const rangeOf = (i: number) => (i === 0 ? `below ${TIERS[1]!.floor}` : i === TIERS.length - 1 ? `${TIERS[i]!.floor}+` : `${TIERS[i]!.floor} to ${TIERS[i + 1]!.floor - 1}`);
  [...TIERS].reverse().forEach((t) => {
    const i = TIERS.indexOf(t);
    const here = rated && over.tier.key === t.key;
    const row = el('div', here ? 'me' : undefined);
    row.style.color = `var(--tier-${t.key})`;
    row.append(document.createTextNode(here ? `${t.name} · you are here` : t.name), el('span', undefined, rangeOf(i)));
    ladder.append(row);
  });
  const lcap = q(root, '[data-ladder-cap]');
  if (rated) {
    const next = over.tier.next;
    const nt = next != null ? tierAt(next) : null;
    lcap.textContent = nt && next != null ? `${fmt.format(next - over.rating)} points to ${nt.name}.` : 'The top tier. Nothing left to climb.';
  } else lcap.textContent = placement ? 'The title is shown once placement is over.' : 'A new player starts at 1,200, the bottom of Shoot.';

  // history chart + results with the discipline switch
  const seg = q(root, '[data-seg]');
  let current: Disc = 'overall';
  const buttons = [...seg.querySelectorAll<HTMLButtonElement>('button')];
  for (const b of buttons) {
    const k = b.dataset.d as Disc;
    if (!ratings[k]) b.disabled = true;
    b.addEventListener('click', () => { current = k; paintSwitch(); });
  }
  const numbers = new Map((p.recent ?? []).map((r) => [r.challengeId, r.number]));
  const owner = !!p.viewer?.isSelf;
  noteRanks(p.pinned);
  const pins = new Set((p.pinned ?? []).map((x) => (typeof x === 'string' ? x : x.entryId)));
  const canPin = owner && p.pinned !== undefined;
  function paintSwitch() {
    buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.d === current)));
    drawChart(root, ratings[current] ?? null, current, numbers);
    drawResults(root, p, ratings[current] ?? null, current === 'overall', numbers, canPin ? pins : null);
  }
  paintSwitch();

  // garden
  drawGarden(root, p, allHist);

  // signature farms
  const farms = q(root, '[data-farms]');
  const best = (p.recent ?? []).filter((r) => r.mosaic && r.mosaic.length === 64).sort((a, b) => b.netWorth - a.netWorth).slice(0, 3);
  q(root, '[data-farms-empty]').hidden = best.length > 0;
  for (const r of best) {
    const fig = el('figure');
    const pic = mosaicEl(r.mosaic, '7rem');
    if (pic) fig.append(pic);
    const a = el('a', undefined, `${challengeName(r.challengeId, r.kind, r.number)} · ${fmt.format(r.netWorth)}`);
    a.href = `/r/${encodeURIComponent(r.entryId)}`;
    const cap = el('figcaption'); cap.append(a);
    fig.append(cap); farms.append(fig);
  }

  setupFollow(root, p);
  void drawPins(root, pins, canPin);
}

function drawChart(root: HTMLElement, r: Rating | null, disc: Disc, numbers: Map<string, number | null>) {
  const box = q(root, '[data-chart]'), tip = q(root, '[data-tip]');
  box.querySelector('svg')?.remove();
  tip.hidden = true;
  const cap = q(root, '[data-chart-cap]');
  const hist = r?.history ?? [];
  if (hist.length === 0) {
    const msg = el('p', 'pf-state', r ? 'No rated results yet.' : `No rated ${DISC_LABEL[disc].toLowerCase()} runs yet. A run that reaches par is rated once its challenge closes.`);
    msg.dataset.empty = '1';
    box.querySelector('[data-empty]')?.remove();
    box.insertBefore(msg, tip);
    cap.hidden = true;
    return;
  }
  box.querySelector('[data-empty]')?.remove();
  cap.hidden = false;
  const NS = 'http://www.w3.org/2000/svg';
  const S = (name: string, attrs: Record<string, string | number>, text?: string) => {
    const e = document.createElementNS(NS, name);
    for (const k in attrs) e.setAttribute(k, String(attrs[k]));
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const W = 720, H = 300, L = 46, R = 12, T = 12, B = 26;
  const vals = hist.flatMap((h) => [h.rating, h.before]);
  const lo = Math.max(0, Math.floor((Math.min(...vals) - 60) / 100) * 100), hi = Math.max(lo + 200, Math.ceil((Math.max(...vals) + 60) / 100) * 100);
  const x = (i: number) => (hist.length === 1 ? (L + W - R) / 2 : L + ((W - L - R) * i) / (hist.length - 1));
  const y = (v: number) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const svg = S('svg', { viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': `${DISC_LABEL[disc]} rating over ${hist.length} rated challenge${hist.length === 1 ? '' : 's'}, now ${fmt.format(hist[hist.length - 1]!.rating)}` });
  TIERS.forEach((t, i) => {
    const a = Math.max(t.floor, lo), b = Math.min(TIERS[i + 1]?.floor ?? Infinity, hi);
    if (b <= a) return;
    svg.append(S('rect', { x: L, y: y(b), width: W - L - R, height: y(a) - y(b), fill: `var(--tier-${t.key})`, opacity: 0.12 }));
    if (t.floor > lo) svg.append(S('text', { x: L - 6, y: y(a) + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--dim)', 'font-family': 'var(--mono)' }, String(t.floor)));
    if (y(a) - y(b) > 16) svg.append(S('text', { x: W - R - 6, y: y(b) + 14, 'text-anchor': 'end', 'font-size': 11, fill: `var(--tier-${t.key})`, 'font-family': 'var(--body)', 'font-weight': 600 }, t.name));
  });
  svg.append(S('path', { d: hist.map((h, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(h.rating).toFixed(1)}`).join(' '), fill: 'none', stroke: 'var(--ink)', 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
  hist.forEach((h, i) => {
    const tier = tierAt(h.rating);
    const label = `${challengeName(h.challengeId, h.kind, numbers.get(h.challengeId))}, ${shortDate(dayOfChallenge(h.challengeId, h.closesAt))}: ${fmt.format(h.rating)} ${tier.name} (${signed(h.delta)}), ${ord(h.place)} of ${fmt.format(h.field)}. Open replay.`;
    const a = S('a', { href: `/r/${encodeURIComponent(h.entryId)}`, 'aria-label': label });
    a.append(S('circle', { cx: x(i), cy: y(h.rating), r: h.kind === 'season' ? 5.5 : 3.5, fill: `var(--tier-${tier.key})`, stroke: 'var(--paper)', 'stroke-width': 1.5 }));
    // generous invisible hit area for touch
    a.append(S('circle', { cx: x(i), cy: y(h.rating), r: 10, fill: 'transparent' }));
    const show = () => {
      tip.textContent = `${challengeName(h.challengeId, h.kind, numbers.get(h.challengeId))} · ${fmt.format(h.rating)} ${tier.name} (${signed(h.delta)}) · ${ord(h.place)} of ${fmt.format(h.field)}`;
      tip.style.left = `${Math.min(88, Math.max(12, (x(i) / W) * 100))}%`; tip.style.top = `${(y(h.rating) / H) * 100}%`; tip.hidden = false;
    };
    a.addEventListener('mouseenter', show); a.addEventListener('focus', show);
    a.addEventListener('mouseleave', () => { tip.hidden = true; }); a.addEventListener('blur', () => { tip.hidden = true; });
    svg.append(a);
  });
  svg.append(S('text', { x: L, y: H - 6, 'font-size': 11, fill: 'var(--dim)', 'font-family': 'var(--body)' }, shortDate(dayOfChallenge(hist[0]!.challengeId, hist[0]!.closesAt))));
  svg.append(S('text', { x: W - R, y: H - 6, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--dim)', 'font-family': 'var(--body)' }, shortDate(dayOfChallenge(hist[hist.length - 1]!.challengeId, hist[hist.length - 1]!.closesAt))));
  box.insertBefore(svg, tip);
}

interface Line { time: number; date: string; name: string; place: string; played: string; change: string; changeCls: string; rating: string; entryId: string; muted: boolean }
function drawResults(root: HTMLElement, p: Profile, r: Rating | null, overall: boolean, numbers: Map<string, number | null>, pins: Set<string> | null) {
  const body = q(root, '[data-results]');
  body.replaceChildren();
  const lines: Line[] = (r?.history ?? []).map((h) => {
    const day = dayOfChallenge(h.challengeId, h.closesAt);
    return { time: ms(h.closesAt), date: shortDate(day), name: challengeName(h.challengeId, h.kind, numbers.get(h.challengeId)), place: `${fmt.format(h.place)} / ${fmt.format(h.field)}`,
      played: fmt.format(h.performance), change: signed(h.delta), changeCls: h.delta > 0 ? 'up' : h.delta < 0 ? 'down' : '', rating: fmt.format(h.rating), entryId: h.entryId, muted: false };
  });
  if (overall) {
    const rated = new Set((r?.history ?? []).map((h) => h.entryId));
    for (const e of p.recent ?? []) {
      if (e.kind === 'duel' || rated.has(e.entryId) || (r?.history ?? []).some((h) => h.challengeId === e.challengeId)) continue;
      const t = ms(e.createdAt);
      lines.push({ time: t, date: shortDate(dateKey(t)), name: challengeName(e.challengeId, e.kind, e.number), place: e.parTick == null ? 'below par' : 'awaiting rating', played: 'not rated', change: '0', changeCls: '', rating: r ? fmt.format(r.rating) : '–', entryId: e.entryId, muted: true });
    }
  }
  lines.sort((a, b) => b.time - a.time);
  if (lines.length === 0) {
    const tr = el('tr'); const td = el('td', 'dim', 'Nothing rated yet.'); td.colSpan = 7; tr.append(td); body.append(tr); return;
  }
  for (const l of lines.slice(0, 25)) {
    const tr = el('tr');
    const cell = (t: string, cls?: string) => { const td = el('td', cls, t); tr.append(td); return td; };
    cell(l.date); cell(l.name); cell(l.place, `r${l.muted ? ' dim' : ''}`); cell(l.played, `r${l.muted ? ' dim' : ''}`); cell(l.change, `r ${l.muted ? 'dim' : l.changeCls}`); cell(l.rating, 'r');
    const td = el('td'); const a = el('a', undefined, 'Replay'); a.href = `/r/${encodeURIComponent(l.entryId)}`; td.append(a);
    if (pins && !l.muted) {
      const b = el('button', 'pinbtn', pins.has(l.entryId) ? 'Unpin' : 'Pin'); b.type = 'button';
      b.addEventListener('click', () => void togglePin(root, p, pins, l.entryId, b));
      td.append(b);
    }
    tr.append(td); body.append(tr);
  }
}

function drawGarden(root: HTMLElement, p: Profile, hist: HistoryRow[]) {
  const garden = q(root, '[data-garden]');
  const level = new Map<string, number>();
  const bump = (k: string, v: number) => level.set(k, Math.max(level.get(k) ?? 0, v));
  for (const h of hist) bump(dayOfChallenge(h.challengeId, h.closesAt), h.place <= 3 ? 4 : 3);
  for (const d of p.days ?? []) bump(d, 1);
  for (const e of p.recent ?? []) if (e.kind !== 'duel') bump(dayOfChallenge(e.challengeId, e.createdAt), 1);
  const WEEKS = 20;
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const wd = (today.getUTCDay() + 6) % 7; // Monday = 0
  const start = today.getTime() - ((WEEKS - 1) * 7 + wd) * 86_400_000;
  let played = 0;
  for (let i = 0; i < WEEKS * 7; i++) {
    const t = start + i * 86_400_000;
    const cell = el('i');
    if (t > today.getTime()) cell.dataset.l = 'x';
    else {
      const k = dateKey(t), l = level.get(k) ?? 0;
      if (l) { cell.dataset.l = String(l); played++; }
      cell.title = `${shortDate(k)}: ${l === 4 ? 'podium' : l === 3 ? 'rated' : l === 1 ? 'played, not rated' : 'no run'}`;
    }
    garden.append(cell);
  }
  garden.setAttribute('aria-label', `Days played over the last ${WEEKS} weeks: ${played} with a result`);
  q(root, '[data-garden-cap]').textContent = p.days ? '' : (p.recent?.length ?? 0) >= 10 ? 'Shows rated days and the most recent ten entries.' : '';
}

function setupFollow(root: HTMLElement, p: Profile) {
  const row = q(root, '[data-follow-row]'), btn = q<HTMLButtonElement>(root, '[data-follow]'), msg = q(root, '[data-follow-msg]');
  if (p.viewer?.isSelf) return;
  row.hidden = false;
  if (!p.viewer) {
    btn.replaceWith(Object.assign(el('a', 'btn', 'Sign in to follow'), { href: `/api/auth/github?return=${encodeURIComponent(`/u/?login=${p.login}`)}` }));
    return;
  }
  let following = p.viewer.following;
  const paint = () => { btn.textContent = following ? 'Following' : 'Follow'; btn.setAttribute('aria-pressed', String(following)); };
  paint();
  btn.addEventListener('click', async () => {
    btn.disabled = true; msg.textContent = '';
    try {
      const res = await fetch(`/api/players/${encodeURIComponent(p.login)}/${following ? 'unfollow' : 'follow'}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-tendril-client': '1' }, body: '{}',
      });
      if (!res.ok) throw new Error(String(res.status));
    noteRanks(((await res.json()) as { pinned?: PinRef[] }).pinned);
      following = !following; paint();
    } catch { msg.textContent = "Couldn't update that. Try again in a moment."; }
    finally { btn.disabled = false; }
  });
}

// Pinned programs: reads `pinned` from the player API; the owner PUTs the list to /players/me/pinned.
async function drawPins(root: HTMLElement, pins: Set<string>, canPin: boolean) {
  const sec = q(root, '[data-sec="pinned"]'), box = q(root, '[data-pins]'), cap = q(root, '[data-pin-cap]');
  box.replaceChildren();
  const ids = [...pins].slice(0, 3);
  sec.hidden = ids.length === 0 && !canPin;
  cap.textContent = canPin ? `${ids.length} of 3 pinned. Use Pin on a result to choose.` : '';
  if (ids.length === 0) { if (canPin) box.append(el('p', 'cap', 'Nothing pinned yet. Pin up to three published programs from Rated results.')); return; }
  const views = await Promise.all(ids.map((id) => api<SourceView>(`/entries/${encodeURIComponent(id)}/source`)));
  views.forEach((v, i) => {
    const wrap = el('div', 'pf-pin');
    if (!v) { wrap.append(el('p', 'cap', 'This program is not published, so it cannot be shown.')); box.append(wrap); return; }
    const bits = [challengeName(v.challenge.id, v.challenge.kind, v.challenge.number)];
    if (v.tokens != null) bits.push(`${fmt.format(v.tokens)} tokens`);
    bits.push(`net worth ${fmt.format(v.netWorth)}`);
    const rk = pinRank.get(v.entryId);
    if (rk) bits.push(`${ord(rk.rank)} of ${fmt.format(rk.players)}`);
    const head = el('div', 'pf-head');
    const meta = el('span', 'cap mono', `${bits.join(' · ')} · verified`);
    const a = el('a', undefined, 'Replay'); a.href = `/r/${encodeURIComponent(v.entryId)}`;
    head.append(meta, a);
    const pre = el('pre'); const code = el('code'); code.textContent = v.source; pre.append(code);
    pre.tabIndex = 0; pre.setAttribute('aria-label', `Pinned program ${i + 1}`);
    wrap.append(head, pre); box.append(wrap);
  });
}

async function togglePin(root: HTMLElement, p: Profile, pins: Set<string>, id: string, btn: HTMLButtonElement) {
  const next = new Set(pins);
  if (next.has(id)) next.delete(id);
  else { if (next.size >= 3) { q(root, '[data-pin-cap]').textContent = 'Three is the limit. Unpin one first.'; return; } next.add(id); }
  btn.disabled = true;
  try {
    const res = await fetch('/api/players/me/pinned', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-tendril-client': '1' }, body: JSON.stringify({ entryIds: [...next] }) });
    if (!res.ok) throw new Error(String(res.status));
    noteRanks(((await res.json()) as { pinned?: PinRef[] }).pinned);
    pins.clear(); next.forEach((x) => pins.add(x));
    btn.textContent = pins.has(id) ? 'Unpin' : 'Pin';
    sectionRefresh(root, p, pins);
  } catch { q(root, '[data-pin-cap]').textContent = "Couldn't save the pin. Try again in a moment."; }
  finally { btn.disabled = false; }
}
function sectionRefresh(root: HTMLElement, p: Profile, pins: Set<string>) { void drawPins(root, pins, true); }
