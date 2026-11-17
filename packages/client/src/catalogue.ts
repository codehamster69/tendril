/** Seed catalogue data and rules of presentation. Pure: no DOM, so node tests can run it. Prices and bits come from the sim (UNLOCKS); nothing here changes a rule. */
import { UNLOCKS } from '@tendril/sim/src/index.ts';

export type SeedState = 'owned' | 'affordable' | 'locked';
export type Track = 'crops' | 'buildings' | 'tools';
export interface SeedCard {
  /** Index in UNLOCKS, also the bit in `snapshot.unlocks`. */
  bit: number; name: string; price: number; track: Track; blurb: string;
  /** What this adds to Sprout, shown as code. */
  adds: readonly string[];
  /** Thumbnail file name in assets/thumbs, without extension. */
  picture: string;
}
const META: Record<string, { track: Track; blurb: string; adds: string[]; picture: string }> = {
  carrot: { track: 'crops', blurb: 'The crop every farm starts with.', adds: ['plant carrot'], picture: 'crop_carrot_s3' },
  wheat: { track: 'crops', blurb: 'Survives frost, so routes keep working.', adds: ['plant wheat'], picture: 'crop_wheat_s3' },
  clover: { track: 'crops', blurb: 'A cheap second crop.', adds: ['plant clover'], picture: 'crop_clover_s3' },
  pumpkin: { track: 'crops', blurb: 'Slow, heavy and valuable.', adds: ['plant pumpkin'], picture: 'crop_pumpkin_s3' },
  berry: { track: 'crops', blurb: 'Regrows after every harvest.', adds: ['plant berry'], picture: 'crop_berry_s3' },
  apple: { track: 'crops', blurb: 'The priciest orchard crop.', adds: ['plant apple'], picture: 'crop_apple_s3' },
  hive: { track: 'buildings', blurb: 'Boosts yield next door and makes honey.', adds: ['build hive', 'harvest  # honey'], picture: 'prop_beehive' },
  composter: { track: 'buildings', blurb: 'Turns spare crops into fertilizer.', adds: ['build composter', 'compost', 'fertilize'], picture: 'prop_compost' },
  satchel: { track: 'tools', blurb: 'Every bot carries 30 instead of 20.', adds: ['say capacity()  # 30'], picture: 'prop_crate' },
  silo: { track: 'buildings', blurb: 'A second barn: bots deposit and sell there. From 15 December.', adds: ['build silo', 'deposit', 'sell'], picture: 'prop_silo' },
};
export const CARDS: readonly SeedCard[] = UNLOCKS.map((u, bit) => {
  const m = META[u.name];
  if (!m) throw new Error(`catalogue has no entry for ${u.name}`);
  return { bit, name: u.name, price: u.price, ...m };
});
export const TRACKS: readonly { id: Track; title: string }[] = [
  { id: 'crops', title: 'Seeds' }, { id: 'buildings', title: 'Buildings' }, { id: 'tools', title: 'Tools' },
];
/** The sim has no prerequisites, so every card can be bought in any order. Said plainly on each card. */
export const NEEDS = 'Nothing first. Any order.';

export function stateOf(card: SeedCard, unlocks: number, coins: number): SeedState {
  if (unlocks & (1 << card.bit)) return 'owned';
  return coins >= card.price ? 'affordable' : 'locked';
}
/** Case-insensitive match on the card name, or on any function or keyword it adds. */
export function matches(card: SeedCard, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === '' || card.name.includes(q) || card.adds.some((a) => a.toLowerCase().includes(q));
}
export interface Filter { query: string; affordableOnly: boolean }
export function visible(cards: readonly SeedCard[], f: Filter, unlocks: number, coins: number): SeedCard[] {
  return cards.filter((c) => matches(c, f.query) && (!f.affordableOnly || stateOf(c, unlocks, coins) === 'affordable'));
}
/** Cards that can be bought now and the player has not yet looked at. Drives the badge. */
export function unseenAffordable(unlocks: number, coins: number, seen: ReadonlySet<string>): SeedCard[] {
  return CARDS.filter((c) => stateOf(c, unlocks, coins) === 'affordable' && !seen.has(c.name));
}
/** Bits set in `now` but not in `before`. */
export function newlyOwned(before: number, now: number): SeedCard[] {
  return CARDS.filter((c) => (now & (1 << c.bit)) && !(before & (1 << c.bit)));
}
/** The line a purchase adds to the code. */
export const buyLine = (card: SeedCard): string => `unlock ${card.name}`;
/** Appends the buy line once. Returns the new source, or null when the code already buys it. */
export function withBuyLine(source: string, card: SeedCard): string | null {
  const line = buyLine(card);
  if (source.split('\n').some((l) => l.trim() === line)) return null;
  return source + (source === '' || source.endsWith('\n') ? '' : '\n') + line + '\n';
}
