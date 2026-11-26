import type { Editor } from './editor';
import { boot } from './boot';
import { LESSONS } from './lessons';
import { el } from './palette';
import { EVENT } from './sim-protocol';
import type { ViewEvent } from './sim-protocol';
import { kvGetMany } from './store';

const FLAG = 'tendril.firstrun.v1'; // absent | 'active' | 'done'
const read = (key: string): string | null => { try { return localStorage.getItem(key); } catch { return 'unavailable'; } };
const write = (key: string, value: string): void => { try { localStorage.setItem(key, value); } catch { /* storage full or blocked: the prompts just show again */ } };

/** True for a brand-new local live farm: no saved program, no saved farm, never dismissed. `?coach=0` opts out. */
export async function isFirstRun(mode: string, ranked: boolean, params: URLSearchParams, farmKey: string): Promise<boolean> {
  if (mode !== 'live' || ranked || params.get('coach') === '0') return false;
  const flag = read(FLAG);
  if (flag === 'done' || flag === 'unavailable') return false;
  if (flag === 'active') return true;
  if (read('tendril.sprout.v1.live') !== null) return false;
  try { return (await kvGetMany<Record<string, unknown>>([farmKey + 'world']))[farmKey + 'world'] === undefined; } catch { return false; }
}

interface Prompt { anchor: string; title: string; text: string; action?: { label: string; run: () => void } }

/**
 * Three prompts anchored to the real controls, ending on the first sale: write or accept a program, press Play,
 * watch the first harvest and the sale. Skippable, and never shown again once finished or skipped.
 * It never touches ranked or campaign state; the starter is campaign lesson 1's own solution.
 */
