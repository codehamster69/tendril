// Compact farm view: the worker-side encoder (remembers what was sent) and the main-thread store (rebuilds
// the old Snapshot shape lazily). The format lives in sim-protocol.ts.
import { PLOT_SIZE, VIEW_BOT_FIELDS, VIEW_TILE_FIELDS, viewBot, viewPlot, viewScalars } from '@tendril/sim/src/index.ts';
import type { Snapshot, SnapshotBot, SnapshotTile, ViewScalars, World } from '@tendril/sim/src/index.ts';
import { MAX_VIEW_EVENTS, VIEW_VERSION } from './sim-protocol.ts';
import type { ViewEvent, ViewUpdate } from './sim-protocol.ts';

const PLOT_INTS = PLOT_SIZE * PLOT_SIZE * VIEW_TILE_FIELDS;

const same = (a: Int32Array, b: Int32Array, bo = 0, len = a.length): boolean => {
  for (let i = 0; i < len; i++) if (a[i] !== b[bo + i]) return false;
  return true;
};

/** Worker side. Keeps the last values it sent, so an update carries only what differs. */
export class ViewEncoder {
  private plots: Int32Array[] = [];
  private bots: Int32Array = new Int32Array(0);
  private botCount = 0;
  private plotCount = -1;
  private scalarKey = '';
  private seq = 0;
  private forceFull = true;

  /** The next update is a full one (load, reset, request from the main thread). */
  reset(): void { this.forceFull = true; }

  encode(w: World, events: ViewEvent[]): { update: ViewUpdate; transfer: ArrayBuffer[] } {
    const full = this.forceFull;
    this.forceFull = false;
    if (full) { this.plots = []; this.bots = new Int32Array(0); this.botCount = 0; this.plotCount = -1; this.scalarKey = ''; }
    const planned: { index: number; data: Int32Array }[] = [];
    for (let i = 0; i < w.plots.length; i++) {
      const data = new Int32Array(PLOT_INTS);
      viewPlot(w, i, data);
      const last = this.plots[i];
      if (!last || !same(data, last)) { planned.push({ index: i, data }); this.plots[i] = data; }
    }
    const tiles = new Int32Array(planned.length * PLOT_INTS);
    const plotIndex = new Int32Array(planned.length);
    planned.forEach((p, n) => { plotIndex[n] = p.index; tiles.set(p.data, n * PLOT_INTS); });

    const row = new Int32Array(VIEW_BOT_FIELDS);
    if (this.bots.length < w.bots.length * VIEW_BOT_FIELDS) {
      const grown = new Int32Array(w.bots.length * VIEW_BOT_FIELDS);
      grown.set(this.bots);
      this.bots = grown;
    }
    const changed: number[] = [];
    const rows: number[][] = [];
    for (let i = 0; i < w.bots.length; i++) {
      viewBot(w, i, row, 0);
      const known = i < this.botCount;
      if (!known || !same(row, this.bots, i * VIEW_BOT_FIELDS)) {
        changed.push(i); rows.push(Array.from(row)); this.bots.set(row, i * VIEW_BOT_FIELDS);
      }
    }
    this.botCount = w.bots.length;
    const botIndex = Int32Array.from(changed);
    const bots = new Int32Array(rows.length * VIEW_BOT_FIELDS);
    rows.forEach((r, n) => bots.set(r, n * VIEW_BOT_FIELDS));

    const scalars = viewScalars(w);
    const key = JSON.stringify(scalars);
    const scalarsChanged = key !== this.scalarKey;
    this.scalarKey = key;
    const plotsChanged = w.plots.length !== this.plotCount;
    this.plotCount = w.plots.length;

    const base = full ? 0 : this.seq;
    this.seq++;
    const update: ViewUpdate = {
      version: VIEW_VERSION, full, seq: this.seq, base, tick: w.tick, plotIndex, tiles, botIndex, bots, botCount: w.bots.length,
      ...(plotsChanged ? { plots: w.plots.flatMap((p) => [p.px, p.py]) } : {}),
      ...(scalarsChanged ? { scalars } : {}),
      events: events.length > MAX_VIEW_EVENTS ? events.slice(-MAX_VIEW_EVENTS) : events,
    };
    return { update, transfer: [plotIndex.buffer, tiles.buffer, botIndex.buffer, bots.buffer] as ArrayBuffer[] };
  }
}

let storeIds = 0;

