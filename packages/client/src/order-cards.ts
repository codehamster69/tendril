import { CROPS } from '@tendril/sim/src/index.ts';
import type { Snapshot } from './sim-types';
import { EVENT, type ViewEvent } from './sim-protocol';
import { deadlineTrack } from './tile-info';
import { ITEM_COLORS, cap, el } from './palette';

const ordersKey = (s: Snapshot): string => s.orders.map((o) => o.id).join(',');

/** One compact card per open contract, left edge. A filled contract flips and slides away. */
export function mountOrderCards(stage: HTMLElement, dayLength: () => number | null): void {
  const host = el('div', { id: 'order-cards', class: 'order-cards', role: 'list', 'aria-label': 'Open contracts' });
  stage.append(host);
  const cards = new Map<number, { node: HTMLElement; fill: HTMLElement; amount: HTMLElement; now: HTMLElement; due: HTMLElement }>();
  let have: Snapshot | null = null;

  const build = (o: Snapshot['orders'][number]) => {
    const dot = el('i', { class: 'oc-dot', 'aria-hidden': 'true' });
    dot.style.background = ITEM_COLORS[o.crop] ?? '#999';
    const amount = el('b');
    const reward = el('span', { class: 'oc-reward', text: `${o.reward}¢` });
    const fill = el('i', { class: 'oc-fill' });
    const now = el('i', { class: 'oc-now' }), due = el('i', { class: 'oc-due' });
    const track = el('span', { class: 'oc-track', 'aria-hidden': 'true' }, fill);
    const day = el('span', { class: 'oc-day', 'aria-hidden': 'true' }, now, due);
    const node = el('div', { class: 'hk-card order-card', role: 'listitem', 'data-order': String(o.id) },
      el('div', { class: 'oc-top' }, dot, el('span', { class: 'oc-name', text: cap(CROPS[o.crop]?.name ?? '?') }), amount, reward), track, day);
    host.append(node);
    return { node, fill, amount, now, due };
  };

  const render = (s: Snapshot): void => {
    have = s;
    const open = new Set(s.orders.map((o) => o.id));
    for (const o of s.orders) {
      const c = cards.get(o.id) ?? (cards.set(o.id, build(o)), cards.get(o.id)!);
      const held = Math.min(o.qty, s.stock[o.crop] ?? 0);
      c.amount.textContent = `${held}/${o.qty}`;
      c.fill.style.width = `${Math.round(held / o.qty * 100)}%`;
      c.node.classList.toggle('ready', held >= o.qty);
      const t = deadlineTrack(o, s.tick, dayLength());
      c.now.style.left = `${t.now * 100}%`; c.due.style.left = `${t.due * 100}%`;
      c.node.title = `Contract #${o.id}: ${o.qty} ${CROPS[o.crop]?.name} for ${o.reward} coins, ${Math.max(0, o.deadline - s.tick)} ticks left`;
      c.node.setAttribute('aria-label', c.node.title);
    }
    for (const [id, c] of cards) if (!open.has(id)) leave(id, c.node, false);
  };
  const leave = (id: number, node: HTMLElement, filled: boolean): void => {
    cards.delete(id);
    node.classList.add(filled ? 'filled' : 'gone');
    const done = (): void => node.remove();
    node.addEventListener('animationend', done, { once: true });
    window.setTimeout(done, 900);
  };
  window.addEventListener('tendril:snapshot', (e) => { const s = (e as CustomEvent<Snapshot>).detail; if (!have || ordersKey(have) !== ordersKey(s) || s.tick !== have.tick) render(s); });
  // A filled contract flips before it leaves: the event arrives before the next snapshot drops the card.
  window.addEventListener('tendril:events', (e) => {
    for (const ev of (e as CustomEvent<ViewEvent[]>).detail) {
      if (ev[0] !== EVENT.order) continue;
      const c = cards.get(ev[3]);
      if (c) leave(ev[3], c.node, true);
    }
  });
}
