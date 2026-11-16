// Start-of-day card: the goal, par, weather and orders for a run, and one button. Enter starts.
import './menu.css';
import type { ChallengeInfo } from './api-client';
import type { GameLoop } from './game-loop';
import { challengeTitle } from './arena';
import { el, itemName } from './palette';
import type { Snapshot } from './sim-types';
import { TICKS_PER_SECOND } from './clock';

export interface StartCardInfo { eyebrow: string; goal: string; par: number | null; ticks: number }

const WEATHER: Record<string, string> = { clear: 'Clear skies', rain: 'Rain: crops grow faster', frost: 'Frost: crops grow slowly' };
const fmt = (n: number): string => n.toLocaleString('en-US');

export const challengeCardInfo = (c: ChallengeInfo): StartCardInfo => ({
  eyebrow: challengeTitle(c), goal: `Finish with the highest net worth after ${fmt(c.ticks)} ticks.`, par: c.par, ticks: c.ticks,
});

/** Shows the card whenever a run sits at tick 0 and has not started. Returns a function that hides it. */
export function mountStartCard({ loop, info, skip }: { loop: GameLoop; info: StartCardInfo | null; skip?: boolean }): { hide(): void } {
  if (!info || skip) return { hide() {} };
  const overlay = el('div', { id: 'start-card', class: 'hk-overlay start-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'start-card-title', hidden: '' });
  const body = el('div', { class: 'start-body' });
  const start = el('button', { id: 'btn-start-day', class: 'hk-button hk-primary start-go', type: 'button', text: 'Start the day' });
  overlay.append(el('div', { class: 'hk-card start-panel' },
    el('p', { class: 'menu-label', text: info.eyebrow }), el('h2', { id: 'start-card-title', text: 'Today on the farm' }), body,
    el('div', { class: 'start-actions' }, start, el('small', { text: 'Press Enter' }))));
  document.body.append(overlay);

  let shown = false, dismissed = false;
  const visible = (): boolean => !overlay.hidden;
  const hide = (): void => { if (overlay.hidden) return; overlay.hidden = true; document.body.classList.remove('start-open'); };
  const row = (label: string, ...kids: (Node | string)[]): HTMLElement => el('div', { class: 'start-row' }, el('dt', { text: label }), el('dd', {}, ...kids));
  const fill = (s: Snapshot): void => {
    const live = (s.orders ?? []).filter((o) => o.opensAt <= s.tick).slice(0, 4);
    const orders = live.length
      ? el('ul', { class: 'start-orders' }, ...live.map((o) => el('li', { text: `${itemName(o.crop)} × ${o.qty} for ${fmt(o.reward)} coins, due tick ${fmt(o.deadline)}` })))
      : el('span', { text: 'None open yet. They arrive as the day goes on.' });
    body.replaceChildren(el('dl', { class: 'start-facts' },
      row('Goal', info.goal),
      ...(info.par === null ? [] : [row('Par', `${fmt(info.par)} coins. Reach it and the run is rated.`)]),
      row('Length', `${fmt(info.ticks)} ticks · about ${Math.round(info.ticks / TICKS_PER_SECOND)} s at 1×`),
      row('Weather', WEATHER[s.weather] ?? s.weather),
      row('Orders', orders)));
  };
  const go = (): void => { dismissed = true; hide(); loop.run(); };
  start.addEventListener('click', go);
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !visible() || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
    if (document.body.classList.contains('menu-open')) return;
    if (document.activeElement && document.activeElement !== start && document.activeElement.tagName === 'BUTTON') return; // Enter on another button does that button's job
    e.preventDefault(); go();
  });
  window.addEventListener('tendril:snapshot', (event) => {
    const s = (event as CustomEvent<Snapshot>).detail;
    if (s.tick > 0) { shown = dismissed = false; hide(); return; } // a run is under way; the next reset to tick 0 shows the card again
    if (shown || dismissed || loop.running) return;
    shown = true; fill(s);
    overlay.hidden = false; document.body.classList.add('start-open');
    start.focus();
  });
  return { hide };
}