/** What changed in the tile list: tiles since a version, or null when the reader must rebuild everything. */
export interface TileDelta { source: number; version: number; since(version: number): SnapshotTile[] | null }
/** The old Snapshot shape (tile objects are shared with earlier snapshots, only changed ones are new), plus what changed since a version. */
export type ViewSnapshot = Snapshot & { delta: TileDelta };

export class ViewStore {
  readonly id = ++storeIds;
  private seq = 0;
  private version = 0;
  private tileList: SnapshotTile[] = [];
  private botList: SnapshotBot[] = [];
  private plotList: { px: number; py: number }[] = [];
  private scalars: ViewScalars | null = null;
  private tick = 0;
  private current: ViewSnapshot | null = null;
  private history: { version: number; full: boolean; tiles: SnapshotTile[] }[] = [];

  get ready(): boolean { return this.current !== null; }
  get tileCount(): number { return this.tileList.length; }

  /** False when this update cannot be applied (wrong format, or a delta that does not follow the last update): ask for a full one. */
  apply(u: ViewUpdate): boolean {
    if (u.version !== VIEW_VERSION) return false;
    if (u.full) { this.tileList = []; this.botList = []; this.plotList = []; this.history = []; this.scalars = null; }
    else if (u.base !== this.seq || !this.current) return false;
    this.seq = u.seq;
    this.tick = u.tick;
    // Earlier snapshots keep the list they were given: copy the references (cheap), replace only what changed.
    this.tileList = this.tileList.slice();
    if (u.plots) {
      this.plotList = [];
      for (let i = 0; i < u.plots.length; i += 2) this.plotList.push({ px: u.plots[i]!, py: u.plots[i + 1]! });
      this.tileList.length = this.plotList.length * PLOT_SIZE * PLOT_SIZE;
    }
    if (u.scalars) this.scalars = u.scalars;
    const changed: SnapshotTile[] = [];
    for (let n = 0; n < u.plotIndex.length; n++) {
      const plot = u.plotIndex[n]!, p = this.plotList[plot];
      if (!p) return false;
      for (let t = 0; t < PLOT_SIZE * PLOT_SIZE; t++) {
        const f = n * PLOT_INTS + t * VIEW_TILE_FIELDS;
        const tile: SnapshotTile = {
          x: p.px * PLOT_SIZE + (t % PLOT_SIZE), y: p.py * PLOT_SIZE + Math.floor(t / PLOT_SIZE),
          tilled: u.tiles[f]!, crop: u.tiles[f + 1]!, stage: u.tiles[f + 2]!, moisture: u.tiles[f + 3]!,
          nitrogen: u.tiles[f + 4]!, fatigue: u.tiles[f + 5]!, building: u.tiles[f + 6]!, honey: u.tiles[f + 7]!,
        };
        this.tileList[plot * PLOT_SIZE * PLOT_SIZE + t] = tile;
        changed.push(tile);
      }
    }
    this.botList.length = u.botCount;
    for (let n = 0; n < u.botIndex.length; n++) {
      const o = n * VIEW_BOT_FIELDS, i = u.botIndex[n]!;
      this.botList[i] = {
        x: u.bots[o]!, y: u.bots[o + 1]!, busyUntil: u.bots[o + 2]!, load: u.bots[o + 3]!,
        op: u.bots[o + 4]! < 0 ? null : u.bots[o + 4]!, items: Array.from(u.bots.subarray(o + 5, o + VIEW_BOT_FIELDS)),
      };
    }
    this.botList = this.botList.slice();
    if (!this.scalars) return false;
    this.version++;
    this.history.push({ version: this.version, full: u.full, tiles: changed });
    if (this.history.length > 16) this.history.shift();
    this.current = this.build();
    return true;
  }

  latest(): ViewSnapshot | null { return this.current; }

  private build(): ViewSnapshot {
    const s = this.scalars!;
    const delta: TileDelta = {
      source: this.id, version: this.version,
      since: (v) => {
        const first = this.history[0];
        if (!first || v < first.version - 1 || v > this.version) return null;
        const out: SnapshotTile[] = [];
        for (const h of this.history) {
          if (h.version <= v) continue;
          if (h.full) return null;
          out.push(...h.tiles);
        }
        return out;
      },
    };
    return {
      tick: this.tick, coins: s.coins, netWorth: s.netWorth, weather: s.weather, unlocks: s.unlocks, capacity: s.capacity,
      plots: this.plotList, bots: this.botList, stock: s.stock, orders: s.orders, plotCost: s.plotCost, botCost: s.botCost,
      tiles: this.tileList,
      delta,
    };
  }
}
