import type * as THREE from 'three';
import type { Bounds } from './farm-scenery';

/** Structural subset of a snapshot tile, so the minimap stays decoupled from the sim types. */
export interface MiniTile { x: number; y: number; crop: number; stage: number; tilled: boolean | number; building: number }
export interface MinimapBot { x: number; z: number; color: string }
export interface MinimapState {
  chunks: (fn: (cx: number, cy: number, tiles: ReadonlyMap<string, MiniTile>) => void) => void;
  quad: THREE.Vector3[];
  bots: MinimapBot[];
  selected: { x: number; z: number } | null;
  home: { x: number; z: number };
  bounds: Bounds | null;
}

export const MINIMAP_SIZE = 144;
const PAD = 8;
/** Smallest drawn marker (CSS px) for a built tile, so land stays visible at any scale. */
export const MIN_MARKER = 2.5;

export interface MapView { x0: number; z0: number; scale: number }

/**
 * Frames built land, the viewport and home. Scale is px per tile and follows the content, never a fixed farm size.
 * The view is centred in the square.
 */
export function frameMap(bounds: Bounds | null, quad: ReadonlyArray<{ x: number; z: number }>, home: { x: number; z: number }, size = MINIMAP_SIZE): MapView {
  let x0 = home.x - 4, x1 = home.x + 4, z0 = home.z - 4, z1 = home.z + 4;
  if (bounds) { x0 = Math.min(x0, bounds.x0 - 0.5); x1 = Math.max(x1, bounds.x1 + 0.5); z0 = Math.min(z0, bounds.z0 - 0.5); z1 = Math.max(z1, bounds.z1 + 0.5); }
  for (const p of quad) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
  }
  const span = Math.max(x1 - x0, z1 - z0, 1);
  const scale = (size - PAD * 2) / span;
  return { x0: (x0 + x1) / 2 - (size / 2) / scale, z0: (z0 + z1) / 2 - (size / 2) / scale, scale };
}

export const worldToMap = (v: MapView, x: number, z: number): [number, number] => [(x - v.x0) * v.scale, (z - v.z0) * v.scale];
export const mapToWorld = (v: MapView, px: number, py: number): { x: number; z: number } => ({ x: px / v.scale + v.x0, z: py / v.scale + v.z0 });

/** Drawn size and sampling step of a tile at this scale: never below MIN_MARKER, and sampled so work follows the screen. */
export function tileDraw(scale: number): { px: number; step: number } {
  if (scale >= MIN_MARKER) return { px: scale, step: 1 };
  return { px: MIN_MARKER, step: Math.max(1, Math.ceil(MIN_MARKER / scale)) };
}

const YOUNG = [0x8f, 0xbf, 0x6a], RIPE: Record<number, number[]> = {
  1: [0xf0, 0x8a, 0x24], 2: [0xe6, 0xc3, 0x4a], 3: [0x8f, 0xbf, 0x6a], 4: [0xd2, 0x60, 0x1a], 5: [0x8a, 0x3a, 0x8f], 6: [0xc8, 0x3a, 0x32],
};
/** Colour of a tile: crops fade from young green to their ripe colour, soil brown, buildings gold, grass green. */
export function tileColor(t: MiniTile): string {
  if (t.building) return '#e8a92a';
  if (t.crop) {
    const r = RIPE[t.crop] ?? YOUNG, k = Math.pow(Math.min(3, Math.max(0, t.stage)) / 3, 2);
    return `rgb(${YOUNG.map((c, i) => Math.round(c + (r[i]! - c) * k)).join(',')})`;
  }
  return t.tilled ? '#6b4636' : '#4e9a63';
}

/** "Close", "Field" or "Map" plus pixels per tile and merged-cell note. */
export function lodLabel(lod: 0 | 1 | 2, tilePx: number, cells = 1): string {
  const name = lod === 0 ? 'Close' : lod === 1 ? 'Field' : 'Map';
  const px = tilePx < 1 ? '<1' : String(Math.round(tilePx));
  return `${name} · ${px} px per tile${cells > 1 ? ` · ${cells}x${cells} tiles per cell` : ''}`;
}

export class FarmMinimap {
  readonly canvas: HTMLCanvasElement;
  readonly element: HTMLElement;
  onJump?: (x: number, z: number) => void;
  private ctx: CanvasRenderingContext2D | null;
  private view: MapView = { x0: 0, z0: 0, scale: 1 };
  private state: MinimapState | null = null;
  private dirty = true;
  private lastDraw = 0;
  private dragging = false;
  private dpr = 1;
  private timer = 0;
  private info: HTMLElement;

