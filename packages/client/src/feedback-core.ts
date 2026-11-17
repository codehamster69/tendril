/** Pure planning for the floating numbers: which events become which text, and how repeats merge. No DOM, no three.js. */

/** [kind, tick, bot, a, b] as the worker sends it (see EVENT in sim-protocol). */
export type FeedbackEvent = [kind: number, tick: number, bot: number, a: number, b: number];
const HARVEST = 1, SALE = 2, ORDER = 3;

/** A group of this many or fewer keeps one number per event; more merge per item (4x), and more than 16 per kind (16x). */
export const MERGE_ITEM_AT = 4;
export const MERGE_KIND_AT = 16;
/** At most this many numbers are on screen; the oldest is recycled first. */
export const MAX_FLOATS = 30;

export interface FloatSpec {
  kind: 'item' | 'coin';
  /** Item id for `item` floats, 0 when unknown. */
  item: number;
  /** Bot whose position anchors the number. */
  bot: number;
  text: string;
}

export interface FloatContext {
  /** Units of each item a bot gained in the last step (from the bot's carried items). */
  gained(bot: number): { item: number; n: number }[];
  itemName(item: number): string;
  /** Coins for selling `units` of `item`, at base price. */
  saleValue(item: number, units: number): number;
  /** Reward of an open order by id, or null. */
  orderReward(id: number): number | null;
}

interface Raw { kind: 'item' | 'coin'; item: number; bot: number; n: number }

const label = (r: Raw, c: FloatContext): string => (r.kind === 'coin' ? `+${r.n.toLocaleString('en-US')} coins` : r.item > 0 && r.n > 0 ? `+${r.n} ${c.itemName(r.item)}` : '+harvest');

/** Turn one batch of events into the numbers to show. Order is stable and every number is at least 1. */
export function planFloats(events: readonly FeedbackEvent[], c: FloatContext): FloatSpec[] {
  const raw: Raw[] = [];
  const harvested = new Set<number>();
  for (const [kind, , bot, a, b] of events) {
    if (kind === HARVEST) {
      if (harvested.has(bot)) continue; // the gain is read once per bot per step
      harvested.add(bot);
      const gains = c.gained(bot).filter((g) => g.n > 0);
      if (gains.length) for (const g of gains) raw.push({ kind: 'item', item: g.item, bot, n: g.n });
      else raw.push({ kind: 'item', item: 0, bot, n: 0 });
    } else if (kind === SALE) {
      const n = c.saleValue(a, b);
      if (n > 0) raw.push({ kind: 'coin', item: 0, bot, n });
    } else if (kind === ORDER) {
      const n = c.orderReward(a);
      if (n && n > 0) raw.push({ kind: 'coin', item: 0, bot, n });
    }
  }
  if (!raw.length) return [];
  const merged: Raw[] = [];
  const byKey = new Map<string, Raw>();
  const keyOf = (r: Raw): string => (raw.length > MERGE_KIND_AT ? r.kind : `${r.kind}:${r.item}`);
  for (const r of raw) {
    if (raw.length <= MERGE_ITEM_AT) { merged.push({ ...r }); continue; }
    const k = keyOf(r);
    const have = byKey.get(k);
    if (have) { have.n += r.n; if (raw.length > MERGE_KIND_AT && r.item !== have.item) have.item = 0; } else { const copy = { ...r }; byKey.set(k, copy); merged.push(copy); }
  }
  return merged.map((r) => ({ kind: r.kind, item: r.item, bot: r.bot, text: label(r, c) }));
}

/** Per-bot item gains between two snapshots' `items` arrays (index = item id). */
export function itemGains(before: readonly number[] | undefined, after: readonly number[] | undefined): { item: number; n: number }[] {
  const out: { item: number; n: number }[] = [];
  if (!after) return out;
  after.forEach((n, item) => { const d = n - (before?.[item] ?? 0); if (item > 0 && d > 0) out.push({ item, n: d }); });
  return out;
}

export type BubbleKind = 'error' | 'blocked' | 'waiting';
export interface BotState { status: string; line: number | null; op: number | null }

const OP_WAIT = 7;
/** What bubble a bot should wear, or null. Errors win over a stop at a breakpoint, which wins over waiting. */
export function bubbleFor(s: BotState): BubbleKind | null {
  if (s.status === 'error') return 'error';
  if (s.status === 'paused') return 'blocked';
  if (s.op === OP_WAIT) return 'waiting';
  return null;
}

export const BUBBLE_ICON: Record<BubbleKind, string> = { error: '!', blocked: '⏸', waiting: '…' };
const BUBBLE_RANK: Record<BubbleKind, number> = { error: 0, blocked: 1, waiting: 2 };
export const MAX_BUBBLES = 16;

/** The bots to draw bubbles for, most urgent first, never more than `max`. */
export function pickBubbles(states: readonly { bot: number; kind: BubbleKind }[], max = MAX_BUBBLES): { bot: number; kind: BubbleKind }[] {
  return [...states].sort((a, b) => BUBBLE_RANK[a.kind] - BUBBLE_RANK[b.kind] || a.bot - b.bot).slice(0, max);
}

/** Float opacity and rise (px) at age `t` of 0..1. */
export function floatCurve(t: number, reduced: boolean): { rise: number; opacity: number } {
  const u = Math.min(1, Math.max(0, t));
  return { rise: reduced ? 0 : 46 * (1 - (1 - u) * (1 - u)), opacity: u < 0.15 ? u / 0.15 : u > 0.6 ? Math.max(0, 1 - (u - 0.6) / 0.4) : 1 };
}
