// Browser helpers shared by the home page, the boards and the player page.
// The site is static: everything here fetches from /api at view time and fails soft.

import { challengeSetup, describeMarket, describeModifiers, SETUP_LEGACY } from '@tendril/sim';

export interface Challenge {
  id: string; kind: 'daily' | 'season' | 'duel'; number: number; seed: number; ticks: number; par: number | null;
  opensAt: string | number; closesAt: string | number; rulesVersion: number; setupVersion?: number; players: number; best: number | null;
  market?: { prices: number[]; multipliers: number[]; shares: number[] | null } | null;
}
export interface Row {
  rank: number; entryId: string; userId?: string; login: string; displayName: string; avatarUrl?: string;
  value: number; mosaic?: string | null; authorKind?: string; model?: string | null; createdAt?: string | number;
  percentile?: number;
}
export interface Board {
  medal: Medal; entries: Row[]; total: number; me: Row | null;
  histogram: { min: number; max: number; width: number; counts: number[] };
}
export type Medal = 'wealth' | 'speed' | 'brevity';

export const fmt = new Intl.NumberFormat('en-US');

/** The day's modifiers as short labels, from the same function the game and the server use. Empty for a plain farm. */
export function modifiersOf(c: Pick<Challenge, 'kind' | 'seed' | 'setupVersion'>): string[] {
  return describeModifiers(challengeSetup(c.kind, c.seed, c.setupVersion ?? SETUP_LEGACY).modifiers, c.kind);
}

/** The market line for a daily: the countdown before 8 Dec, otherwise a short list of today's prices. Null for anything else. */
export function marketOf(c: Pick<Challenge, 'id' | 'kind' | 'market'>): { text: string; rows: { name: string; price: string; change: string; trend: string }[] } | null {
  if (c.kind !== 'daily' || !/^d-\d{4}-\d{2}-\d{2}$/.test(c.id)) return null;
  const v = describeMarket(c.id.slice(2), c.market);
  if (!v) return null;
  return v.kind === 'soon' ? (v.days > 0 ? { text: v.text, rows: [] } : null) : { text: v.text, rows: v.rows };
}

export async function api<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`/api${path}`, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** UTC date `offset` days from today, as YYYY-MM-DD. */
export function utcDay(offset = 0): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

export function msUntil(t: string | number): number {
  return (typeof t === 'number' ? t : Date.parse(t)) - Date.now();
}

export function timeLeft(ms: number): string {
  if (!(ms > 0)) return 'closed';
  const m = Math.floor(ms / 60_000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return d > 0 ? `${d}d ${h}h left` : h > 0 ? `${h}h ${m % 60}m left` : `${m}m left`;
}

/** What a medal's value means: coins for wealth, a tick for speed, a token count for brevity. */
export function medalValue(medal: Medal, v: number): string {
  return medal === 'speed' ? `tick ${fmt.format(v)}` : medal === 'brevity' ? `${fmt.format(v)} tokens` : fmt.format(v);
}

export const MEDALS: Record<Medal, { label: string; blurb: string }> = {
  wealth: { label: 'Wealth', blurb: 'Highest net worth when the clock stops.' },
  speed: { label: 'Speed', blurb: 'Earliest tick that reached par.' },
  brevity: { label: 'Brevity', blurb: 'Fewest Sprout tokens in the program.' },
};

const TILE: Record<string, string> = {
  '0': 'var(--grass)', t: 'var(--soil)', B: 'var(--ink)', h: 'var(--wheat)', c: 'var(--berry)',
  '1': 'var(--carrot)', '2': 'var(--wheat)', '3': 'var(--leaf)', '4': 'var(--pumpkin)', '5': 'var(--berry)', '6': 'var(--apple)',
};

/** The 8x8 farm picture for a 64-character mosaic, or null when there isn't one. */
export function mosaicEl(mosaic: string | null | undefined, size = '4.5rem'): HTMLElement | null {
  if (!mosaic || mosaic.length !== 64) return null;
  const el = document.createElement('div');
  el.className = 'mosaic';
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', 'Picture of the finished farm');
  el.style.setProperty('--size', size);
  for (const ch of mosaic) {
    const i = document.createElement('i');
    i.style.background = TILE[ch] ?? 'var(--grass)';
    el.append(i);
  }
  return el;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Link to a player's page. */
export function playerLink(login: string, label: string): HTMLAnchorElement {
  const a = el('a', 'player', label);
  a.href = `/u/?login=${encodeURIComponent(login)}`;
  return a;
}

/** Histogram bars; the viewer's bar (if any) is marked. */
export function histogramEl(b: Board, medal: Medal): HTMLElement {
  const { counts, min, width } = b.histogram;
  const peak = Math.max(1, ...counts);
  const mine = b.me ? Math.min(counts.length - 1, Math.max(0, width > 0 ? Math.floor((b.me.value - min) / width) : 0)) : -1;
  const wrap = el('figure', 'histo');
  const bars = el('div', 'bars');
  counts.forEach((n, i) => {
    const bar = el('div', i === mine ? 'bar me' : 'bar');
    bar.style.height = `${Math.max(n ? 4 : 0, Math.round((100 * n) / peak))}%`;
    const lo = min + i * width;
    bar.title = `${medalValue(medal, Math.round(lo))} to ${medalValue(medal, Math.round(lo + width))}: ${n} player${n === 1 ? '' : 's'}${i === mine ? ' (you)' : ''}`;
    bars.append(bar);
  });
  const cap = el('figcaption', undefined, mine >= 0 ? 'How everyone finished. Your bar is highlighted.' : 'How everyone finished. Sign in and play to see your bar.');
  wrap.append(bars, cap);
  return wrap;
}

export const arenaCss = `
.mosaic { display: grid; grid-template-columns: repeat(8, 1fr); width: var(--size, 4.5rem); aspect-ratio: 1; gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: 4px; overflow: hidden; flex: none; }
.mosaic i { display: block; }
`;
