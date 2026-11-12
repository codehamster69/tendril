/** Host shown in shared text. Entry links are `<host>/r/<entryId>` (B4). */
export const SHARE_HOST = 'tendril.hokora.xyz';

const TILE: Record<string, string> = { B: '🏠', h: '🐝', c: '🟤', t: '🟫', '0': '🟩' };
const CROP_EMOJI = ['', '🥕', '🌾', '🍀', '🎃', '🫐', '🍎'];
// Crop ids 1..6 follow CROPS order: carrot, wheat, clover, pumpkin, berry, apple.

/** The 64-character farm mosaic as eight rows of eight emoji. */
export function mosaicEmoji(mosaic: string): string[] {
  const chars = [...mosaic];
  const rows: string[] = [];
  for (let y = 0; y < 8; y++) rows.push(chars.slice(y * 8, y * 8 + 8).map((c) => TILE[c] ?? CROP_EMOJI[Number(c)] ?? '🟩').join(''));
  return rows;
}

export interface ShareInput {
  number: number | null; netWorth: number; parTick: number | null; par: number | null;
  /** 1-based "at or above this share of players", from the server. Null when signed out. */
  percentile: number | null; mosaic: string; entryId: string | null; label?: string;
}

export const topShare = (percentile: number): number => Math.min(100, Math.max(1, 101 - percentile));

/** The text behind "Copy result". The tokens line joins in C3. */
export function shareText(r: ShareInput): string {
  const head = [`Tendril ${r.number !== null ? `#${r.number}` : (r.label ?? 'challenge')}`, `${r.netWorth.toLocaleString('en-US')} coins`];
  if (r.percentile !== null) head.push(`top ${topShare(r.percentile)}%`);
  const second = r.par === null ? [] : [r.parTick === null ? 'Par not reached' : `Par at tick ${r.parTick.toLocaleString('en-US')}`];
  return [head.join(' · '), ...(second.length ? [second.join(' · ')] : []), ...mosaicEmoji(r.mosaic), r.entryId ? `${SHARE_HOST}/r/${r.entryId}` : SHARE_HOST].join('\n');
}

/** Clipboard write with a textarea fallback for desktop and older webviews. */
export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  const area = document.createElement('textarea');
  area.value = text; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0';
  document.body.append(area); area.select();
  try { return document.execCommand('copy'); } catch { return false; } finally { area.remove(); }
}
