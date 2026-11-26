// Goal HUD (K6): the brief's goal on the stage. Festival shows one quota bar per item; every other goal shows the score and par.
import './goal-hud.css';
import type { ChallengeInfo } from './api-client';
import type { GoalProgress } from './goal-progress';
import { briefOf } from './arena';
import { GOAL_NAMES, parText, quotaRows, scoreParts } from './goal-view';
import { el } from './palette';
import { getRival, hasMachine, shortName } from './machine';

export function mountGoalHud({ challenge: c }: { challenge: ChallengeInfo }): void {
  const brief = briefOf(c);
  if (!brief) return;
  const goal = brief.goal;
  const fest = goal.kind === 'festival';
  const par = c.par;
  const rows = new Map<number, { fill: HTMLElement; text: HTMLElement; row: HTMLElement }>();
  const score = el('b', { class: 'gh-score', text: '0' });
  const unit = el('small', { class: 'gh-unit', text: scoreParts(goal.kind, 0).unit });
  const parLine = par === null ? null : el('span', { class: 'gh-par', text: `Par ${parText(goal, par)!}` });
  const meter = el('i', { class: 'gh-fill' });
  // H1: where the machine's score sits on the bar, and a line naming it. Both appear once its entry is known.
  const marker = el('i', { class: 'gh-marker', hidden: '', 'aria-hidden': 'true' });
  const machine = el('span', { class: 'gh-machine', hidden: '' });
  const machineOn = hasMachine(c);
  let rivalScore: number | null = null, rivalName = '';
  const list = el('ul', { class: 'gh-quotas', 'aria-label': 'Quotas' });
  for (const r of quotaRows(goal, undefined)) {
    const fill = el('i', { class: 'gh-fill' });
    const text = el('span', { class: 'gh-have', text: `0 / ${r.quota}` });
    const row = el('li', { class: 'gh-quota', 'data-item': String(r.item) }, el('span', { class: 'gh-item', text: r.name }), el('span', { class: 'gh-bar' }, fill), text);
    rows.set(r.item, { fill, text, row }); list.append(row);
  }
  const track = el('span', { class: 'gh-track', ...(par === null ? { hidden: '' } : {}) }, el('span', { class: 'gh-bar gh-par-bar', 'aria-hidden': 'true' }, meter), marker);
  const box = el('aside', { id: 'goal-hud', class: 'hk-card goal-hud', 'data-goal': goal.kind, 'aria-label': 'Goal' },
    el('span', { class: 'gh-name', text: c.practice ? `${GOAL_NAMES[goal.kind]} · practice` : GOAL_NAMES[goal.kind] }),
    el('p', { class: 'gh-line', role: 'status', 'aria-live': 'off' }, score, unit),
    ...(fest ? [list] : parLine || machineOn ? [track] : []),
    ...(parLine ? [parLine] : []), ...(machineOn ? [machine] : []));
  document.body.append(box);

  let best = 0, last = 0;
  /** The bar runs to par, or to the machine's score when that is higher, so the marker always fits. */
  const scale = (): number => Math.max(par ?? 0, rivalScore ?? 0);
  const place = (): void => {
    const top = scale();
    if (rivalScore !== null && !fest) { track.hidden = false; marker.hidden = top <= 0; marker.style.left = `${Math.round(Math.min(1, Math.max(0, rivalScore) / (top || 1)) * 1000) / 10}%`; }
    if (top > 0 && !fest) meter.style.width = `${Math.round(Math.min(1, Math.max(0, last) / top) * 100)}%`;
    if (rivalScore !== null) {
      const passed = best > rivalScore;
      const p = scoreParts(goal.kind, rivalScore);
      machine.textContent = `${rivalName} ${p.num}${p.unit.startsWith('%') ? '%' : ''}${passed ? ' · passed' : ''}`;
      machine.dataset.passed = String(passed); machine.hidden = false;
    }
  };
  const takeRival = (): void => {
    const s = getRival();
    if (s.kind !== 'rival') return;
    rivalScore = s.rival.score; rivalName = shortName(s.rival.model); place();
  };
  window.addEventListener('tendril:rival', takeRival);
  takeRival();
  const paint = (g: GoalProgress): void => {
    const p = scoreParts(goal.kind, g.score);
    score.textContent = p.num; unit.textContent = p.unit;
    if (fest) for (const r of quotaRows(goal, g.deposited)) {
      const o = rows.get(r.item); if (!o) continue;
      o.fill.style.width = `${Math.round(r.fraction * 100)}%`;
      o.text.textContent = `${r.have.toLocaleString('en-US')} / ${r.quota.toLocaleString('en-US')}`;
      o.row.dataset.done = String(r.done);
    }
    best = Math.max(best, g.score); last = g.score;
    place();
    box.dataset.par = par !== null && best >= par ? 'reached' : 'short';
    if (parLine) parLine.textContent = par !== null && best >= par ? `Par ${parText(goal, par)!} · reached` : `Par ${parText(goal, par)!}`;
  };
  window.addEventListener('tendril:goal', (e) => paint((e as CustomEvent<GoalProgress>).detail));
  // A new run (reset to tick 0) starts the par line again.
  window.addEventListener('tendril:snapshot', (e) => { if ((e as CustomEvent<{ tick: number }>).detail.tick === 0) { best = 0; last = 0; box.dataset.par = 'short'; place(); } });
}
