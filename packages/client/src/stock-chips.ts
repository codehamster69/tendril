import { ITEMS, OPS, createWorld, forecast } from '@tendril/sim/src/index.ts';
import type { Snapshot } from './sim-types';
import type { FarmView } from './farm-view';
import { ITEM_COLORS, cap, el, itemName } from './palette';

const SHOWN = 6;
const FLASH_MS = 1400;

/** Barn stock as chips in the top-left HUD (icon and count), plus crew, weather and what the next purchases cost. */
export function mountStockChips(view: FarmView, seed: () => number): void {
  const host = el('div', { id: 'stock-chips', class: 'stock-chips', role: 'group', 'aria-label': 'Barn stock' });
  const more = el('div', { id: 'stock-more', class: 'hk-card stock-more', hidden: '' });
  const crewBox = el('div', { id: 'crew-list', class: 'hk-card stock-more crew-list', hidden: '' });
  const flashed = new Map<number, number>();
  let prev: number[] = [];
  let latest: Snapshot | null = null;
  let scratch: ReturnType<typeof createWorld> | null = null, scratchSeed = -1, lastForecastTick = -1e9;
  let weatherText = '', lastKey = '';

  const price = (i: number): string => {
    const base = ITEMS[i]?.price ?? 0;
    const m = i >= 1 && i <= 6 ? view.marketMultipliers()?.[i] : undefined;
    if (m === undefined) return base ? `${base}¢ each` : '';
    return `${(Math.round(base * m * 100) / 100).toString()}¢ each today (×${m.toFixed(2)})`;
  };
  const plus = el('button', { type: 'button', class: 'hk-chip stock-plus', 'aria-controls': 'stock-more' });
  plus.addEventListener('click', () => { more.hidden = !more.hidden; crewBox.hidden = true; if (latest) render(latest); });
  const crew = el('button', { type: 'button', class: 'hk-chip stock-crew', id: 'chip-crew', 'aria-controls': 'crew-list', title: 'Bots: pick one to look at' });
  crew.addEventListener('click', () => { crewBox.hidden = !crewBox.hidden; more.hidden = true; if (latest) { renderCrew(latest); render(latest); } });
  const weather = el('span', { class: 'hk-chip stock-weather', id: 'chip-weather', title: 'Weather ahead (the forecast command)' });
  const next = el('span', { class: 'hk-chip stock-next', id: 'expansion-costs', title: 'What the next purchases cost' });
  const chips = new Map<number, { node: HTMLElement; num: HTMLElement }>();
  const chip = (i: number, n: number, now: number): HTMLElement => {
    let c = chips.get(i);
    if (!c) {
      const dot = el('i', { class: 'sc-dot', 'aria-hidden': 'true' }); dot.style.background = ITEM_COLORS[i] ?? '#999';
      const num = el('b');
      c = { node: el('span', { class: 'hk-chip stock-chip', 'data-item': String(i), tabindex: '0' }, dot, num), num };
      chips.set(i, c);
    }
    c.num.textContent = n.toLocaleString();
    c.node.title = `${cap(itemName(i))}${price(i) ? ` · ${price(i)}` : ''}`;
    c.node.setAttribute('aria-label', `${n} ${itemName(i)}`);
    c.node.classList.toggle('bump', (flashed.get(i) ?? 0) > now);
    return c.node;
  };
  /** Swap children only when the set changed, so a chip under the pointer is not rebuilt. */
  const setKids = (box: HTMLElement, kids: HTMLElement[]): void => {
    const cur = box.children;
    if (cur.length === kids.length && kids.every((k, n) => cur[n] === k)) return;
    box.replaceChildren(...kids);
  };

  const render = (s: Snapshot): void => {
    const now = performance.now();
    s.stock.forEach((n, i) => { if (i > 0 && n !== (prev[i] ?? 0) && prev.length) flashed.set(i, now + FLASH_MS); });
    prev = s.stock.slice();
    const flashing = [...flashed.values()].filter((t) => t > now).length;
    const key = `${s.stock.join(',')}|${s.bots.length}|${weatherText}|${s.plotCost}|${s.botCost}|${flashing}|${more.hidden}|${crewBox.hidden}|${view.marketMultipliers()?.join(',') ?? ''}`;
    if (key === lastKey && crewBox.hidden) return;
    lastKey = key;
    const held: number[] = [];
    for (let i = 1; i < s.stock.length; i++) if ((s.stock[i] ?? 0) > 0) held.push(i);
    const kids: HTMLElement[] = held.slice(0, SHOWN).map((i) => chip(i, s.stock[i]!, now));
    if (held.length > SHOWN) {
      const rest = held.slice(SHOWN);
      plus.textContent = `+${rest.length}`;
      plus.setAttribute('aria-label', `${rest.length} more items`);
      plus.setAttribute('aria-expanded', String(!more.hidden));
      setKids(more, rest.map((i) => chip(i, s.stock[i]!, now)));
      kids.push(plus);
    } else more.hidden = true;
    crew.textContent = `Crew ${s.bots.length}`;
    crew.setAttribute('aria-expanded', String(!crewBox.hidden));
    kids.push(crew);
    if (weatherText) { weather.textContent = weatherText; kids.push(weather); }
    next.textContent = `Plot ${s.plotCost.toLocaleString()} · Bot ${s.botCost.toLocaleString()}`;
    kids.push(next);
    setKids(host, kids);
    if (!crewBox.hidden) renderCrew(s);
  };

  const renderCrew = (s: Snapshot): void => {
    crewBox.replaceChildren(...s.bots.map((b, id) => {
      const doing = b.op === null || b.busyUntil <= s.tick ? 'idle' : `${OPS[b.op]} · ${b.busyUntil - s.tick}t`;
      const row = el('button', { type: 'button', class: 'hk-button crew-row' }, el('span', { text: `Bot ${id} (${b.x}, ${b.y})` }), el('small', { text: `${b.load}/${s.capacity} · ${doing}` }));
      row.addEventListener('click', () => view.selectBot(id));
      return row;
    }));
  };

  const updateWeather = (s: Snapshot): void => {
    if (Math.abs(s.tick - lastForecastTick) < 100 && s.tick >= lastForecastTick) return;
    lastForecastTick = s.tick;
    if (!scratch || scratchSeed !== seed()) { scratch = createWorld({ id: 'forecast', seed: seed() }); scratchSeed = seed(); }
    scratch.tick = s.tick;
    const next = forecast(scratch, 2000).filter((g) => g.end > s.tick).sort((a, b) => a.start - b.start)[0];
    weatherText = !next ? (s.weather === 'clear' ? '☀ clear' : '') : next.start <= s.tick ? `${next.kind === 'frost' ? '❄ frost' : '☂ rain'} now` : `${next.kind === 'frost' ? '❄' : '☂'} ${next.kind} in ${next.start - s.tick}t`;
  };

  const mount = (): void => {
    if (host.isConnected) return;
    const hud = document.getElementById('game-hud');
    (hud ?? document.body).append(host);
    document.body.append(more, crewBox);
  };
  window.addEventListener('tendril:snapshot', (e) => {
    const s = (e as CustomEvent<Snapshot>).detail;
    latest = s;
    mount();
    updateWeather(s);
    render(s);
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && (!more.hidden || !crewBox.hidden)) { more.hidden = true; crewBox.hidden = true; if (latest) render(latest); } });
  // Highlights fade on their own: redraw once after they expire.
  window.setInterval(() => { if (latest && flashed.size) render(latest); }, 500);
}
