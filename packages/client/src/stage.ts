import './hud-kit.css';
import './stage.css';
import type { Editor } from './editor';
import { catchUpText, type GameLoop, type LoopStatus } from './game-loop';
import type { Snapshot } from './sim-types';
import { el } from './palette';
import { mountMenu } from './menu';
import type { ModeKey } from './menu';
import type { FarmApi } from './api-client';

const SLATE_W = 'tendril.slate.width', SLATE_HIDDEN = 'tendril.slate.hidden', STRIP_OPEN = 'tendril.slate.console';
const MIN_W = 320, DEFAULT_W = 440;
/** The slate sits 12px from the right edge and its resize grip reaches 7px further left; the free area ends this far from the right edge. */
const SLATE_INSET_PAD = 24;
const get = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const put = (k: string, v: string): void => { try { localStorage.setItem(k, v); } catch { /* storage blocked: choice just does not persist */ } };
const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const listen = <T>(name: string, cb: (detail: T) => void): void => window.addEventListener(`tendril:${name}`, (e) => cb((e as CustomEvent).detail));
const typing = (t: EventTarget | null): boolean => {
  const e = t as HTMLElement | null;
  return !!e && (e.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON|SUMMARY|A)$/.test(e.tagName) || !!e.closest?.('.monaco-editor, .cm-editor, dialog, .hk-overlay'));
};

/** Moves existing nodes into a modal while it is open and puts them back (same place) when it closes. Nothing is rebuilt. */
class Panels {
  private overlay: HTMLElement;
  private body: HTMLElement;
  private title: HTMLElement;
  private restore: (() => void) | null = null;
  private opener: HTMLElement | null = null;
  constructor(private onClose: () => void) {
    this.title = el('h2', { id: 'panel-title' });
    const close = el('button', { class: 'hk-button', type: 'button', text: 'Close' });
    close.addEventListener('click', () => this.close());
    this.body = el('div', { class: 'panel-body' });
    this.overlay = el('div', { class: 'hk-overlay panel-overlay', id: 'panel-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'panel-title', hidden: '' },
      el('div', { class: 'hk-card panel-card' }, el('header', {}, this.title, close), this.body));
    this.overlay.addEventListener('mousedown', (e) => { if (e.target === this.overlay) this.close(); });
    this.overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.close(); } });
    document.body.append(this.overlay);
  }
  get isOpen(): boolean { return !this.overlay.hidden; }
  open(title: string, nodes: HTMLElement[], opts: { onOpen?: () => void; onClose?: () => void; wide?: boolean } = {}): void {
    this.close();
    this.opener = document.activeElement as HTMLElement | null;
    this.title.textContent = title;
    this.overlay.classList.toggle('wide', !!opts.wide);
    const homes = nodes.map((n) => ({ n, hidden: n.hidden, parent: n.parentNode!, mark: n.parentNode!.insertBefore(document.createComment('panel'), n) }));
    for (const h of homes) { h.n.hidden = false; this.body.append(h.n); h.n.classList.add('in-panel'); }
    this.restore = () => {
      for (const h of homes) { h.n.classList.remove('in-panel'); h.n.hidden = h.hidden; h.parent.insertBefore(h.n, h.mark); h.mark.remove(); }
      opts.onClose?.();
    };
    this.overlay.hidden = false;
    opts.onOpen?.();
    (this.overlay.querySelector('button, [href], input, select') as HTMLElement | null)?.focus();
  }
  close(): void {
    if (this.overlay.hidden) return;
    this.restore?.(); this.restore = null;
    this.overlay.hidden = true;
    this.onClose();
    this.opener?.focus?.();
  }
}

