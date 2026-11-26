// What goes inside each workbench panel. Most panels hold nodes other modules already built (and keep updating); Bots, Inspector,
// Reference and Settings are small views built here. Nodes are looked up lazily and kept, so a panel closed and opened again shows the same node.
import { OPS } from '@tendril/sim/src/index.ts';
import { BOT_COLORS } from './editor';
import { el } from './palette';
import { buildReference } from './reference';
import { buildSettingsPanel } from './settings-panel';
import type { Snapshot } from './sim-types';
import type { TileInfo } from './tile-info';
import { PANELS, type PanelId } from './workbench-layout';

const byId = (id: string): HTMLElement | null => document.getElementById(id);
const empty = (text: string): HTMLElement => el('p', { class: 'wb-empty', text });
const listen = <T>(name: string, cb: (detail: T) => void): void => window.addEventListener(`tendril:${name}`, (e) => cb((e as CustomEvent<T>).detail));

function botsPanel(): HTMLElement {
  const host = el('div', { class: 'wb-bots', id: 'bots-panel', 'aria-live': 'off' });
  const note = empty('No bots yet. Run your program and they appear here.');
  const list = el('ul', { class: 'wb-bot-list' });
  host.append(note, list);
  let last = 0;
  listen<Snapshot>('snapshot', (s) => {
    const now = performance.now();
    if (now - last < 250) return;
    last = now;
    note.hidden = s.bots.length > 0;
    const rows: HTMLElement[] = s.bots.map((b, i) => {
      const doing = b.op === null || b.busyUntil <= s.tick ? 'idle' : `${OPS[b.op]} · ${b.busyUntil - s.tick}t left`;
      const dot = el('i', { class: 'wb-dot' }); dot.style.background = BOT_COLORS[i % BOT_COLORS.length]!;
      return el('li', { class: 'wb-bot' }, dot, el('b', { text: `Bot ${i}` }), el('span', { class: 'wb-bot-at', text: `${b.x}, ${b.y}` }), el('span', { class: 'wb-bot-doing', text: doing }));
    });
    list.replaceChildren(...rows);
  });
  return host;
}

function inspectorPanel(): HTMLElement {
  const host = el('div', { class: 'wb-inspector', id: 'inspector-panel' });
  const hint = empty('Click a tile on the farm, or move between tiles with the arrow keys, to read it here.');
  const card = el('div', { class: 'wb-inspector-card' });
  host.append(hint, card);
  listen<TileInfo | null>('inspect', (info) => {
    hint.hidden = !!info;
    if (!info) { card.replaceChildren(); return; }
    const dl = el('dl');
    for (const [k, v] of info.rows) dl.append(el('dt', { text: k }), el('dd', { text: v }));
    card.replaceChildren(el('h3', { text: info.title }), ...(info.note ? [el('p', { class: 'tip-note', text: info.note })] : []), dl,
      el('p', { class: 'tip-hint', text: 'Read it in Sprout:' }), ...info.exprs.map((e) => el('code', { text: e })));
  });
  return host;
}

function settingsPanel(): HTMLElement {
  const line = el('p', { id: 'set-account-line', text: '' });
  const refresh = (): void => {
    const label = byId('btn-account')?.textContent?.trim();
    line.textContent = label && label !== 'Sign in' ? `Signed in as ${label}` : 'Not signed in. Local play never needs an account.';
  };
  const sign = el('button', { class: 'hk-button', type: 'button', text: 'Sign in or out' });
  sign.addEventListener('click', () => byId('btn-account')?.click());
  refresh();
  window.addEventListener('focus', refresh);
  const host = el('div', { class: 'wb-settings' }, buildSettingsPanel(el('div', { class: 'set-account' }, line, sign)));
  host.addEventListener('pointerenter', refresh);
  return host;
}

/** Builds the lookup the workbench calls for each panel's content. Call after every other mount, so the nodes exist. */
export function panelContent(insertCode: (code: string) => void): (id: PanelId) => HTMLElement {
  const made = new Map<PanelId, HTMLElement>();
  // The code slate used to carry the output tabs; take the output nodes out now, before anything looks them up by id.
  const output = { console: byId('console')!, debugger: byId('debugger')! };
  const side = byId('side')!;
  side.querySelector('.dock-tabs')?.remove();
  output.console.remove(); output.debugger.remove();
  output.console.hidden = false; output.debugger.hidden = false;
  const make = (id: PanelId): HTMLElement => {
    switch (id) {
      case 'farm': return byId('farm-stage')!;
      case 'code': return side; // the editor with its heading and footer; output lives in its own panels
      case 'console': return output.console;
      case 'debugger': return output.debugger;
      case 'orders': {
        const host = el('div', { class: 'wb-orders', id: 'orders-panel' });
        const goal = byId('goal-hud'); if (goal) host.append(goal);
        const deck = byId('deck-goals'); if (deck) { deck.hidden = false; host.append(el('h3', { class: 'wb-sub', text: 'Achievements' }), deck); }
        if (!goal) host.prepend(empty('Orders and goals for the day show here. In the Endless farm, contract cards sit on the farm itself.'));
        return host;
      }
      case 'reference': return el('div', { class: 'wb-reference' }, buildReference(insertCode));
      case 'bots': return botsPanel();
      case 'inspector': return inspectorPanel();
      case 'market': {
        const m = document.querySelector<HTMLElement>('.farm-market');
        return el('div', { class: 'wb-market' }, ...(m ? [m] : []), empty('The shared market opens on market days. Nothing to show today.'));
      }
      case 'map': {
        const m = byId('farm-minimap');
        return el('div', { class: 'wb-map' }, ...(m ? [m] : [empty('The map appears with your farm.')]));
      }
      case 'settings': return settingsPanel();
    }
  };
  const get = (id: PanelId): HTMLElement => { let n = made.get(id); if (!n) { n = make(id); made.set(id, n); } return n; };
  // Build every panel's content now, so the Bots and Inspector views are already listening when their tab is first opened.
  for (const p of PANELS) get(p.id);
  return get;
}
