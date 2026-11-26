// "While you were away": one card when an Endless farm opens after 10+ minutes of catching up. It uses the log the
// catch-up already writes (see AwayFacts), so there is no extra replay and catch-up speed is unchanged.
import './welcome-back.css';
import type { FarmApi } from './api-client';
import { briefOf, utcToday } from './arena';
import { AWAY_MIN_TICKS, AwayFacts, awayLines, longestIdle } from './away-facts';
import { restedAway } from './account';
import { goalLine } from './goal-view';
import { el } from './palette';
import type { RealSim } from './real-sim';
import type { SimError } from './sim-protocol';
import type { Snapshot } from './sim-types';
import { dailyStreak, streakText } from './streak';
import { MS_PER_TICK, targetTick } from './clock';

export function mountWelcomeBack({ sim, api, revealLine }: { sim: RealSim; api: FarmApi; revealLine: (line: number) => void }): void {
  if (sim.mode !== 'live') return;
  const facts = new AwayFacts();
  sim.facts = facts;
  let start: { tick: number; coins: number; behind: number } | null = null;
  let firstError: SimError | null = null;
  let done = false;
  const restedTicks = Math.round(restedAway / MS_PER_TICK);

  const show = (s: Snapshot): void => {
    if (done || !start) return;
    done = true; sim.facts = null;
    if (start.behind + restedTicks < AWAY_MIN_TICKS) return;
    const lines = awayLines({
      awayTicks: start.behind + restedTicks, coinsGained: s.coins - start.coins, sold: facts.sold, restedTicks,
      error: firstError ? { bot: firstError.bot, line: firstError.line, tick: firstError.tick, message: firstError.message } : null,
      idle: firstError ? null : longestIdle(facts, s.bots.length, s.tick, start.tick),
    });
    const close = el('button', { class: 'hk-icon-button away-close', type: 'button', 'aria-label': 'Close', text: '×' });
    const card = el('div', { id: 'away-card', class: 'hk-card away-card', role: 'status' }, close, el('h3', { text: lines.title }), el('p', { class: 'away-sum', text: lines.summary }));
    if (lines.problem) {
      const p = el('p', { class: 'away-problem', text: lines.problem });
      if (lines.line) {
        const line = lines.line;
        const go = el('button', { class: 'hk-button away-go', type: 'button', text: `Show line ${line}` });
        go.addEventListener('click', () => revealLine(line));
        p.append(' ', go);
      }
      card.append(p);
    }
    if (lines.cap) card.append(el('p', { class: 'away-cap', text: lines.cap }));
    const extra = el('p', { class: 'away-extra' });
    card.append(extra);
    close.addEventListener('click', () => card.remove());
    document.body.append(card);
    // Daily nudge and streak: best effort, never blocks the card.
    void (async () => {
      const [streak, today] = await Promise.all([dailyStreak(api), api.challenge(`d-${utcToday()}`).catch(() => null)]);
      const parts: string[] = [];
      let goal = '';
      try { const b = today ? briefOf(today) : null; if (b) goal = ` ${goalLine(b.goal)}`; } catch { /* unknown rules: skip the line */ }
      if (today) parts.push(`Today's daily${today.number ? ` #${today.number}` : ''}:${goal || ' open'}`);
      if (streak !== null) parts.push(streakText(streak));
      if (!parts.length) return;
      extra.append(parts.join(' · '), ' ', el('a', { href: '?mode=daily', text: "Play today's daily" }));
    })();
  };

  window.addEventListener('tendril:errors', (e) => {
    const first = (e as CustomEvent<SimError[]>).detail[0];
    if (first && !firstError && !done && start) { firstError = first; const s = sim.latest(); if (s) show(s); }
  });
  window.addEventListener('tendril:snapshot', (e) => {
    const s = (e as CustomEvent<Snapshot>).detail;
    if (done) return;
    if (!start) { start = { tick: s.tick, coins: s.coins, behind: Math.max(0, targetTick(sim.meta, Date.now()) - s.tick) }; if (start.behind + restedTicks < AWAY_MIN_TICKS) { done = true; sim.facts = null; } return; }
    if (s.tick >= targetTick(sim.meta, Date.now()) - 30) show(s);
  });
}
