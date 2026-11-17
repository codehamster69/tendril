import { BUILDINGS, CROPS, OPS } from '@tendril/sim/src/index.ts';
import type { Snapshot } from '@tendril/sim/src/index.ts';

export type Tile = Snapshot['tiles'][number];
export interface TileInfo { title: string; note?: string; rows: [label: string, value: string][]; exprs: string[] }

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Ticks until a crop in `stage` is ripe, at most (growth speed depends on soil, so this is the upper bound). */
export function ticksToRipe(crop: number, stage: number): number {
  const c = CROPS[crop];
  return c && crop > 0 ? Math.max(0, 3 - stage) * c.stageLen : 0;
}

/** Bots standing on the tile, and bots within two tiles (a drone about to work it). */
export function botsAt(s: Snapshot, x: number, y: number): { id: number; here: boolean; doing: string }[] {
  const out: { id: number; here: boolean; doing: string }[] = [];
  s.bots.forEach((b, id) => {
    const d = Math.abs(b.x - x) + Math.abs(b.y - y);
    if (d > 2) return;
    const doing = b.op === null || b.busyUntil <= s.tick ? 'idle' : `${OPS[b.op]} · ${b.busyUntil - s.tick}t left`;
    out.push({ id, here: d === 0, doing });
  });
  return out;
}

/** Everything the tooltip says about one tile, plus the Sprout expressions that read the same values. */
export function tileInfo(s: Snapshot, t: Tile, silo = { drops: 0 }): TileInfo {
  const barn = t.x === 0 && t.y === 0;
  const rows: [string, string][] = [];
  let title: string;
  if (barn) title = 'Barn';
  else if (t.building) title = cap(BUILDINGS[t.building]?.name ?? 'building');
  else if (t.crop) title = cap(CROPS[t.crop]!.name);
  else title = t.tilled ? 'Tilled soil' : 'Grass';
  if (t.building === 1) rows.push(['Honey', `${t.honey} ready`]);
  let note: string | undefined;
  if (t.building === 3 && !barn) { note = 'Silo. Bots can drop and sell here.'; rows.push(['Drops', `${silo.drops} in the last 500 ticks`]); }
  if (t.crop) {
    rows.push(['Growth', `stage ${t.stage} of 3`]);
    rows.push(['Ripe', t.stage >= 3 ? 'now' : `in up to ${ticksToRipe(t.crop, t.stage)} ticks`]);
  }
  rows.push(['Water', String(t.moisture)], ['Nitrogen', String(t.nitrogen)], ['Fatigue', String(t.fatigue)]);
  for (const b of botsAt(s, t.x, t.y)) rows.push([`Bot ${b.id}`, `${b.here ? 'here' : 'near'} · ${b.doing}`]);
  const at = `scan_at(${t.x}, ${t.y})`;
  const exprs = [`${at}.moisture`, `${at}.nitrogen`, ...(t.crop ? [`${at}.ripe`] : [`${at}.empty`])];
  return { title, note, rows, exprs };
}

/** Pixel position for a floating card: beside the pointer, kept inside the viewport. */
export function placeCard(px: number, py: number, w: number, h: number, vw: number, vh: number, gap = 16): { x: number; y: number } {
  let x = px + gap, y = py + gap;
  if (x + w > vw - 8) x = px - gap - w;
  if (y + h > vh - 8) y = py - gap - h;
  return { x: Math.max(8, x), y: Math.max(8, y) };
}

/** Positions on a track, 0 to 1: the deadline, and now. With a day length the track is the day; otherwise it is the contract's own lifetime. */
export function deadlineTrack(o: { opensAt: number; deadline: number }, tick: number, dayLen: number | null): { now: number; due: number } {
  const clamp = (v: number): number => Math.min(1, Math.max(0, v));
  if (dayLen && dayLen > 0) return { now: clamp(tick / dayLen), due: clamp(o.deadline / dayLen) };
  const span = Math.max(1, o.deadline - o.opensAt);
  return { now: clamp((tick - o.opensAt) / span), due: 1 };
}
