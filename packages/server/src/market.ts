// The shared daily market on the server (SIM_SPEC.md section 4.3): reads the day before, stores one immutable table per day.
import { baseMarket, isMarketTable, MARKET, MARKET_EPOCH, nextMarket } from '@tendril/sim/src/index.ts';
import type { MarketRow, MarketTable } from '@tendril/sim/src/index.ts';
import type { Queryable } from './db.ts';

const DAY_MS = 86_400_000;
const dailyId = (date: string): string => `d-${date}`;
const shiftDate = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** A stored `challenges.market` value, or null when absent or not a valid table (a bad row is treated as missing, never trusted). */
export function parseMarket(value: unknown): MarketTable | null {
  if (typeof value !== 'string') return null;
  try { const parsed: unknown = JSON.parse(value); return isMarketTable(parsed) ? parsed : null; } catch { return null; }
}

/** `entries.sold` is stored as 7 integers (items 1..7); the sim works with length 8 and index = item. */
export const soldColumn = (sold: readonly number[]): string => JSON.stringify(sold.slice(1, 8));
function parseSold(value: unknown): number[] | null {
  if (typeof value !== 'string') return null;
  try {
    const a: unknown = JSON.parse(value);
    return Array.isArray(a) && a.length === 7 && a.every((x) => Number.isSafeInteger(x) && (x as number) >= 0) ? [0, ...(a as number[])] : null;
  } catch { return null; }
}

/**
 * Computes the table of the daily `date` (a market day) from stored data: the entries of the day before (one per player,
 * the highest net worth, ties to the earlier entry) and the stored rows of up to 13 days before. The epoch day is the base table.
 */
export async function computeDailyMarket(q: Queryable, date: string): Promise<MarketTable> {
  if (date <= MARKET_EPOCH) return baseMarket();
  const ids = Array.from({ length: MARKET.WINDOW - 1 }, (_, i) => dailyId(shiftDate(date, -(i + 1))));
  const found = await q.query<{ id: string; market: string | null }>(`SELECT id, market FROM challenges WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  const byId = new Map(found.map((r) => [r.id, parseMarket(r.market)]));
  const earlier: (MarketRow | null)[] = ids.map((id) => { const t = byId.get(id); return t ? { id, m: t.m, t: t.t, sh: t.sh } : null; });
  // Players of the day before. Only a row that exists can have entries; a missing earlier row counts as no data.
  const rows = earlier[0] ? await q.query<{ user_id: string; sold: string | null }>(
    'SELECT user_id, sold FROM entries WHERE challenge_id = ? AND sold IS NOT NULL ORDER BY net_worth DESC, created_at ASC, id ASC', [ids[0]!]) : [];
  const best = new Map<string, number[]>();
  for (const r of rows) if (!best.has(r.user_id)) { const s = parseSold(r.sold); if (s) best.set(r.user_id, s); }
  return nextMarket([...best.values()], earlier);
}

/** Public shape for `GET /challenges/:id`. */
export function marketView(t: MarketTable | null): { prices: number[]; multipliers: number[]; shares: number[] | null } | null {
  return t ? { prices: t.p, multipliers: t.m, shares: t.sh } : null;
}