/** The full-screen game layout: stage behind everything, code slate, transport bar, HUD chips and a menu overlay. */
export function mountStage({ loop, api, current, ranked }: { loop: GameLoop; editor?: Editor; api: FarmApi; current: ModeKey; ranked: boolean }): void {
  const root = document.documentElement;
  const live = loop.mode === 'live';
  document.body.classList.add('game-stage');

  // ---- code slate ----
  const side = byId('side');
  const clampW = (w: number): number => Math.round(Math.min(Math.max(w, MIN_W), Math.max(MIN_W, Math.min(760, window.innerWidth - 360))));
  /** Tells the farm view how many px on the right the slate covers (its margin included, 0 when hidden); the camera frames the rest. */
  const announceInset = (): void => {
    const open = !document.body.classList.contains('slate-hidden');
    const w = parseFloat(getComputedStyle(root).getPropertyValue('--slate-w')) || DEFAULT_W;
    window.dispatchEvent(new CustomEvent('tendril:slate-inset', { detail: open ? w + SLATE_INSET_PAD : 0 }));
  };
  const setW = (w: number, save = false): void => { root.style.setProperty('--slate-w', `${clampW(w)}px`); if (save) put(SLATE_W, String(clampW(w))); announceInset(); };
  setW(Number(get(SLATE_W)) || DEFAULT_W);
  const grip = el('div', { class: 'slate-grip', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize the code slate', tabindex: '0' });
  side.prepend(grip);
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault(); grip.setPointerCapture(e.pointerId); document.body.classList.add('resizing');
    const move = (ev: PointerEvent): void => setW(window.innerWidth - ev.clientX - 12);
    const up = (): void => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up); document.body.classList.remove('resizing'); setW(parseFloat(getComputedStyle(root).getPropertyValue('--slate-w')), true); };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
  });
  grip.addEventListener('keydown', (e) => {
    const cur = parseFloat(getComputedStyle(root).getPropertyValue('--slate-w')) || DEFAULT_W;
    if (e.key === 'ArrowLeft') { e.preventDefault(); setW(cur + 24, true); } else if (e.key === 'ArrowRight') { e.preventDefault(); setW(cur - 24, true); }
  });
  window.addEventListener('resize', () => setW(parseFloat(getComputedStyle(root).getPropertyValue('--slate-w')) || DEFAULT_W));

  const slateBtn = el('button', { id: 'btn-slate', class: 'hk-button', type: 'button', 'aria-controls': 'side', title: 'Hide or show the code slate (Ctrl/Cmd+E)' });
  const setSlate = (open: boolean, focus = false): void => {
    document.body.classList.toggle('slate-hidden', !open);
    side.toggleAttribute('inert', !open);
    slateBtn.textContent = open ? 'Hide code' : 'Show code';
    slateBtn.setAttribute('aria-expanded', String(open));
    put(SLATE_HIDDEN, open ? '0' : '1');
    if (open && focus) document.querySelector<HTMLElement>('#editor textarea')?.focus();
    announceInset();
  };
  const slateOpen = (): boolean => !document.body.classList.contains('slate-hidden');
  setSlate(get(SLATE_HIDDEN) !== '1');
  slateBtn.addEventListener('click', () => setSlate(!slateOpen(), true));
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'e') { e.preventDefault(); e.stopPropagation(); setSlate(!slateOpen(), true); }
  }, true);
  // Slate heading: a hide button beside the examples picker.
  const hide = el('button', { class: 'hk-button slate-hide', type: 'button', text: 'Hide', title: 'Hide the code slate (Ctrl/Cmd+E)' });
  hide.addEventListener('click', () => setSlate(false));
  side.querySelector('.code-heading')?.append(hide);

  // ---- console strip (collapsible, bottom of the slate) ----
  const tabs = side.querySelector<HTMLElement>('.dock-tabs')!;
  const strip = el('button', { id: 'console-strip', class: 'strip-toggle', type: 'button', 'aria-controls': 'console', text: 'Output' });
  const setStrip = (open: boolean): void => {
    side.classList.toggle('strip-closed', !open);
    strip.setAttribute('aria-expanded', String(open));
    strip.dataset.open = String(open);
    put(STRIP_OPEN, open ? '1' : '0');
  };
  setStrip(get(STRIP_OPEN) !== '0');
  strip.addEventListener('click', () => setStrip(side.classList.contains('strip-closed')));
  tabs.prepend(strip);
  listen('debug', (d: { paused: unknown }) => { if (d.paused) { setSlate(true); setStrip(true); } });

  // ---- HUD: coins + stock top-left, menu top-right ----
  // The ledger strip: mark, then one cell per readout (label over value), then the slate and menu buttons at the right.
  const coins = el('b', { id: 'chip-coins', text: '0' }), stock = el('b', { id: 'chip-stock', text: '0' });
  const mark = el('a', { class: 'ledger-mark', href: '../', title: 'Tendril home', 'data-site-link': '' });
  mark.innerHTML = '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 29c0-9 0-15 0-18"/><path d="M16 15c-6 0-10-4-10-10 6 0 10 4 10 10Z"/><path d="M16 12c0-5 3-8 9-8 0 5-3 8-9 8Z"/></svg><span>Tendril</span>';
  const cells = el('div', { id: 'ledger-cells', class: 'ledger-cells', role: 'group', 'aria-label': 'Farm readouts' },
    el('span', { class: 'hk-chip', title: 'Coins' }, el('small', { text: 'Coins' }), coins),
    el('span', { class: 'hk-chip', title: 'Items in the barn' }, el('small', { text: 'Stock' }), stock));
  const menuBtn = el('button', { id: 'btn-menu', class: 'hk-button', type: 'button', 'aria-haspopup': 'dialog', 'aria-label': 'Menu', title: 'Menu', text: 'Menu' });
  const hudTr = el('div', { id: 'game-hud-tr', class: 'hud-tr' }, menuBtn);
  const slateToggle = el('div', { id: 'slate-toggle', class: 'slate-toggle' }, slateBtn);
  const hud = el('div', { id: 'game-hud', class: 'hud-tl', role: 'banner' }, mark, cells, el('div', { class: 'ledger-actions' }, slateToggle, hudTr));
  listen<Snapshot>('snapshot', (s) => {
    coins.textContent = s.coins.toLocaleString();
    stock.textContent = (s.stock ?? []).reduce((a, b) => a + b, 0).toLocaleString();
  });

  // ---- catch-up card: shown only while a long absence is being replayed ----
  const cuTitle = el('b', { text: 'Catching up' }), cuMeta = el('small', { text: '' });
  const cuBar = el('i', { class: 'cu-fill' });
  const catchCard = el('div', { id: 'catchup-card', class: 'catchup-card hk-chip', role: 'status', hidden: '' }, cuTitle, el('span', { class: 'cu-track' }, cuBar), cuMeta);
  listen<LoopStatus>('status', (s) => {
    const c = s.catchUp;
    catchCard.hidden = !c;
    if (!c) return;
    const hours = c.startBehind / 36_000;
    cuTitle.textContent = `Catching up ${hours >= 1 ? `${hours.toFixed(hours < 10 ? 1 : 0)} hours` : `${Math.max(1, Math.round(c.startBehind / 600))} min`} of farm time`;
    cuBar.style.width = `${Math.min(99, Math.max(0, (1 - c.behind / c.startBehind) * 100)).toFixed(1)}%`;
    cuMeta.textContent = `${catchUpText(c)} · ${c.ticksPerSecond.toLocaleString()} ticks/s · your farm is safe, saved as it goes`;
  });
  document.body.append(catchCard);

  // ---- transport bar ----
  const play = el('button', { id: 'tp-play', class: 'hk-button hk-primary tp-play', type: 'button', 'aria-label': 'Run', title: 'Run or pause (Space)', text: '▶', disabled: '' });
  const step = el('button', { id: 'tp-step', class: 'hk-button', type: 'button', text: 'Step', title: 'Step one line (F10)', disabled: '' });
  const speeds = [1, 4, 16].map((n) => el('button', { class: 'hk-button tp-speed', type: 'button', 'data-speed': String(n), 'aria-pressed': n === 1 ? 'true' : 'false', text: `${n}x` }));
  const sunset = el('button', { id: 'tp-sunset', class: 'hk-button tp-sunset', type: 'button', text: 'Run to sunset', title: 'Play out the rest of the day at once', disabled: '' });
  const transport = el('div', { id: 'transport', class: 'transport hk-chip', role: 'toolbar', 'aria-label': 'Farm controls' }, play, step, ...(live ? [] : [...speeds, sunset]));
  const hasEnd = (): boolean => loop.sim.scenario.tickLimit !== undefined;
  let running = false, canRun = false, canPause = false;
  play.addEventListener('click', () => { if (running) byId('btn-pause').click(); else byId('btn-run').click(); });
  step.addEventListener('click', () => byId('btn-step-line').click());
  sunset.addEventListener('click', () => { void loop.runToEnd(); });
  for (const b of speeds) b.addEventListener('click', () => {
    const select = byId<HTMLSelectElement>('speed');
    select.value = b.dataset.speed!;
    select.dispatchEvent(new Event('change'));
    for (const o of speeds) o.setAttribute('aria-pressed', String(o === b));
  });
  listen<LoopStatus>('status', (s) => {
    running = s.running; canRun = s.canRun; canPause = s.canPause;
    play.textContent = running ? '❚❚' : '▶';
    play.setAttribute('aria-label', running ? 'Pause' : 'Run');
    // A live farm's clock keeps running while paused, and Run catches up: say so, so Pause never reads as a freeze.
    if (live) play.title = running ? 'Pause · the farm clock keeps counting. Run to catch up.' : 'Run or pause (Space)';
    play.disabled = running ? !canPause : !canRun;
    step.disabled = !s.canStep;
    sunset.disabled = !s.canStep || !hasEnd();
  });
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
    e.preventDefault();
    if (!play.disabled) play.click();
  });
  step.hidden = live;

  // ---- menu + panels ----
  const panels = new Panels(() => {});
  // The menu itself lives in menu.ts; the stage only hands it the pieces it needs.
  mountMenu({ loop, api, current, ranked, button: menuBtn, panels, openDebugger: () => { setSlate(true); setStrip(true); document.querySelector<HTMLButtonElement>('[data-dock="debugger"]')?.click(); } });

  document.body.append(hud, transport);
  // The caption's tile readout and the farm bar stay on the stage; chips sit above them.
}