export function mountFirstRun({ editor }: { editor: Editor }): void {
  write(FLAG, 'active');
  // Lesson 1's solution ends on harvest; the tour ends on a sale, so the starter walks the carrots to the barn and sells them.
  const starter = LESSONS[0]!.solution + 'go_to barn\ndeposit\nsell carrot, all\n';
  // A new live farm is already running; pressing Play then would pause it, so only press it when the farm is paused.
  const running = (): boolean => document.getElementById('btn-run')?.hasAttribute('disabled') === true && document.getElementById('btn-pause')?.hasAttribute('disabled') === false;
  let index = 0;
  let finished = false;
  const title = el('b', { class: 'fr-title' });
  const text = el('p', { class: 'fr-text' });
  const step = el('small', { class: 'fr-step' });
  const action = el('button', { class: 'hk-button hk-primary', type: 'button' });
  const skip = el('button', { class: 'hk-button', type: 'button', text: 'Skip tour' });
  const packets = el('button', { class: 'hk-button', type: 'button', text: 'Start from a popular packet' });
  packets.addEventListener('click', () => window.dispatchEvent(new Event('tendril:open-packets')));
  const card = el('div', { class: 'hk-card fr-card', role: 'dialog', 'aria-label': 'First run tour', 'aria-live': 'polite' }, step, title, text, el('div', { class: 'fr-actions' }, action, packets, skip));
  card.hidden = true;
  document.body.append(card);

  const prompts: Prompt[] = [
    { anchor: '#side', title: 'Give your bot a program', text: 'Type some Sprout in the editor, or start from a ready one that plants, harvests and sells a carrot.', action: { label: 'Use the starter', run: () => editor.setSource(starter) } },
    { anchor: '#tp-play', title: 'Press Play', text: 'Your bot follows the program line by line, and the day starts.', action: { label: 'Play', run: () => { if (!running()) document.getElementById('tp-play')?.click(); } } },
    { anchor: '#farm-canvas', title: 'Watch the first harvest', text: 'Your bot tills, plants and waits for the carrot to ripen. This takes a few seconds.' },
    { anchor: '#farm-canvas', title: 'Now it sells', text: 'The bot carries the carrots to the barn. Your first sale ends the tour.' },
  ];
  // The arrow line: one SVG over the page, from the card to the panel it describes. Redrawn whenever the card is placed.
  const NS = 'http://www.w3.org/2000/svg';
  const sv = document.createElementNS(NS, 'svg');
  sv.id = 'fr-line'; sv.setAttribute('aria-hidden', 'true'); sv.setAttribute('hidden', '');
  const ln = document.createElementNS(NS, 'line'), ring = document.createElementNS(NS, 'circle'), tip = document.createElementNS(NS, 'circle');
  ring.setAttribute('r', '9'); tip.setAttribute('r', '3'); tip.setAttribute('class', 'fr-tip');
  sv.append(ln, ring, tip);
  document.body.append(sv);
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, hi));
  const place = (): void => {
    const p = prompts[index];
    const target = p && document.querySelector<HTMLElement>(p.anchor);
    if (!p || !target || card.hidden) return;
    const r = target.getBoundingClientRect();
    const w = Math.min(320, window.innerWidth - 24);
    card.style.width = `${w}px`;
    const h = card.offsetHeight;
    const slate = document.getElementById('side')?.getBoundingClientRect();
    const freeRight = slate && slate.width > 0 && slate.left < window.innerWidth ? slate.left : window.innerWidth;
    const onFarm = p.anchor === '#farm-canvas';
    // The farm is the whole window, so its "panel" is the free area left of the code slate: the card sits above its middle and the line drops to it.
    const fx = freeRight / 2, fy = (window.innerHeight + 44) / 2;
    const side = p.anchor === '#side';
    const left = side ? r.left - w - 20 : onFarm ? fx - w / 2 : r.left + r.width / 2 - w / 2;
    const top = side ? r.top + 150 : p.anchor === '#tp-play' ? r.top - h - 36 : onFarm ? fy - h - 70 : r.top + 110;
    const cl = Math.max(12, Math.min(left, window.innerWidth - w - 12)), ct = Math.max(52, Math.min(top, window.innerHeight - h - 40));
    card.style.left = `${cl}px`;
    card.style.top = `${ct}px`;
    // Line from the nearest point on the card's edge to the nearest point on the target (or its middle, for the farm).
    const cx = cl + w / 2, cy = ct + h / 2;
    const ex = onFarm ? fx : clamp(cx, r.left, r.right), ey = onFarm ? fy : clamp(cy, r.top, r.bottom);
    const sx = clamp(ex, cl, cl + w), sy = clamp(ey, ct, ct + h);
    const gap = Math.hypot(ex - sx, ey - sy);
    sv.toggleAttribute('hidden', gap < 4);
    ln.setAttribute('x1', String(sx)); ln.setAttribute('y1', String(sy));
    ln.setAttribute('x2', String(ex)); ln.setAttribute('y2', String(ey));
    ring.setAttribute('cx', String(ex)); ring.setAttribute('cy', String(ey));
    tip.setAttribute('cx', String(ex)); tip.setAttribute('cy', String(ey));
    ring.style.display = onFarm ? '' : 'none';
    tip.style.display = onFarm ? 'none' : '';
  };
  const show = (i: number): void => {
    index = i;
    const p = prompts[i]!;
    step.textContent = `Step ${Math.min(i + 1, 3)} of 3`;
    title.textContent = p.title;
    text.textContent = p.text;
    action.hidden = !p.action;
    packets.hidden = i !== 0;
    if (p.action) action.textContent = p.action.label;
    card.hidden = false;
    place();
    if (i === 1 && running()) { window.setTimeout(() => advance(1), 0); return; } // already playing: nothing to press
    document.querySelector<HTMLElement>(p.anchor)?.classList.add('fr-spot');
    for (const other of prompts) if (other !== p) document.querySelector<HTMLElement>(other.anchor)?.classList.remove('fr-spot');
  };
  const end = (): void => {
    if (finished) return;
    finished = true;
    write(FLAG, 'done');
    window.removeEventListener('tendril:events', onEvents);
    window.removeEventListener('resize', place);
    for (const p of prompts) document.querySelector<HTMLElement>(p.anchor)?.classList.remove('fr-spot');
    card.remove();
    sv.remove();
  };
  const advance = (from: number): void => { if (!finished && index === from) { if (from >= prompts.length - 1) end(); else show(from + 1); } };
  const onEvents = (event: Event): void => {
    const events = (event as CustomEvent<ViewEvent[]>).detail;
    if (index === 2 && events.some((e) => e[0] === EVENT.harvest)) advance(2);
    else if (index === 3 && events.some((e) => e[0] === EVENT.sale)) advance(3);
  };
  action.addEventListener('click', () => { const p = prompts[index]!; p.action?.run(); if (index === 0 && editor.getSource().trim()) advance(0); });
  skip.addEventListener('click', () => { if (!editor.getSource().trim()) editor.setSource(starter); end(); });
  card.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); skip.click(); } });
  editor.onChange(() => { if (index === 0 && editor.getSource().trim().length > 12) show(1); });
  // Delegated: the transport bar is mounted after this module runs.
  document.addEventListener('click', (e) => { if (index === 1 && (e.target as Element).closest('#tp-play, #btn-run')) window.setTimeout(() => advance(1), 0); });
  window.addEventListener('tendril:events', onEvents);
  window.addEventListener('resize', place);
  void boot.whenReady().then(() => { if (!finished) show(0); });
}
