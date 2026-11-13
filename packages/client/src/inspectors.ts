import { CROPS, OPS, createWorld, forecast } from '@tendril/sim/src/index.ts';
import type { Snapshot } from './sim-types';
import type { FarmView } from './farm-view';
import { ITEM_COLORS, buildingName, cap, el, itemName } from './palette';

type Overlay = 'none' | 'moisture' | 'nitrogen' | 'fatigue';

export function mountInspectors(view: FarmView, seed: () => number): void {
  const tools = document.getElementById('stage-tools')!;
  const lens = el('select', { id: 'soil-overlay', 'aria-label': 'Soil lens' });
  for (const key of ['none', 'moisture', 'nitrogen', 'fatigue'] as const) lens.append(el('option', { value: key, text: key === 'none' ? 'Natural' : cap(key) }));
  lens.addEventListener('change', () => view.setOverlay(lens.value as Overlay));
  const frame = el('button', { id: 'btn-focus-farm', type: 'button', text: 'Frame farm' });
  frame.addEventListener('click', () => view.focusFarm());
  const tile = el('p', { id: 'tile-inspector', text: 'Click a tile, or focus the farm and use the arrow keys, to read its soil.' });
  // Read out once per selection (the visible line above changes every snapshot, which would be too chatty for a live region).
  const announce = el('p', { id: 'tile-announce', class: 'sr-only', role: 'status' });
  tools.append(el('div', { id: 'farm-inspector' }, el('label', {}, 'Soil lens', lens), frame, tile, announce));

  const deck = document.getElementById('deck-farm')!;
  const soil = el('section', { class: 'card' });
  const barn = el('section', { class: 'card' });
  const market = el('section', { class: 'card', id: 'market-orders' });
  const crew = el('section', { class: 'card', id: 'crew-inspector' });
  deck.append(el('div', { class: 'cards' }, soil, barn, market, crew));

  let latest: Snapshot | null = null;
  let selected: { x: number; y: number } | null = null;
  let scratch: ReturnType<typeof createWorld> | null = null;
  let scratchSeed = -1;

  const updateTile = (): void => {
    if (!selected || !latest) return;
    const t = latest.tiles.find((v) => v.x === selected!.x && v.y === selected!.y);
    if (!t) { tile.textContent = `(${selected.x}, ${selected.y}) · not your land yet`; return; }
    const what = t.x === 0 && t.y === 0 ? 'Barn'
      : t.building ? `${cap(buildingName(t.building))}${t.building === 1 ? ` · ${t.honey} honey ready` : ''}`
        : t.crop ? `${cap(CROPS[t.crop]!.name)} · stage ${t.stage}/3${t.stage === 3 ? ' · ripe' : ''}` : t.tilled ? 'Tilled soil' : 'Grass';
    tile.textContent = `(${t.x}, ${t.y}) ${what} · 💧${t.moisture} N${t.nitrogen} fatigue ${t.fatigue}`;
  };

  const meter = (name: string, v: number): HTMLElement => {
    const bar = el('span', { class: 'bar' }, el('i'));
    (bar.firstChild as HTMLElement).style.width = `${v}%`;
    return el('div', { class: `meter-row ${name}` }, cap(name), bar, el('b', { text: `${v}` }));
  };

  const renderForecast = (s: Snapshot): void => {
    const host = document.getElementById('forecast');
    if (!host) return;
    if (!scratch || scratchSeed !== seed()) { scratch = createWorld({ id: 'forecast', seed: seed() }); scratchSeed = seed(); }
    scratch.tick = s.tick;
    const horizon = 2000, cells = 20, per = horizon / cells;
    const segs = forecast(scratch, horizon);
    host.replaceChildren(el('span', { class: 'legend', text: 'next 2000 ticks' }));
    for (let i = 0; i < cells; i++) {
      const a = s.tick + i * per, b = a + per;
      const hit = segs.find((g) => g.start < b && g.end > a);
      const cell = el('span', { class: `seg ${hit?.kind ?? 'clear'}`, title: hit ? `${hit.kind} from tick ${hit.start} to ${hit.end}` : 'clear' });
      cell.style.height = hit ? (hit.kind === 'frost' ? '22px' : '16px') : '6px';
      host.append(cell);
    }
  };

  window.addEventListener('tendril:tile', (event) => {
    selected = (event as CustomEvent<{ x: number; y: number }>).detail;
    updateTile();
    announce.textContent = tile.textContent;
  });
  window.addEventListener('tendril:snapshot', (event) => {
    const s = (event as CustomEvent<Snapshot>).detail;
    latest = s;
    updateTile();
    renderForecast(s);
    document.getElementById('hud-plots')!.textContent = String(s.plots.length);
    document.getElementById('hud-bots')!.textContent = String(s.bots.length);

    const n = Math.max(1, s.tiles.length);
    const avg = (f: 'moisture' | 'nitrogen' | 'fatigue') => Math.round(s.tiles.reduce((sum, t) => sum + t[f], 0) / n);
    const planted = s.tiles.filter((t) => t.crop).length;
    const ripe = s.tiles.filter((t) => t.crop && t.stage === 3).length;
    soil.replaceChildren(el('h3', { text: 'Soil · field average' }), meter('moisture', avg('moisture')), meter('nitrogen', avg('nitrogen')),
      meter('fatigue', avg('fatigue')), el('p', { class: 'muted', text: `${planted} planted · ${ripe} ripe · ${s.tiles.filter((t) => t.building).length} buildings` }));

    const items = el('div', { class: 'items', id: 'barn-stock' });
    for (let i = 1; i < s.stock.length; i++) {
      const dot = el('span', { class: 'dot' }); dot.style.background = ITEM_COLORS[i]!;
      items.append(el('div', { class: 'item' }, dot, cap(itemName(i)), el('b', { text: String(s.stock[i]) })));
    }
    barn.replaceChildren(el('h3', { text: 'Barn stock' }), items,
      el('p', { class: 'muted', id: 'expansion-costs', text: `Next plot ${s.plotCost.toLocaleString()} · next bot ${s.botCost.toLocaleString()} coins` }));

    const orders = el('div', { class: 'row-list' });
    if (!s.orders.length) orders.append(el('p', { class: 'muted', text: s.tick < 200 ? 'First contract arrives at tick 200.' : 'No open contracts.' }));
    for (const o of s.orders) {
      const left = Math.max(0, o.deadline - s.tick);
      const have = s.stock[o.crop]! >= o.qty;
      orders.append(el('div', { class: 'row' }, el('span', { text: `#${o.id} · ${o.qty} ${CROPS[o.crop]!.name}${have ? ' ✓' : ''}` }), el('b', { text: `${o.reward}¢ · ${left}t` })));
    }
    market.replaceChildren(el('h3', { text: 'Contracts' }), orders);

    const bots = el('div', { class: 'row-list' });
    s.bots.forEach((b, id) => {
      const doing = b.op === null ? 'idle' : `${OPS[b.op]} · ${Math.max(0, b.busyUntil - s.tick)}t`;
      const row = el('button', { class: 'row', type: 'button' }, el('span', { text: `Bot ${id} (${b.x}, ${b.y})` }), el('span', { class: 'muted', text: `${b.load}/${s.capacity} · ${doing}` }));
      row.addEventListener('click', () => view.selectBot(id));
      bots.append(row);
    });
    crew.replaceChildren(el('h3', { text: 'Crew' }), bots);
  });
}
