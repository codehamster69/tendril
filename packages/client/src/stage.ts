import './hud-kit.css';
import './stage.css';
import type { Editor } from './editor';
import { catchUpText, type GameLoop, type LoopStatus } from './game-loop';
import type { Snapshot } from './sim-types';
import { el } from './palette';
import { mountMenu } from './menu';
import type { ModeKey } from './menu';
import type { FarmApi } from './api-client';
import { mountWorkbench, type Workbench } from './workbench';
import { panelContent } from './workbench-panels';

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

/** The game screen: the ledger strip on top, the docking workbench under it (farm, code, console and the rest), a transport bar on the farm and a menu overlay. */
export function mountStage({ loop, editor, api, current, ranked }: { loop: GameLoop; editor?: Editor; api: FarmApi; current: ModeKey; ranked: boolean }): Workbench {
  const live = loop.mode === 'live';
  document.body.classList.add('game-stage');

  // ---- code panel heading: the examples picker, and a slot for the editor's own buttons ----
  const side = byId('side');
  side.querySelector('.code-heading')?.append(el('span', { class: 'code-actions', id: 'code-actions' }));

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
  const wbMenus = el('div', { id: 'wb-menus', class: 'wb-menus' });
  const hud = el('div', { id: 'game-hud', class: 'hud-tl', role: 'banner' }, mark, cells, el('div', { class: 'ledger-actions' }, wbMenus, hudTr));
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
  mountMenu({ loop, api, current, ranked, button: menuBtn, panels, openPanel: (id) => workbench.open(id) });

  // The transport sits at the bottom of the farm panel, so it never covers the code.
  document.body.append(hud);
  byId('farm-stage').append(transport);
  const workbench: Workbench = mountWorkbench({ content: panelContent((code) => editor?.setSource(editor.getSource() + '\n' + code + '\n')) });
  workbench.mountMenus(wbMenus);
  return workbench;
}
