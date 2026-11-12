// E2: the streamer room. Up to 16 runs of one duel play on a single clock, ranked live by net worth. The host's farm is
// drawn large (flat by default, the real 3D renderer on request); the others are small 2D farms (one WebGL context per
// farm would hit the browser's limit of about 16 and could not hold 30 frames a second). Built on replay-view.ts: a
// Timeline per run. Pure logic (picking players, ranking, the clock) lives in room-core.ts.
import { CROPS, PLOT_SIZE } from '@tendril/sim/src/index.ts';
import type { LogEntry, Snapshot } from '@tendril/sim/src/index.ts';
import { Timeline } from './replay-view';
import { ROOM_MAX, pickPlayers } from './room-core';
import type { DuelInfo, RoomPlayer, RoomRun } from './room-core';

export * from './room-core';

const api = (path: string): string => `/api${path}`;
interface BoardRow { entryId: string; login: string; displayName: string; value: number }
import type { ReplayData } from './replay-view';

/** Fetches the duel, its board and every replay the viewer may see. Sealed replays stay sealed: no tile is built for them. */
export async function loadRoom(id: string, onProgress?: (done: number, total: number) => void, fetcher: typeof fetch = fetch): Promise<{ duel: DuelInfo; runs: RoomRun[] }> {
  const dres = await fetcher(api(`/duels/${encodeURIComponent(id)}`));
  if (!dres.ok) throw new Error(dres.status === 404 ? 'That duel does not exist.' : 'Could not load the duel.');
  const duel = (await dres.json()) as DuelInfo;
  const bres = await fetcher(api(`/challenges/${encodeURIComponent(id)}/board?medal=wealth&limit=${ROOM_MAX}`));
  if (!bres.ok) throw new Error('Could not load the room.');
  const rows = ((await bres.json()) as { entries: BoardRow[] }).entries;
  const players = pickPlayers(duel, rows);
  const fetched = await Promise.all(players.map(async (player): Promise<[RoomPlayer, ReplayData | 'sealed' | 'missing']> => {
    const res = await fetcher(api(`/entries/${encodeURIComponent(player.entryId)}/replay`));
    if (res.status === 403) return [player, 'sealed'];
    if (!res.ok) return [player, 'missing'];
    return [player, (await res.json()) as ReplayData];
  }));
  const runs: RoomRun[] = [];
  for (const [player, data] of fetched) {
    // Each Timeline re-runs its whole log once, so build them one at a time and let the page breathe in between.
    await new Promise<void>((r) => setTimeout(r, 0));
    if (data === 'sealed') runs.push({ player, state: 'sealed' });
    else if (data === 'missing') runs.push({ player, state: 'missing' });
    else runs.push({ player, state: 'live', timeline: new Timeline('duel', data.seed, data.ticks, data.actions as LogEntry[]) });
    onProgress?.(runs.length, fetched.length);
  }
  return { duel, runs };
}

// ---- small farms ----

const CROP_RGB: [number, number, number][] = [
  [0, 0, 0], [240, 140, 40], [226, 196, 96], [92, 168, 88], [232, 120, 30], [170, 60, 120], [196, 52, 52],
];
const MEADOW = '#759464', PLOT = '#678a58', SOIL = '#6b4a2f', WET = '#4f3a28';
const BUILDING_RGB = ['', '#f2c14e', '#7a6a5a'];

/** Draws the whole farm, one square per tile, scaled to fit the canvas. Cheap enough for sixteen farms at 30 frames a second. */
export function drawMiniFarm(canvas: HTMLCanvasElement, snap: Snapshot): void {
  const g = canvas.getContext('2d');
  if (!g) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of snap.plots) {
    minX = Math.min(minX, p.px * PLOT_SIZE); minY = Math.min(minY, p.py * PLOT_SIZE);
    maxX = Math.max(maxX, (p.px + 1) * PLOT_SIZE); maxY = Math.max(maxY, (p.py + 1) * PLOT_SIZE);
  }
  if (!Number.isFinite(minX)) return;
  const cols = maxX - minX, rows = maxY - minY;
  const cell = Math.max(1, Math.floor(Math.min(canvas.width / cols, canvas.height / rows)));
  const ox = Math.floor((canvas.width - cols * cell) / 2), oy = Math.floor((canvas.height - rows * cell) / 2);
  g.fillStyle = MEADOW;
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = PLOT;
  for (const p of snap.plots) g.fillRect(ox + (p.px * PLOT_SIZE - minX) * cell, oy + (p.py * PLOT_SIZE - minY) * cell, PLOT_SIZE * cell, PLOT_SIZE * cell);
  for (const t of snap.tiles) {
    const x = ox + (t.x - minX) * cell, y = oy + (t.y - minY) * cell;
    if (t.building > 0) { g.fillStyle = BUILDING_RGB[t.building] ?? '#999'; g.fillRect(x, y, cell, cell); continue; }
    if (!t.tilled && t.crop === 0) continue;
    g.fillStyle = t.moisture > 40 ? WET : SOIL;
    g.fillRect(x, y, cell, cell);
    if (t.crop > 0) {
      const rgb = CROP_RGB[Math.min(t.crop, CROPS.length - 1)] ?? CROP_RGB[1]!;
      const k = 0.45 + 0.18 * Math.min(3, t.stage); // young plants are dim, ripe ones bright
      g.fillStyle = `rgb(${Math.round(rgb[0] * k)},${Math.round(rgb[1] * k)},${Math.round(rgb[2] * k)})`;
      const pad = cell > 3 ? 1 : 0;
      g.fillRect(x + pad, y + pad, cell - 2 * pad, cell - 2 * pad);
    }
  }
  const dot = Math.max(2, Math.round(cell * 0.6)), inset = Math.floor((cell - dot) / 2);
  for (const b of snap.bots) {
    const x = ox + (b.x - minX) * cell + inset, y = oy + (b.y - minY) * cell + inset;
    g.fillStyle = '#1b2a22';
    g.fillRect(x - 1, y - 1, dot + 2, dot + 2);
    g.fillStyle = '#ffffff';
    g.fillRect(x, y, dot, dot);
  }
}

