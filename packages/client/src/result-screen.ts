// The sunset result screen (U6): a finished challenge run ends with dusk, one slow orbit of the island and a card that rises.
import './result-screen.css';
import { EVENT } from './sim-protocol';
import type { SimError, ViewEvent } from './sim-protocol';
import type { Snapshot } from './sim-types';
import { ApiError, signedInHint } from './api-client';
import { belowPar, bestLine, hintFor, medals, rankText } from './result-model';
import type { Trail } from './result-model';
import type { ChallengeInfo, EntryResult, FarmApi } from './api-client';
import type { GameLoop } from './game-loop';
import type { FarmView, LightPreset } from './farm-view';
import { startSignIn } from './account';
import { anotherFarm, localResult, submitRun } from './arena';
import { finalView, scoreParts } from './goal-view';
import type { GoalProgress } from './goal-progress';
import { createDuelPanel } from './duel';
import { rateLine } from './rating';
import { copyText, shareText, signed, topShare } from './share';
import type { ProgramStatus } from './publish';
import { el, toast } from './palette';
import { motionQuery } from './settings';

const fmt = (n: number): string => n.toLocaleString('en-US');

// ---------------------------------------------------------------- screen

export interface ResultDeps { loop: GameLoop; api: FarmApi; challenge: ChallengeInfo; view: Pick<FarmView, 'setLight' | 'orbitBy' | 'lightPreset'> }

const BEST_KEY = 'tendril.best.v1';
const readBest = (id: string): number | null => { try { const v = JSON.parse(localStorage.getItem(BEST_KEY) ?? '{}')[id]; return typeof v === 'number' ? v : null; } catch { return null; } };
const writeBest = (id: string, v: number): void => { try { const all = JSON.parse(localStorage.getItem(BEST_KEY) ?? '{}'); all[id] = v; localStorage.setItem(BEST_KEY, JSON.stringify(all)); } catch { /* storage blocked: no personal best line next time */ } };

const ORBIT_MS = 5200;
const STAMP_MS = 520;
const COUNT_MS = 1300;
const reduced = (): boolean => motionQuery.matches;
const ease = (t: number): number => t * t * (3 - 2 * t);

