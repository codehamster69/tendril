// Pure formatting for the farm market card, stall sign and popups. No DOM, no three, no CSS: unit tested in farm-market.test.ts.
// Rules text and numbers come from the sim's describeMarket; this file only maps them to what the card draws.
import { describeMarket, MARKET_EPOCH } from '@tendril/sim/src/index.ts';
import type { MarketRowView } from '@tendril/sim/src/index.ts';

/** As in api-client ChallengeInfo.market: centicoins and permille of base, index = item id (0 unused). */
export interface MarketData { prices: number[]; multipliers: number[]; shares: number[] | null }

export interface CardRow {
  item: number; name: string; /** coins, two decimals */ price: string; /** "x1.25" */ mult: string; /** "+25%", "-10%" or "base" */ change: string;
  /** 0..100 position on the 50..200 percent log gauge */ gauge: number; trend: 'up' | 'down' | 'flat'; arrow: string; share: string | null;
}
export interface CardModel {
  kind: 'base' | 'soon' | 'open'; title: string; note: string; rows: CardRow[];
  /** Best item (highest multiplier) on an open market, else null. */ best: { item: number; name: string; mult: string; price: string } | null;
}

const NEUTRAL = 1000;
export const LO = 0.5;
export const HI = 2;
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Multiplier 0.5..2 for a permille value; non-finite or missing counts as base (1). */
export function permilleToMult(p: number | undefined): number {
  return clamp(Number.isFinite(p) ? (p as number) / NEUTRAL : 1, LO, HI);
}
/** Position 0..100 on a log scale from 50 percent to 200 percent: 100 percent sits at 50. */
export function gaugePos(mult: number): number {
  return ((Math.log(clamp(mult, LO, HI)) - Math.log(LO)) / (Math.log(HI) - Math.log(LO))) * 100;
}
export function multLabel(mult: number): string { return `×${mult.toFixed(2)}`; }
export const arrowFor = (trend: 'up' | 'down' | 'flat'): string => (trend === 'up' ? '▲' : trend === 'down' ? '▼' : '–');

/** Per item id multipliers (index = item id, 0 unused = 1), or null at base prices. */
export function multiplierTable(m: MarketData | null): number[] | null {
  if (!m) return null;
  return m.multipliers.map((p, i) => (i === 0 ? 1 : permilleToMult(p)));
}

/** Highest-multiplier item among ids 1..n-1 (ties: lowest id), or 0 when none. */
export function bestItem(mults: readonly number[]): number {
  let best = 0;
  for (let c = 1; c < mults.length; c++) if (best === 0 || mults[c]! > mults[best]!) best = c;
  return best;
}

/** Whole seconds to the next UTC midnight, in 1..86400. */
export function secondsToUtcMidnight(nowMs: number): number {
  const day = 86_400_000;
  return Math.max(1, Math.ceil((day - (((nowMs % day) + day) % day)) / 1000));
}
export function formatCountdown(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(r)}`;
}

/** Text over a harvested tile: "+12.50 coins x1.25". */
export function popupText(coins: number, mult: number): string {
  const c = Number.isInteger(coins) ? String(coins) : coins.toFixed(2);
  return `+${c}¢ ${multLabel(mult)}`;
}

/** Everything the card shows. `opensInDays` > 0 wins over data (market not open yet). */
export function buildCard(m: MarketData | null, opensInDays = 0): CardModel {
  if (opensInDays > 0) {
    // describeMarket owns the wording ("Market opens tomorrow" / "in N days"); date is only used to pick the branch.
    const v = describeMarket(daysBefore(MARKET_EPOCH, opensInDays), null);
    return { kind: 'soon', title: 'Shared market', note: v?.text ?? `Market opens in ${opensInDays} days`, rows: [], best: null };
  }
  const v = m ? describeMarket(MARKET_EPOCH, m) : null;
  if (!m || !v || v.kind !== 'open') return { kind: 'base', title: 'Base prices', note: 'No shared market today: every crop sells at its base price.', rows: [], best: null };
  const rows = v.rows.map((r: MarketRowView): CardRow => {
    const mult = permilleToMult(m.multipliers[r.item]);
    return { item: r.item, name: r.name, price: r.price, mult: multLabel(mult), change: r.change, gauge: gaugePos(mult), trend: r.trend, arrow: arrowFor(r.trend), share: r.share };
  });
  const b = rows.length ? rows.reduce((a, r) => (permilleToMult(m.multipliers[r.item]) > permilleToMult(m.multipliers[a.item]) ? r : a)) : null;
  return { kind: 'open', title: 'Shared market', note: v.text, rows, best: b ? { item: b.item, name: b.name, mult: b.mult, price: b.price } : null };
}

/** ISO date `days` before `date` (UTC), for asking describeMarket about a pre-epoch day. */
function daysBefore(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) - days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}
