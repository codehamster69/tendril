import './farm-hud.css';
import type { LightPreset } from './farm-light';
import { FarmMinimap, lodLabel } from './farm-minimap';

export type Lens = 'none' | 'moisture' | 'nitrogen' | 'fatigue' | 'growth' | 'price';
export type ZoomMode = 'cursor' | 'center';

export interface FarmHudApi {
  home(): void;
  follow(): void; // cycles drones, then off
  rotate(steps: number): void;
  setLens(l: Lens): void;
  setLight(p: LightPreset): void;
  setZoomMode(m: ZoomMode): void;
  jumpTo(x: number, z: number): void;
}

const LIGHTS: { id: LightPreset; label: string }[] = [
  { id: 'dawn', label: 'Dawn' }, { id: 'noon', label: 'Noon' }, { id: 'golden', label: 'Golden' }, { id: 'night', label: 'Night' },
];
const LENSES: { id: Lens; label: string }[] = [
  { id: 'none', label: 'Natural' }, { id: 'moisture', label: 'Moisture' }, { id: 'nitrogen', label: 'Nitrogen' }, { id: 'fatigue', label: 'Fatigue' }, { id: 'growth', label: 'Growth' }, { id: 'price', label: 'Price' },
];
const LIGHT_KEY = 'tendril.light';
const ZOOM_KEY = 'tendril.zoomMode';
export const PRICE_UNAVAILABLE = 'Price lens needs the shared market, which is not open for this farm.';

function load(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function save(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* storage blocked: the choice just does not persist */ }
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else e.setAttribute(k, v); }
  e.append(...kids);
  return e;
}

const isTyping = (t: EventTarget | null): boolean => {
  const e = t as HTMLElement | null;
  return !!e && (e.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName) || !!e.closest?.('.cm-editor'));
};

export class FarmHud {
  readonly minimap: FarmMinimap;
  readonly root: HTMLElement;
  private followBtn: HTMLButtonElement;
  private lightBox!: HTMLDetailsElement;
  private moreBox!: HTMLDetailsElement;
  private lightName!: HTMLElement;
  private badgeTimer = 0;
  private lastPx = 0;
  private lens: HTMLSelectElement;
  private lightBtns = new Map<LightPreset, HTMLButtonElement>();
  private zoomBtns = new Map<ZoomMode, HTMLButtonElement>();
  private priceOpt: HTMLOptionElement;
  private opts: { priceAvailable?: () => boolean };
  private api: FarmHudApi;
  private stage: HTMLElement;

  constructor(stage: HTMLElement, api: FarmHudApi, opts: { priceAvailable?: () => boolean } = {}) {
    this.api = api;
    this.opts = opts;
    this.stage = stage;
    const host = (stage.querySelector('#farm-inspector') as HTMLElement | null) ?? (stage.querySelector('#stage-tools') as HTMLElement | null) ?? stage;

    const btn = (id: string, label: string, icon: string, text: string, key?: string): HTMLButtonElement => {
      const b = node('button', { type: 'button', id, class: 'fh-btn', 'aria-label': label, title: key ? `${label} (${key})` : label }, node('span', { class: 'fh-ic', 'aria-hidden': 'true', text: icon }));
      if (text) b.append(node('span', { class: 'fh-txt', text }));
      return b;
    };
    const home = btn('btn-focus-farm', 'Jump to farm', '⌂', 'Home', 'Home');
    home.addEventListener('click', () => api.home());
    this.followBtn = btn('btn-follow', 'Follow drone', '◎', 'Follow', 'F');
    this.followBtn.setAttribute('aria-pressed', 'false');
    this.followBtn.addEventListener('click', () => api.follow());
    const rotL = btn('btn-rotate-left', 'Rotate view left', '⟲', '', 'Q');
    const rotR = btn('btn-rotate-right', 'Rotate view right', '⟳', '', 'E');
    rotL.addEventListener('click', () => api.rotate(-1));
    rotR.addEventListener('click', () => api.rotate(1));
    const nav = node('div', { class: 'fh-group', role: 'group', 'aria-label': 'Camera' }, home, this.followBtn, rotL, rotR);

    const light = node('div', { class: 'fh-seg', id: 'farm-light', role: 'group', 'aria-label': 'Light' });
    this.lightName = node('span', { class: 'fh-txt' });
    for (const l of LIGHTS) {
      const b = node('button', { type: 'button', class: 'fh-seg-btn', 'data-light': l.id, 'aria-pressed': 'false', text: l.label });
      b.addEventListener('click', () => { this.chooseLight(l.id); this.lightBox.open = false; });
      this.lightBtns.set(l.id, b);
      light.append(b);
    }
    this.lightBox = node('details', { class: 'fh-more fh-light' }, node('summary', { class: 'fh-btn', 'aria-label': 'Light', title: 'Time of day' }, node('span', { class: 'fh-ic', 'aria-hidden': 'true', text: '☀' }), this.lightName),
      node('div', { class: 'fh-pop' }, node('span', { class: 'fh-lbl', text: 'Time of day' }), light));

    this.lens = node('select', { id: 'soil-overlay', class: 'fh-select', 'aria-label': 'Soil lens' });
    for (const l of LENSES) this.lens.append(node('option', { value: l.id, text: l.label }));
    this.priceOpt = this.lens.querySelector('option[value="price"]') as HTMLOptionElement;
    this.lens.addEventListener('change', () => api.setLens(this.lens.value as Lens));
    this.lens.addEventListener('focus', () => this.syncPrice());
    this.lens.addEventListener('pointerdown', () => this.syncPrice());
    const lensBox = node('label', { class: 'fh-lens', title: 'Soil lens' }, node('span', { class: 'fh-lbl', text: 'Lens' }), this.lens);

    // Zoom behaviour lives behind a disclosure so the bar stays short on phones.
    const zoom = node('div', { class: 'fh-seg', role: 'group', 'aria-label': 'Zoom behaviour' });
    for (const [id, label] of [['cursor', 'To cursor'], ['center', 'To centre']] as const) {
      const b = node('button', { type: 'button', class: 'fh-seg-btn', 'data-zoom': id, 'aria-pressed': 'false', text: label });
      b.addEventListener('click', () => this.chooseZoom(id));
      this.zoomBtns.set(id, b);
      zoom.append(b);
    }
    const hints = node('div', { class: 'fh-hints', 'aria-label': 'Keyboard and mouse shortcuts' },
      ...[['Drag', 'pan'], ['Right-drag', 'orbit'], ['Wheel', 'zoom'], ['WASD', 'pan'], ['Q E', 'turn'], ['F', 'follow'], ['Home', 'farm']].map(([k, v]) => node('span', { class: 'fh-chip' }, node('kbd', { class: 'fh-key', text: k! }), ` ${v}`)));
    this.moreBox = node('details', { class: 'fh-more' }, node('summary', { class: 'fh-btn', 'aria-label': 'View options', text: 'View' }),
      node('div', { class: 'fh-pop' }, node('span', { class: 'fh-lbl', text: 'Zoom behaviour' }), zoom, hints));

    this.root = node('div', { id: 'farm-hud', class: 'fh-bar' }, nav, this.lightBox, lensBox, this.moreBox);
    host.prepend(this.root);
    // Popovers close on an outside press or Escape, and only one is open at a time.
    document.addEventListener('pointerdown', this.onOutside, true);
    for (const d of [this.lightBox, this.moreBox]) d.addEventListener('toggle', () => { if (d.open) for (const o of [this.lightBox, this.moreBox]) if (o !== d) o.open = false; });

    this.minimap = new FarmMinimap(stage);
    this.minimap.onJump = (x, z) => api.jumpTo(x, z);

    const savedLight = load(LIGHT_KEY);
    const initial = LIGHTS.some((l) => l.id === savedLight) ? (savedLight as LightPreset) : 'golden';
    this.markLight(initial);
    api.setLight(initial);
    const savedZoom = load(ZOOM_KEY) === 'center' ? 'center' : 'cursor';
    this.markZoom(savedZoom);
    if (savedZoom !== 'cursor') api.setZoomMode(savedZoom);
    this.syncPrice();
    stage.addEventListener('keydown', this.onKey);
  }