export function mountResultScreen({ loop, api, challenge: c, view }: ResultDeps): void {
  let signedIn = signedInHint();
  window.addEventListener('tendril:account', (e) => { signedIn = !!(e as CustomEvent<{ profile: unknown }>).detail.profile; });

  // What the run did, for the hint on a run that missed par.
  const trail: Trail = { lastSale: null, lastGrow: null, error: null };
  let seenTick = -1, seenCoins = 0;
  const clearTrail = (): void => { trail.lastSale = null; trail.lastGrow = null; trail.error = null; seenTick = -1; seenCoins = 0; };
  window.addEventListener('tendril:snapshot', (e) => {
    const s = (e as CustomEvent<Snapshot>).detail;
    if (s.tick < seenTick) clearTrail();
    if (s.coins > seenCoins && !briefRun) trail.lastGrow = s.tick;
    seenTick = s.tick; seenCoins = s.coins;
    if (s.tick < c.ticks && layer) closeScreen(true); // a new run began elsewhere (menu, reset)
  });
  // Briefs: the goal's own score drives the hint (coins alone say nothing for a festival).
  const briefRun = c.setupVersion === 2;
  let seenGoal = 0;
  window.addEventListener('tendril:goal', (e) => {
    const g = (e as CustomEvent<GoalProgress>).detail;
    if (g.score < seenGoal) seenGoal = 0;
    if (g.score > seenGoal && briefRun) trail.lastGrow = seenTick;
    seenGoal = g.score;
  });
  window.addEventListener('tendril:events', (e) => {
    for (const ev of (e as CustomEvent<ViewEvent[]>).detail) if (ev[0] === EVENT.sale && (trail.lastSale === null || ev[1] > trail.lastSale)) trail.lastSale = ev[1];
  });
  window.addEventListener('tendril:errors', (e) => {
    const first = (e as CustomEvent<SimError[]>).detail[0];
    if (first) trail.error = { bot: first.bot, line: first.line, message: first.message };
  });

  let layer: HTMLElement | null = null;
  let card: HTMLElement | null = null;
  let reopen: HTMLButtonElement | null = null;
  let skip: (() => void) | null = null; // set while the ending animation plays
  let cancelTimers: (() => void) | null = null;
  let savedPreset: LightPreset | null = null;
  let run = 0; // bumped on every new ending and every close, so late answers are ignored

  function closeScreen(restore: boolean): void {
    run++;
    cancelTimers?.(); cancelTimers = null; skip = null;
    layer?.remove(); layer = null; card = null;
    reopen?.remove(); reopen = null;
    if (restore && savedPreset) view.setLight(savedPreset);
    if (restore) savedPreset = null;
  }

  window.addEventListener('tendril:scenario-end', (e) => { void ending((e as CustomEvent<{ snapshot: Snapshot }>).detail.snapshot); });

  window.addEventListener('keydown', (e) => {
    if (!layer || e.ctrlKey || e.metaKey || e.altKey || e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
    if (skip) {
      e.preventDefault(); e.stopPropagation(); skip();
      // Escape on the card while the medals still count up finishes them and closes the card, as it does once they are done.
      if (!(e.key === 'Escape' && card)) return;
    }
    if (!card || layer.hidden) return;
    const onControl = e.target instanceof HTMLElement && !!e.target.closest('button, a, input, select, textarea, summary');
    if (e.key === 'Enter' && !onControl) { e.preventDefault(); e.stopPropagation(); retry(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dismiss(); }
  }, true);

  function retry(): void {
    closeScreen(true);
    void loop.reset().then(() => document.getElementById('tp-play')?.focus());
  }
  function dismiss(): void {
    if (!layer) return;
    cancelTimers?.(); cancelTimers = null; skip = null;
    layer.hidden = true;
    if (!reopen) {
      reopen = el('button', { class: 'hk-button rs-reopen', type: 'button', text: 'Show result' });
      reopen.addEventListener('click', () => { if (layer) { layer.hidden = false; reopen?.remove(); reopen = null; card?.querySelector<HTMLElement>('.rs-try')?.focus(); } });
      document.body.append(reopen);
    }
    reopen.focus();
  }

  /** Slow orbit, then resolves. Skipping resolves at once. */
  function orbit(): Promise<void> {
    if (reduced()) return Promise.resolve();
    return new Promise((resolve) => {
      const start = performance.now();
      let last = 0, raf = 0, done = false;
      const finish = (): void => { if (done) return; done = true; cancelAnimationFrame(raf); resolve(); };
      const frame = (now: number): void => {
        if (done) return;
        const k = Math.min(1, (now - start) / ORBIT_MS);
        const turned = ease(k) * Math.PI * 2; // a whole turn, easing in and out, so the camera ends where it began
        view.orbitBy(turned - last); last = turned;
        if (k >= 1) finish(); else raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
      skip = () => { view.orbitBy(Math.PI * 2 - last); last = Math.PI * 2; finish(); };
      const prev = cancelTimers;
      cancelTimers = () => { prev?.(); finish(); };
    });
  }

  async function ending(snapshot: Snapshot): Promise<void> {
    closeScreen(false);
    const mine = ++run;
    const actions = loop.logChunks().flatMap((k) => k.actions).filter((a) => a[0] < c.ticks);
    const local = localResult(c, actions);
    const kind = local.goal?.kind;
    const netWorth = local.goal ? local.score : local.netWorth ?? snapshot.netWorth; // "score" below: net worth on a classic day, the goal's score on a brief
    const practice = !!c.practice;
    const edited = !practice && loop.editedMidRun; // the code changed while the day was running
    const missed = belowPar(c, local.parTick);

    layer = el('div', { class: 'rs-layer', 'data-phase': 'dusk' });
    document.body.append(layer);
    savedPreset ??= view.lightPreset;
    view.setLight('night');
    await orbit();
    if (mine !== run || !layer) return;
    skip = null;

    let server: EntryResult | null = null;
    let program: ProgramStatus | null = null;
    let submitting = signedIn && !practice;
    let note = practice ? 'Practice farm: nothing was submitted. Only the real day counts, and its hidden farms stay hidden.' : signedIn ? 'Sending your run to the server…' : 'Saved on this device. Sign in to submit this run and see your rank.';
    const bestKey = practice ? `${c.id}.practice` : c.id; // practice scores never mix with the real day's
    const prevBest = readBest(bestKey);
    writeBest(bestKey, Math.max(netWorth, prevBest ?? 0));

    const title = el('h2', { id: 'rs-title', text: missed ? 'The day is over' : 'Sunset' });
    const coinsNum = el('b', { class: 'rs-coins-num', text: '0' });
    const unit = el('small', { text: ` ${scoreParts(kind ?? 'wealth', 0).unit}` });
    const coinsLine = el('p', { class: 'rs-coins' }, coinsNum, unit);
    const finalBox = el('div', { class: 'rs-final', 'aria-live': 'polite' });
    const medalList = el('ol', { class: 'rs-medals', 'aria-label': 'Medals' });
    const rankLine = el('p', { class: 'rs-rank', 'aria-live': 'polite' });
    const ratingLine = el('p', { class: 'rs-muted rs-rating' });
    const bestEl = el('p', { class: 'rs-best', text: bestLine(prevBest, netWorth, practice ? null : c.best, kind) });
    const hint = missed ? el('p', { class: 'rs-hint', role: 'note' }, el('b', { text: 'One thing to look at. ' }), hintFor(trail, c.ticks, netWorth, c.par, kind)) : null;
    const noteEl = el('p', { class: 'rs-muted rs-note', 'aria-live': 'polite' });
    const editedEl = edited ? el('p', { class: 'rs-hint rs-edited', role: 'note' }, el('b', { text: 'You changed your code during this run. ' }), 'The score counts, but no single program played it from the start, so it cannot earn Brevity or a rating. Re-run your final code from the start to get a rated score.') : null;
    const rerunBtn = edited ? el('button', { class: 'hk-button hk-primary rs-rerun', type: 'button', text: 'Re-run my final code from the start' }) : null;
    rerunBtn?.addEventListener('click', () => { closeScreen(true); void loop.reset().then(() => { loop.run(); document.getElementById('tp-play')?.focus(); }); });

    const shareBtn = el('button', { class: 'hk-button rs-share', type: 'button', text: 'Share' });
    const replay = el('a', { class: 'hk-button rs-replay', target: '_blank', rel: 'noopener', text: 'Watch replay' });
    const tryBtn = el('button', { class: 'hk-button hk-primary rs-try', type: 'button', 'aria-keyshortcuts': 'Enter' }, practice ? 'Same farm again ' : 'Try again ', el('kbd', { text: 'Enter' }));
    const anotherBtn = el('button', { class: 'hk-button rs-another', type: 'button', text: practice ? 'Another farm' : 'Try another farm', title: "This brief on a random farm. Never submitted." });
    anotherBtn.addEventListener('click', () => anotherFarm(c));
    const nextBtn = el('button', { class: 'hk-button rs-next', type: 'button', text: 'Next' });
    const signInBtn = el('button', { class: 'hk-button rs-signin', type: 'button', text: 'Sign in to submit' });
    signInBtn.addEventListener('click', () => startSignIn());
    const duel = createDuelPanel(api, c, () => actions);
    const duelBox = el('details', { class: 'rs-duel' }, el('summary', { text: 'Challenge a friend' }), duel.el);
    const more = kind ? [anotherBtn] : [];
    const buttons = el('div', { class: 'rs-buttons' }, ...(rerunBtn ? [rerunBtn] : []), ...(practice ? [tryBtn, ...more, nextBtn] : missed ? [tryBtn, ...more, shareBtn, replay, nextBtn] : [shareBtn, replay, tryBtn, ...more, nextBtn]));

    const paint = (): void => {
      const s = server;
      const parTick = s ? s.parTick : local.parTick;
      const shown = kind ? (s?.score ?? netWorth) : s?.netWorth ?? netWorth;
      const views = medals({ par: c.par, netWorth: shown, parTick, ticks: c.ticks, signedIn, server: s, program, submitting, kind, practice });
      medalList.querySelectorAll('li').forEach((li, idx) => {
        const m = views[idx]!;
        li.dataset.state = m.state;
        const nm = li.querySelector('.rs-medal-body b'); if (nm) nm.textContent = m.name;
        const st = li.querySelector('.rs-stamp'); if (st) st.textContent = m.name[0]!;
        li.querySelector('.rs-medal-line')!.textContent = m.line;
        li.querySelector('.rs-medal-rank')!.textContent = m.rank ?? '';
        li.setAttribute('aria-label', `${m.name} medal: ${m.state === 'earned' ? 'earned' : m.state === 'missed' ? 'not earned' : m.state}. ${m.line}${m.rank ? `. Rank ${m.rank}` : ''}`);
      });
      rankLine.textContent = s?.percentile != null ? `Rank ${rankText(s.ranks.wealth, s.total) ?? '—'} · top ${topShare(s.percentile)}%` : submitting ? 'Waiting for the server…' : '';
      const rated = practice ? null : kind ? briefRateLine(signedIn, parTick) : rateLine(c, signedIn, parTick);
      ratingLine.textContent = rated ?? '';
      const fin = kind && !practice ? finalView({ kind, hiddenFarms: c.hiddenFarms ?? 0, closesAt: c.closesAt, now: Date.now(), entry: s, visible: netWorth }) : null;
      finalBox.hidden = !fin || fin.state === 'none';
      finalBox.dataset.state = fin?.state ?? 'none';
      finalBox.replaceChildren(...(fin ? fin.lines.map((t, n) => el(n === 0 ? 'b' : 'span', { text: t })) : []));
      noteEl.textContent = note;
      signInBtn.hidden = signedIn || practice;
      shareBtn.hidden = practice;
      const text = shareText({ number: c.kind === 'season' ? null : c.number !== null && c.number > 0 ? c.number : null, label: c.kind === 'season' && c.number !== null && c.number > 0 ? `Season #${c.number}` : c.id, netWorth: s?.netWorth ?? netWorth, parTick, par: c.par, percentile: s?.percentile ?? null, mosaic: s?.mosaic ?? local.mosaic, entryId: s?.entryId ?? null, tokens: s?.tokens ?? null });
      shareBtn.onclick = async () => { const ok = await copyText(text); toast(ok ? 'Result copied' : 'Could not copy', ok ? 'Paste it anywhere.' : text); };
      if (s?.entryId) { replay.href = `replay.html?e=${encodeURIComponent(s.entryId)}`; replay.hidden = false; } else replay.hidden = true;
      duel.update({ signedIn, netWorth: s?.netWorth ?? netWorth, entry: s });
      duelBox.hidden = practice || !!kind; // a duel copies a farm's brief; challenging from a brief result waits for the server side (see brain/notes/K6.md)
    };
    for (const name of ['Wealth', 'Speed', 'Brevity']) {
      medalList.append(el('li', { class: 'rs-medal', 'data-state': 'pending' },
        el('span', { class: 'rs-stamp', 'aria-hidden': 'true', text: name[0]! }), el('span', { class: 'rs-medal-body' }, el('b', { text: name }), el('small', { class: 'rs-medal-line' })), el('span', { class: 'rs-medal-rank' })));
    }
    paint();

    card = el('section', { class: 'hk-card rs-card', 'data-missed': String(missed), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'rs-title' },
      title, coinsLine, finalBox, ...(editedEl ? [editedEl] : []), ...(hint ? [hint] : []), medalList, rankLine, bestEl, ratingLine, buttons, signInBtn, noteEl, duelBox);
    card.addEventListener('keydown', (e) => { if (e.key === 'Tab') trapTab(e, card!); });
    layer.append(card);
    layer.dataset.phase = 'card';
    requestAnimationFrame(() => card?.classList.add('rise'));
    replay.hidden = true;

    tryBtn.addEventListener('click', retry);
    nextBtn.addEventListener('click', () => { dismiss(); document.getElementById('btn-menu')?.click(); });
    tryBtn.focus();

    // Coins count up, medals are stamped one by one. Reduced motion shows the final numbers at once.
    const stamps = [...medalList.children] as HTMLElement[];
    const instant = reduced();
    const setCoins = (n: number): void => { coinsNum.textContent = kind ? scoreParts(kind, Math.round(n)).num : fmt(Math.round(n)); };
    if (instant) { setCoins(netWorth); stamps.forEach((s) => s.classList.add('stamped')); } else {
      setCoins(0);
      const t0 = performance.now();
      let raf = 0;
      const timers: number[] = [];
      const finishNow = (): void => { setCoins(netWorth); stamps.forEach((s) => s.classList.add('stamped')); };
      const tick = (now: number): void => {
        const k = Math.min(1, (now - t0) / COUNT_MS);
        setCoins(netWorth * (1 - (1 - k) ** 3));
        if (k < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      stamps.forEach((s, idx) => timers.push(window.setTimeout(() => s.classList.add('stamped'), COUNT_MS * 0.6 + idx * STAMP_MS)));
      const stop = (): void => { cancelAnimationFrame(raf); timers.forEach(clearTimeout); };
      skip = () => { stop(); finishNow(); skip = null; };
      cancelTimers = stop;
      timers.push(window.setTimeout(() => { if (mine === run) skip = null; }, COUNT_MS * 0.6 + stamps.length * STAMP_MS + 200));
    }

    if (!signedIn || practice) return;
    try {
      const entry = await submitRun(api, c, actions, loop.sourceProvider?.() ?? null);
      if (mine !== run) return;
      server = entry; program = entry.program; submitting = false;
      note = entry.improved ? 'Verified by the server.' : 'Verified. Your earlier run is still your best.';
      if (entry.program === 'verified') note += ` Your program is ${fmt(entry.tokens ?? 0)} tokens.`;
      else if (entry.program === 'mismatch') note += edited ? ' Your program does not match this run, so it has no Brevity entry.' : ' Your program does not match this run (edited mid-run?), so it has no Brevity entry.';
      else if (entry.program === 'unavailable') note += ' The program check is busy; your score counted without Brevity.';
    } catch (e) {
      if (mine !== run) return;
      submitting = false;
      if (e instanceof ApiError && e.status === 401) { signedIn = false; note = 'Sign in to submit this run and see your rank.'; }
      else if (e instanceof ApiError && e.status === 409) note = e.message;
      else note = e instanceof Error ? e.message : 'Could not submit. Your run is saved on this device.';
    }
    paint();
    if (server) void showRating(mine, ratingLine);
  }

  /** Brief days: what the standings will use. Visible-farm par is only a first look; the final par is judged over all farms. */
function briefRateLine(signedIn: boolean, parTick: number | null): string | null {
  if (!signedIn) return null;
  return parTick !== null ? 'On course to be rated: you reached par on this farm. Rated entries need a verified program, and the hidden farms count at close.' : 'Par was not reached on this farm. Only the sum over all farms counts at close, so a program that does well everywhere can still be rated.';
}

/** The player's latest closed rating, when the rating module has one: a line under the medals. */
  async function showRating(mine: number, line: HTMLElement): Promise<void> {
    try {
      const { latest } = await api.ratingLatest();
      const o = latest?.overall;
      if (mine !== run || !o) return;
      line.textContent = `Rating ${fmt(o.rating)}${o.provisional ? '?' : ''} ${o.tier.name} · ${signed(o.delta)} at the last close. Today's run counts when the day closes.`;
    } catch { /* no rating yet, or offline: the line stays as it was */ }
  }
}

function trapTab(e: KeyboardEvent, root: HTMLElement): void {
  const items = [...root.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], summary, input')].filter((n) => !n.hidden && n.offsetParent !== null);
  if (!items.length) return;
  const first = items[0]!, last = items[items.length - 1]!;
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
