import type { FarmView } from './farm-view';
import { mountFarmHud, type FarmHud } from './farm-hud';
import { mountLens } from './lens';
import { mountOrderCards } from './order-cards';
import { mountStockChips } from './stock-chips';
import { mountTooltip } from './tooltip';
import type { Snapshot } from './sim-types';
import { el } from './palette';
import './island-hud.css';

/** Information sits on the island: tooltip, lenses, contract cards, stock chips. The camera bar is the only panel left. */
export function mountIslandHud(view: FarmView, seed: () => number, dayLength: () => number | null): FarmHud {
  const tools = document.getElementById('stage-tools')!;
  const stage = document.getElementById('farm-stage') ?? tools;
  // The camera bar lives here (it keeps its id so e2e and keyboard users find it where it always was).
  tools.append(el('div', { id: 'farm-inspector' }));
  const hud = mountFarmHud(stage, {
    home: () => view.focusFarm(),
    follow: () => view.follow(),
    rotate: (n) => view.rotate(n),
    setLens: (l) => view.setLens(l),
    setLight: (p) => view.setLight(p),
    setZoomMode: (m) => view.setZoomMode(m),
    jumpTo: (x, z) => view.jumpTo(x, z),
  }, { priceAvailable: () => view.priceAvailable() });
  view.attachHud(hud);

  mountTooltip(view, document.getElementById('farm-canvas')!);
  mountLens(view, stage);
  mountOrderCards(stage, dayLength);
  mountStockChips(view, seed);

  // The minimap is a small corner widget only on big farms (more than 16 plots).
  window.addEventListener('tendril:snapshot', (e) => {
    const s = (e as CustomEvent<Snapshot>).detail;
    document.body.classList.toggle('farm-large', s.plots.length > 16);
    document.getElementById('hud-plots')!.textContent = String(s.plots.length);
    document.getElementById('hud-bots')!.textContent = String(s.bots.length);
  });
  return hud;
}
