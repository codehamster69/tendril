// Start-of-day card: the goal, par, weather and orders for a run, and one button. Enter starts.
import './menu.css';
import type { ChallengeInfo } from './api-client';
import type { GameLoop } from './game-loop';
import { anotherFarm, briefOf, challengeTitle, hiddenLine, OFFLINE_LINE } from './arena';
import { GOAL_NAMES, goalLine, parText, scoreText, twistLines } from './goal-view';
import { getRival, hasMachine, startLine } from './machine';
import type { GoalKind } from '@tendril/sim/src/index.ts';
import { el, itemName } from './palette';
import type { Snapshot } from './sim-types';
import { TICKS_PER_SECOND } from './clock';

export interface StartCardInfo {
  eyebrow: string; goal: string; par: number | null; ticks: number;
  /** Today's real daily: the card says what the machine scored, or when it plays (H1). */
  machine?: { kind: GoalKind };
  /** Daily briefs: the village notice, goal name, twist labels and the lines about hidden farms and practice. */
  brief?: { notice: string; name: string; twists: string[]; parText: string | null; hidden: string; practice: boolean; offline: boolean; another: () => void };
}

const WEATHER: Record<string, string> = { clear: 'Clear skies', rain: 'Rain: crops grow faster', frost: 'Frost: crops grow slowly' };
const fmt = (n: number): string => n.toLocaleString('en-US');

export function challengeCardInfo(c: ChallengeInfo): StartCardInfo {
  const base = { eyebrow: challengeTitle(c), goal: `Finish with the highest net worth after ${fmt(c.ticks)} ticks.`, par: c.par, ticks: c.ticks };
  const brief = briefOf(c);
  const machine = hasMachine(c) ? { machine: { kind: (brief?.goal.kind ?? 'wealth') as GoalKind } } : {};
  if (!brief) return { ...base, ...machine };
  return {
    ...base, ...machine, goal: goalLine(brief.goal),
    brief: { notice: brief.notice, name: GOAL_NAMES[brief.goal.kind], twists: twistLines(brief.labels), parText: parText(brief.goal, c.par), hidden: c.practice ? '' : hiddenLine(c.hiddenFarms ?? 0, c.kind), practice: !!c.practice, offline: !!c.offline, another: () => anotherFarm(c) },
  };
}

/** Shows the card whenever a run sits at tick 0 and has not started. Returns a function that hides it. */
export function mountStartCard({ loop, info, skip }: { loop: GameLoop; info: StartCardInfo | null; skip?: boolean }): { hide(): void } {
  if (!info || skip) return { hide() {} };
  const overlay = el('div', { id: 'start-card', class: 'hk-overlay start-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'start-card-title', hidden: '' });
  const body = el('div', { class: 'start-body' });
  const another = info.brief ? el('button', { id: 'btn-start-another', class: 'hk-button start-another', type: 'button', text: info.brief.practice ? 'Another practice farm' : 'Try another farm', title: "This brief on a random farm. Never submitted." }) : null;
  another?.addEventListener('click', () => info.brief?.another());
  const start = el('button', { id: 'btn-start-day', class: 'hk-button hk-primary start-go', type: 'button', text: 'Start the day' });
  overlay.append(el('div', { class: 'hk-card start-panel' },
    el('p', { class: 'menu-label', text: info.eyebrow }), el('h2', { id: 'start-card-title', text: 'Today on the farm' }), body,
    el('div', { class: 'start-actions' }, start, el('small', { text: 'Press Enter' }), ...(another ? [another] : []))));
  document.body.append(overlay);

  let shown = false, dismissed = false;
  const visible = (): boolean => !overlay.hidden;
  const hide = (): void => { if (overlay.hidden) return; overlay.hidden = true; document.body.classList.remove('start-open'); };
  const row = (label: string, ...kids: (Node | string)[]): HTMLElement => el('div', { class: 'start-row' }, el('dt', { text: label }), el('dd', {}, ...kids));
  let lastSnap: Snapshot | null = null;
  const machineLine = (): HTMLElement[] => {
    const kind = info.machine?.kind;
    const text = kind ? startLine(getRival(), (n) => scoreText(kind, n)) : null;
    return text ? [el('p', { class: 'start-machine', role: 'status', text })] : [];
  };
  const fill = (s: Snapshot): void => {
    lastSnap = s;
    const live = (s.orders ?? []).filter((o) => o.opensAt <= s.tick).slice(0, 4);
    const orders = live.length
      ? el('ul', { class: 'start-orders' }, ...live.map((o) => el('li', { text: `${itemName(o.crop)} × ${o.qty} for ${fmt(o.reward)} coins, due tick ${fmt(o.deadline)}` })))
      : el('span', { text: 'None open yet. They arrive as the day goes on.' });
    const b = info.brief;
    const parRow = b
      ? (b.parText === null ? [] : [row('Par', b.practice ? `${b.parText}. Practice runs are never rated.` : `${b.parText}. Reach it, with a program on the slate, and the run is rated.`)])
      : (info.par === null ? [] : [row('Par', `${fmt(info.par)} coins. Reach it and the run is rated.`)]);
    body.replaceChildren(
      ...(b ? [el('blockquote', { class: 'start-notice', text: b.notice })] : []),
      ...machineLine(),
      ...(b?.offline ? [el('p', { class: 'start-offline', role: 'status', text: OFFLINE_LINE })] : []),
      el('dl', { class: 'start-facts' },
        row(b ? b.name : 'Goal', info.goal),
        ...(b ? [row('Twists', b.twists.length === 1 ? b.twists[0]! : el('ul', { class: 'start-twists' }, ...b.twists.map((t) => el('li', { text: t }))))] : []),
        ...parRow,
        row('Length', `${fmt(info.ticks)} ticks · about ${Math.round(info.ticks / TICKS_PER_SECOND)} s at 1×`),
        ...(b?.hidden ? [row('Hidden farms', b.hidden)] : []),
        row('Weather', WEATHER[s.weather] ?? s.weather),
        row('Orders', orders)));
  };
  const go = (): void => { dismissed = true; hide(); loop.run(); };
  start.addEventListener('click', go);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && visible() && !document.body.classList.contains('menu-open')) { e.preventDefault(); dismissed = true; hide(); return; } // look around or edit first; Play starts the day
    if (e.key !== 'Enter' || !visible() || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
    if (document.body.classList.contains('menu-open')) return;
    if (document.activeElement && document.activeElement !== start && document.activeElement.tagName === 'BUTTON') return; // Enter on another button does that button's job
    e.preventDefault(); go();
  });
  // The machine's score arrives in the background; the card repaints when it does.
  window.addEventListener('tendril:rival', () => { if (visible() && lastSnap) fill(lastSnap); });
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