  constructor(host: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'farm-minimap-canvas';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'application');
    this.canvas.setAttribute('aria-label', 'Farm minimap. Click or drag to move the camera. Arrow keys nudge it.');
    this.ctx = this.canvas.getContext('2d');
    this.info = document.createElement('span');
    const head = document.createElement('span');
    head.className = 'fh-lbl';
    const toggle = document.createElement('button');
    toggle.type = 'button'; toggle.className = 'fh-mini-toggle'; toggle.id = 'farm-minimap-toggle';
    this.info.className = 'fh-mini-info';
    head.append(toggle, this.info);
    this.element = document.createElement('div');
    this.element.id = 'farm-minimap';
    this.element.className = 'fh-card';
    this.element.append(head, this.canvas);
    host.append(this.element);
    let collapsed = false;
    try { const v = window.localStorage.getItem('tendril.minimap'); collapsed = v === null ? window.matchMedia('(max-width: 640px)').matches : v === 'collapsed'; } catch { /* storage blocked: default */ }
    const apply = (): void => {
      this.element.classList.toggle('collapsed', collapsed);
      toggle.textContent = collapsed ? 'Map +' : 'Map −';
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.setAttribute('aria-label', collapsed ? 'Show minimap' : 'Hide minimap');
      if (!collapsed) this.dirty = true;
    };
    toggle.addEventListener('click', () => {
      collapsed = !collapsed; apply();
      try { window.localStorage.setItem('tendril.minimap', collapsed ? 'collapsed' : 'open'); } catch { /* ignore */ }
    });
    apply();
    this.resize();
    this.canvas.addEventListener('pointerdown', this.down);
    this.canvas.addEventListener('pointermove', this.move);
    this.canvas.addEventListener('pointerup', this.up);
    this.canvas.addEventListener('pointercancel', this.up);
    this.canvas.addEventListener('keydown', this.key);
    this.timer = window.setInterval(() => this.flush(), 125);
  }

  /** Stores the newest state and marks the minimap dirty. Drawing happens on the 8 Hz timer. */
  update(m: MinimapState): void {
    this.state = m;
    this.dirty = true;
  }

  private resize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = this.canvas.height = Math.round(MINIMAP_SIZE * this.dpr);
  }

  private flush(): void {
    if (!this.dirty || !this.state || !this.ctx || document.hidden) return;
    const now = performance.now();
    if (now - this.lastDraw < 120) return;
    this.lastDraw = now;
    this.dirty = false;
    this.draw(this.state);
  }

  private draw(m: MinimapState): void {
    const g = this.ctx!;
    const quad = m.quad.map((p) => ({ x: p.x, z: p.z }));
    this.view = frameMap(m.bounds, quad, m.home);
    const v = this.view, S = MINIMAP_SIZE;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = '#0b2226';
    g.fillRect(0, 0, S, S);
    if (m.bounds) {
      const [ax, ay] = worldToMap(v, m.bounds.x0 - 0.5, m.bounds.z0 - 0.5), [bx, by] = worldToMap(v, m.bounds.x1 + 0.5, m.bounds.z1 + 0.5);
      g.fillStyle = '#1f4a3a';
      g.fillRect(ax, ay, Math.max(MIN_MARKER, bx - ax), Math.max(MIN_MARKER, by - ay));
    }
    const { px, step } = tileDraw(v.scale);
    m.chunks((_cx, _cy, tiles) => {
      for (const t of tiles.values()) {
        if (step > 1 && (t.x % step !== 0 || t.y % step !== 0)) continue;
        const [sx, sy] = worldToMap(v, t.x - 0.5, t.y - 0.5);
        if (sx < -px || sy < -px || sx > S || sy > S) continue;
        g.fillStyle = tileColor(t);
        g.fillRect(sx, sy, px, px);
      }
    });
    const pts = quad.map((p) => worldToMap(v, p.x, p.z));
    if (pts.length >= 3 && pts.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))) {
      g.beginPath();
      pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
      g.closePath();
      g.fillStyle = 'rgba(213,182,91,.10)';
      g.fill();
      g.strokeStyle = '#d5b65b';
      g.lineWidth = 2;
      g.stroke();
    }
    const [hx, hy] = worldToMap(v, m.home.x, m.home.z);
    g.strokeStyle = '#dcebec';
    g.lineWidth = 1.5;
    g.strokeRect(hx - 4, hy - 4, 8, 8);
    for (const b of m.bots) {
      const [bx, by] = worldToMap(v, b.x, b.z);
      g.fillStyle = b.color;
      g.beginPath();
      g.arc(bx, by, 4, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#06161a';
      g.lineWidth = 1.5;
      g.stroke();
    }
    if (m.selected) {
      const [sx, sy] = worldToMap(v, m.selected.x, m.selected.z), z = Math.max(6, v.scale);
      g.strokeStyle = '#fff';
      g.lineWidth = 2;
      g.strokeRect(sx - z / 2, sy - z / 2, z, z);
    }
  }

  private jumpFrom(e: PointerEvent): void {
    const r = this.canvas.getBoundingClientRect();
    const w = mapToWorld(this.view, ((e.clientX - r.left) / r.width) * MINIMAP_SIZE, ((e.clientY - r.top) / r.height) * MINIMAP_SIZE);
    this.onJump?.(w.x, w.z);
    this.dirty = true;
  }
  private down = (e: PointerEvent): void => { this.canvas.setPointerCapture(e.pointerId); this.dragging = true; this.jumpFrom(e); };
  private move = (e: PointerEvent): void => { if (this.dragging) this.jumpFrom(e); };
  private up = (): void => { this.dragging = false; };
  private key = (e: KeyboardEvent): void => {
    const d: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const k = d[e.key];
    const q = this.state?.quad;
    if (!k || !q || q.length < 3) return;
    e.preventDefault();
    let cx = 0, cz = 0;
    for (const p of q) { cx += p.x; cz += p.z; }
    const step = 24 / this.view.scale;
    this.onJump?.(cx / q.length + k[0] * step, cz / q.length + k[1] * step);
  };

  setInfo(text: string): void { this.info.textContent = text; }

  dispose(): void {
    window.clearInterval(this.timer);
    this.element.remove();
  }
}
