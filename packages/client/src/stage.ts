import './hud-kit.css';
import './stage.css';
import type { Editor } from './editor';
import type { GameLoop, LoopStatus } from './game-loop';
import type { Snapshot } from './sim-types';
import { el } from './palette';

const SLATE_W = 'tendril.slate.width', SLATE_HIDDEN = 'tendril.slate.hidden', STRIP_OPEN = 'tendril.slate.console';
const MIN_W = 320, DEFAULT_W = 440;
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
export function mountStage({ loop }: { loop: GameLoop; editor?: Editor }): void {
  const root = document.documentElement;
  const live = loop.mode === 'live';
  document.body.classList.add('game-stage');

  // ---- code slate ----
  const side = byId('side');
  const clampW = (w: number): number => Math.round(Math.min(Math.max(w, MIN_W), Math.max(MIN_W, Math.min(760, window.innerWidth - 360))));
  const setW = (w: number, save = false): void => { root.style.setProperty('--slate-w', `${clampW(w)}px`); if (save) put(SLATE_W, String(clampW(w))); };
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
  const coins = el('b', { id: 'chip-coins', text: '0' }), stock = el('b', { id: 'chip-stock', text: '0' });
  const hud = el('div', { id: 'game-hud', class: 'hud-tl' },
    el('span', { class: 'hk-chip', title: 'Coins' }, el('small', { text: 'Coins' }), coins),
    el('span', { class: 'hk-chip', title: 'Items in the barn' }, el('small', { text: 'Stock' }), stock));
  const menuBtn = el('button', { id: 'btn-menu', class: 'hk-icon-button', type: 'button', 'aria-haspopup': 'dialog', 'aria-label': 'Menu', title: 'Menu', text: '☰' });
  const hudTr = el('div', { id: 'game-hud-tr', class: 'hud-tr' }, menuBtn);
  listen<Snapshot>('snapshot', (s) => {
    coins.textContent = s.coins.toLocaleString();
    stock.textContent = (s.stock ?? []).reduce((a, b) => a + b, 0).toLocaleString();
  });

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
  const menu = el('div', { id: 'menu-overlay', class: 'hk-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Menu', hidden: '' });
  const entries = el('div', { class: 'menu-entries' });
  const modes = byId('mode-tabs'), links = document.querySelector<HTMLElement>('.top-actions')!;
  const closeMenu = (): void => { menu.hidden = true; menuBtn.focus(); };
  const openMenu = (): void => { menu.hidden = false; (menu.querySelector('button, a') as HTMLElement | null)?.focus(); };
  const entry = (label: string, hint: string, run: () => void, id: string): HTMLButtonElement => {
    const b = el('button', { class: 'hk-button menu-entry', type: 'button', 'data-entry': id }, el('b', { text: label }), el('small', { text: hint }));
    b.addEventListener('click', () => { menu.hidden = true; run(); });
    entries.append(b);
    return b;
  };
  const q = <T extends HTMLElement>(s: string): T | null => document.querySelector<T>(s);
  const decks = (...ids: string[]): HTMLElement[] => ids.map((i) => document.getElementById(i)).filter((n): n is HTMLElement => !!n);
  entry('Inspectors', 'Soil, barn, orders, forecast', () => panels.open('Inspectors', decks('forecast', 'deck-farm')), 'inspectors');
  entry('Seed catalogue', 'Research crops, buildings, tools', () => window.dispatchEvent(new CustomEvent('tendril:open-catalogue')), 'catalogue');
  entry('Achievements', 'Goals you have earned', () => panels.open('Achievements', decks('deck-goals')), 'progression');
  entry('Arena & lessons', 'Daily result, submit, lessons', () => panels.open('Arena & lessons', decks('lesson-card'), { wide: true }), 'arena');
  entry('Duels', 'Join a friend’s duel link', () => byId('btn-join-duel').click(), 'duels');
  const ratingEntry = entry('Rating', 'Your overall rating', () => { byId('rating-chip').click(); }, 'rating');
  const accountEntry = entry('Account', 'Sign in or out', () => byId('btn-account').click(), 'account');
  entry('Reference', 'Every Sprout command', () => { q('#btn-reference')?.click(); }, 'reference');
  entry('Debugger', 'Variables and breakpoints', () => { setSlate(true); setStrip(true); q<HTMLButtonElement>('[data-dock="debugger"]')?.click(); }, 'debugger');
  const marketEntry = entry('Market', 'Shared market prices', () => {
    const m = q('.farm-market');
    if (m && !m.hidden) panels.open('Market', [m], { onOpen: () => m.classList.remove('collapsed'), onClose: () => m.classList.add('collapsed') });
  }, 'market');
  entry('Minimap', 'Jump around the farm', () => { const m = q('#farm-minimap'); if (m) panels.open('Minimap', [m], { onOpen: () => m.classList.remove('collapsed') }); }, 'minimap');
  const syncEntries = (): void => {
    ratingEntry.disabled = !document.getElementById('rating-chip');
    marketEntry.disabled = !q('.farm-market') || !!q('.farm-market')?.hidden;
    const label = byId('btn-account').textContent?.trim();
    accountEntry.querySelector('small')!.textContent = label && label !== 'Sign in' ? `Signed in as ${label}` : 'Sign in or out';
  };
  menuBtn.addEventListener('click', () => { syncEntries(); openMenu(); });
  const closeBtn = el('button', { class: 'hk-button', type: 'button', text: 'Close' });
  closeBtn.addEventListener('click', closeMenu);
  menu.append(el('div', { class: 'hk-card menu-card' },
    el('header', {}, el('h2', { text: 'Menu' }), closeBtn), el('p', { class: 'menu-label', text: 'Mode' }), modes, entries, el('div', { class: 'menu-links' }, links)));
  menu.addEventListener('mousedown', (e) => { if (e.target === menu) closeMenu(); });
  menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } });
  // Arena results arrive on their own: show them without the player hunting through the menu.
  const result = document.getElementById('arena-result');
  if (result) new MutationObserver(() => { if (!result.hidden && !panels.isOpen) panels.open('Arena & lessons', decks('lesson-card'), { wide: true }); }).observe(result, { attributes: true, attributeFilter: ['hidden'] });

  document.body.append(hud, hudTr, transport, el('div', { id: 'slate-toggle', class: 'slate-toggle' }, slateBtn), menu);
  // The caption's tile readout and the farm bar stay on the stage; chips sit above them.
}
