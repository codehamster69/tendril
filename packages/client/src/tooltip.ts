import type { Snapshot } from './sim-types';
import type { FarmView } from './farm-view';
import { placeCard, tileInfo, type Tile, type TileInfo } from './tile-info';
import { el } from './palette';

const DWELL_MS = 150;
const REFRESH_MS = 200;

type XY = { x: number; y: number };

/**
 * Hover tooltip and pinned card for a tile. Hovering costs one ground-plane lookup after the pointer rests 150 ms
 * (no per-move scene work); a click pins the card and adds the Sprout expressions that read the same values.
 */
export function mountTooltip(view: FarmView, canvas: HTMLElement): void {
  const tip = el('div', { id: 'tile-tip', class: 'hk-card tile-tip', role: 'tooltip', hidden: '' });
  const pin = el('div', { id: 'tile-pin', class: 'hk-card tile-tip tile-pin', role: 'dialog', 'aria-label': 'Pinned tile', hidden: '' });
  const announce = el('p', { id: 'tile-announce', class: 'sr-only', role: 'status' });
  document.body.append(tip, pin, announce);

  let latest: Snapshot | null = null;
  let pointer = { x: 0, y: 0 };
  let hover: XY | null = null;
  let pinned: XY | null = null;
  let timer = 0;
  let lastRefresh = 0;

  const find = (p: XY): Tile | undefined => latest?.tiles.find((t) => t.x === p.x && t.y === p.y);
  // Silo drops are a view-side tally (see silo-drops.ts), so the tooltip asks the view for them.
  const infoOf = (t: Tile): TileInfo => tileInfo(latest!, t, { drops: t.building === 3 ? view.siloDropsAt(t.x, t.y, latest!.tick) : 0 });
  const body = (info: TileInfo, withExprs: boolean): Node[] => {
    const out: Node[] = [el('h3', { text: info.title })];
    if (info.note) out.push(el('p', { class: 'tip-note', text: info.note }));
    const dl = el('dl');
    for (const [k, v] of info.rows) dl.append(el('dt', { text: k }), el('dd', { text: v }));
    out.push(dl);
    if (withExprs) out.push(el('p', { class: 'tip-hint', text: 'Read it in Sprout:' }), ...info.exprs.map((e) => el('code', { text: e })));
    return out;
  };
  const place = (box: HTMLElement, x: number, y: number): void => {
    const r = box.getBoundingClientRect();
    const p = placeCard(x, y, r.width, r.height, window.innerWidth, window.innerHeight);
    box.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
  };

  /** The docked Inspector panel mirrors the pinned tile. */
  const inspect = (info: TileInfo | null): void => { window.dispatchEvent(new CustomEvent('tendril:inspect', { detail: info })); };
  const drawHover = (): void => {
    const t = hover && !(pinned && pinned.x === hover.x && pinned.y === hover.y) ? find(hover) : undefined;
    if (!t || !latest) { tip.hidden = true; return; }
    tip.replaceChildren(...body(infoOf(t), false));
    tip.hidden = false;
    place(tip, pointer.x, pointer.y);
  };
  const drawPin = (reposition: boolean): void => {
    const t = pinned ? find(pinned) : undefined;
    if (!pinned || !t || !latest) { pin.hidden = true; inspect(null); return; }
    const close = el('button', { type: 'button', class: 'hk-button tip-close', 'aria-label': 'Unpin', text: '✕' });
    close.addEventListener('click', unpin);
    const info = infoOf(t);
    inspect(info);
    pin.replaceChildren(close, ...body(info, true));
    const wasHidden = pin.hidden;
    pin.hidden = false;
    if (reposition || wasHidden) place(pin, pointer.x, pointer.y);
  };
  const unpin = (): void => { pinned = null; pin.hidden = true; inspect(null); drawHover(); canvas.focus?.({ preventScroll: true } as FocusOptions); };

  const resolve = (): void => {
    timer = 0;
    const rect = canvas.getBoundingClientRect();
    const g = view.groundAt((pointer.x - rect.left) / rect.width * 2 - 1, -(pointer.y - rect.top) / rect.height * 2 + 1);
    const next = g ? { x: Math.floor(g.x + 0.5), y: Math.floor(g.z + 0.5) } : null;
    hover = next && find(next) ? next : null;
    drawHover();
  };

  canvas.addEventListener('pointermove', (e) => {
    pointer = { x: e.clientX, y: e.clientY };
    if (e.buttons) { hover = null; tip.hidden = true; window.clearTimeout(timer); timer = 0; return; }
    if (!tip.hidden) place(tip, pointer.x, pointer.y);
    if (!timer) timer = window.setTimeout(resolve, DWELL_MS);
  });
  canvas.addEventListener('pointerleave', () => { hover = null; tip.hidden = true; window.clearTimeout(timer); timer = 0; });
  canvas.addEventListener('pointerdown', () => { tip.hidden = true; });
  // A click (or an arrow key) selects a tile: pin it. Moving the pin is a new selection, not a drag.
  window.addEventListener('tendril:tile', (e) => {
    pinned = { x: (e as CustomEvent<XY>).detail.x, y: (e as CustomEvent<XY>).detail.y };
    drawPin(true);
    drawHover();
    const t = find(pinned);
    if (t && latest) announce.textContent = `${infoOf(t).title} at ${t.x}, ${t.y}. ${infoOf(t).rows.map((r) => `${r[0]} ${r[1]}`).join(', ')}`;
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pin.hidden && !(e.target as HTMLElement | null)?.closest?.('.hk-overlay')) unpin(); });
  window.addEventListener('tendril:snapshot', (e) => {
    latest = (e as CustomEvent<Snapshot>).detail;
    const now = performance.now();
    if (now - lastRefresh < REFRESH_MS || (tip.hidden && pin.hidden)) return;
    lastRefresh = now;
    if (!pin.hidden) drawPin(false);
    if (!tip.hidden) drawHover();
  });
}