  private chooseLight(p: LightPreset): void { this.markLight(p); save(LIGHT_KEY, p); this.api.setLight(p); }
  private chooseZoom(m: ZoomMode): void { this.markZoom(m); save(ZOOM_KEY, m); this.api.setZoomMode(m); }
  private markLight(p: LightPreset): void { this.lightName.textContent = LIGHTS.find((l) => l.id === p)?.label ?? ''; for (const [id, b] of this.lightBtns) b.setAttribute('aria-pressed', String(id === p)); }
  private markZoom(m: ZoomMode): void { for (const [id, b] of this.zoomBtns) b.setAttribute('aria-pressed', String(id === m)); }

  /** Price is offered only when a market exists; otherwise it stays visible but disabled, with the reason as a tooltip. */
  private syncPrice(): void {
    const ok = this.opts.priceAvailable ? this.opts.priceAvailable() : false;
    this.priceOpt.disabled = !ok;
    this.priceOpt.hidden = !ok;
    this.priceOpt.title = ok ? '' : PRICE_UNAVAILABLE;
    this.priceOpt.textContent = ok ? 'Price' : 'Price (no market)';
    this.lens.title = ok ? '' : PRICE_UNAVAILABLE;
    if (!ok && this.lens.value === 'price') { this.lens.value = 'none'; this.api.setLens('none'); }
  }

  private onOutside = (e: Event): void => {
    for (const d of [this.lightBox, this.moreBox]) if (d.open && !d.contains(e.target as Node)) d.open = false;
  };

  private onKey = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
    if (e.key === 'Escape') { this.lightBox.open = false; this.moreBox.open = false; return; }
    if (e.key === 'Home') { e.preventDefault(); this.api.home(); } else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); this.api.follow(); }
    // Q / E turns are handled by the camera rig on the canvas; the buttons cover pointer and touch use.
  };

  update(s: { following: boolean; lod: 0 | 1 | 2; tilePx: number; cells: number }): void {
    this.followBtn.setAttribute('aria-pressed', String(s.following));
    // The LOD readout lives in the minimap header and shows only for a moment after the zoom changes.
    if (this.lastPx > 0 && Math.abs(s.tilePx - this.lastPx) / this.lastPx > 0.02) {
      const text = lodLabel(s.lod, s.tilePx, s.cells);
      this.minimap.setInfo(text);
      this.minimap.element.dataset.lod = String(s.lod);
      window.clearTimeout(this.badgeTimer);
      this.badgeTimer = window.setTimeout(() => { this.minimap.setInfo(''); }, 1800);
    }
    this.lastPx = s.tilePx;
    this.syncPrice();
  }

  dispose(): void {
    this.stage.removeEventListener('keydown', this.onKey);
    document.removeEventListener('pointerdown', this.onOutside, true);
    window.clearTimeout(this.badgeTimer);
    this.minimap.dispose();
    this.root.remove();
  }
}

export function mountFarmHud(stage: HTMLElement, api: FarmHudApi, opts: { priceAvailable?: () => boolean } = {}): FarmHud {
  return new FarmHud(stage, api, opts);
}
