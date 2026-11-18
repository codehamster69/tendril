// Pure words and numbers for a brief's goal (K6): how a score reads, the goal line, quota rows, the provisional/final lines. No DOM.
import { ITEMS } from '@tendril/sim/src/index.ts';
import type { Goal, GoalKind } from '@tendril/sim/src/index.ts';

const fmt = (n: number): string => n.toLocaleString('en-US');
const name = (i: number): string => ITEMS[i]?.name ?? '?';

/** Short name of a goal, as the start card and the result screen call it. */
export const GOAL_NAMES: Record<GoalKind, string> = { wealth: 'Wealth', festival: 'Harvest festival', specialist: 'Specialist prices', orders: 'Orders only', inherited: 'Inherited farm' };
/** What the first medal is called for each goal (it is the rated "Wealth" discipline underneath). */
export const SCORE_NAMES: Record<GoalKind, string> = { wealth: 'Wealth', festival: 'Festival', specialist: 'Wealth', orders: 'Orders', inherited: 'Growth' };

/** A score as the number and the unit that follow it. Festival scores are permille of the quotas (0..1000), shown as a percent. */
export function scoreParts(kind: GoalKind, n: number): { num: string; unit: string } {
  const v = Math.trunc(n);
  switch (kind) {
    case 'festival': return { num: `${Math.floor(v / 10)}.${Math.abs(v) % 10}`, unit: '% of the quotas filled' };
    case 'orders': return { num: fmt(v), unit: 'coins from orders' };
    case 'inherited': return { num: fmt(v), unit: 'coins gained over the start' };
    default: return { num: fmt(v), unit: 'coins net worth' };
  }
}

/** One line: "1,240 coins from orders", "62.5% of the quotas filled". */
export const scoreText = (kind: GoalKind, n: number): string => { const p = scoreParts(kind, n); return `${p.num}${p.unit.startsWith('%') ? '' : ' '}${p.unit}`; };

/** The goal as a sentence for the start card. */
export function goalLine(goal: Goal): string {
  const budget = fmt(goal.budget);
  switch (goal.kind) {
    case 'festival': return `Fill the village quotas by depositing the crops in your barn or silos. Selling does not lower the count. ${budget} ticks.`;
    case 'orders': return `Earn the most coins from delivered orders. Only deliveries count. ${budget} ticks.`;
    case 'inherited': return `Leave the inherited farm richer than you found it: net worth gained over the start. ${budget} ticks.`;
    case 'specialist': return `Finish with the highest net worth under today's prices: ${name(goal.favoured ?? 1)} pays far more, ${name(goal.shunned ?? 1)} barely pays. ${budget} ticks.`;
    default: return `Finish with the highest net worth after ${budget} ticks.`;
  }
}

/** Par as a score, or null when there is none. */
export const parText = (goal: Goal, par: number | null): string | null => (par === null ? null : scoreText(goal.kind, par));

export interface QuotaRow { item: number; name: string; have: number; quota: number; done: boolean; fraction: number }
/** Festival bars: one row per item that has a quota, `have` capped at the quota for the bar and shown as is in the text. */
export function quotaRows(goal: Goal, deposited: readonly number[] | undefined): QuotaRow[] {
  const rows: QuotaRow[] = [];
  for (let c = 1; c < ITEMS.length; c++) {
    const quota = goal.quotas?.[c] ?? 0;
    if (quota <= 0) continue;
    const have = deposited?.[c] ?? 0;
    rows.push({ item: c, name: name(c), have, quota, done: have >= quota, fraction: Math.min(1, have / quota) });
  }
  return rows;
}

export interface FinalView {
  /** 'provisional' while the day is open or hidden farms are unscored, 'final' once the server has the final score, 'none' when there is nothing to say. */
  state: 'none' | 'provisional' | 'final';
  lines: string[];
}
export interface FinalInput {
  kind: GoalKind; hiddenFarms: number; closesAt: number | null; now: number;
  /** The server's answer for this run, when there is one. */
  entry: { score?: number | null; finalScore?: number | null; finalParTick?: number | null; provisional?: boolean } | null;
  /** The visible farm's score from the local replay (used while the server has not answered). */
  visible: number;
}

/**
 * What the result card says about the hidden farms. Open day: the visible score is provisional and the program runs on the hidden farms at close.
 * Closed day with a final score: visible, hidden total and final.
 */
export function finalView(i: FinalInput): FinalView {
  if (i.hiddenFarms <= 0) return { state: 'none', lines: [] };
  const farms = i.hiddenFarms === 1 ? 'one hidden farm' : `${i.hiddenFarms} hidden farms`;
  const e = i.entry;
  if (e && e.finalScore != null && e.provisional !== true) {
    const visible = e.score ?? i.visible;
    const lines = [
      `Final score ${scoreText(i.kind, e.finalScore)}`,
      `Visible farm ${scoreText(i.kind, visible)} · ${farms} ${scoreText(i.kind, e.finalScore - visible)}`,
    ];
    if (e.finalParTick != null) lines.push(`Par reached on every farm together by a summed tick of ${fmt(e.finalParTick)}`);
    return { state: 'final', lines };
  }
  const open = i.closesAt === null || i.closesAt > i.now;
  return {
    state: 'provisional',
    lines: [
      'Provisional until the day closes.',
      open ? `When it closes, your program also runs on ${farms}, and the final score is the sum over all farms.` : `The day has closed. Your program is running on ${farms}; the final score appears on the board once they are scored.`,
    ],
  };
}

/** Labels of the twists for the HUD and start card: the brief's own labels, or "No twists today". */
export const twistLines = (labels: readonly string[]): string[] => (labels.length ? [...labels] : ['No twists today']);
