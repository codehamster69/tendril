// The game menu: a full-screen layer over the blurred island, opened by the menu button or Esc.
import './menu.css';
import type { FarmApi } from './api-client';
import { isDesktop } from './api-client';
import type { GameLoop } from './game-loop';
import { utcToday } from './arena';
import { el } from './palette';
import { buildSettingsPanel } from './settings-panel';

export type ModeKey = 'live' | 'sandbox' | 'campaign' | 'daily' | 'season';
export interface PanelHost { open(title: string, nodes: HTMLElement[], opts?: { onOpen?: () => void; onClose?: () => void; wide?: boolean }): void; readonly isOpen: boolean }
export interface MenuContext {
  loop: GameLoop; api: FarmApi; current: ModeKey; ranked: boolean; button: HTMLElement; panels: PanelHost;
  /** Opens the code slate on the debugger tab. */
  openDebugger(): void;
}
export interface MenuApi {
  open(): void; close(): void; toggle(): void; readonly isOpen: boolean;
  /** Later tasks (seed catalogue, profile) turn a placeholder entry on by giving it an action. */
  setEntryAction(id: string, run: (() => void) | null, hint?: string): void;
}

const MODES: { id: ModeKey; label: string; href: string; hint: string }[] = [
  { id: 'daily', label: 'Daily', href: '?mode=daily', hint: "Today's farm, same seed for everyone" },
  { id: 'season', label: 'Season', href: '?mode=challenge&id=week', hint: 'The weekly season' },
  { id: 'live', label: 'Endless', href: '?mode=live', hint: 'Your farm, always growing' },
  { id: 'sandbox', label: 'Sandbox', href: '?mode=sandbox', hint: 'Experiment freely' },
];

const byId = (id: string): HTMLElement | null => document.getElementById(id);
const q = <T extends HTMLElement>(s: string): T | null => document.querySelector<T>(s);
const decks = (...ids: string[]): HTMLElement[] => ids.map(byId).filter((n): n is HTMLElement => !!n);

/** Esc belongs to whatever is on top: dialogs, panels, autocomplete. The menu only takes it when nothing else wants it. */
const somethingElseOpen = (): boolean =>
  !!document.querySelector('dialog[open], .hk-overlay:not([hidden]):not(#menu-overlay):not(#start-card), .cm-tooltip-autocomplete');

export function mountMenu(ctx: MenuContext): MenuApi {
  const { loop, api, current, button, panels } = ctx;
  const overlay = el('div', { id: 'menu-overlay', class: 'hk-overlay menu-screen', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Menu', hidden: '' });
  const entryEls = new Map<string, HTMLButtonElement | HTMLAnchorElement>();
  const actions = new Map<string, (() => void) | null>();
  const status = new Map<string, HTMLElement>();

  const note = (id: string, small: string): void => { const s = status.get(id); if (s) s.textContent = small; };
  const card = (id: string, label: string, hint: string, tag: 'button' | 'a' = 'button', extra: Record<string, string> = {}): HTMLButtonElement | HTMLAnchorElement => {
    const small = el('small', { text: hint });
    const node = el(tag, { class: 'hk-button menu-entry', 'data-entry': id, ...(tag === 'button' ? { type: 'button' } : {}), ...extra }, el('b', { text: label }), small) as HTMLButtonElement | HTMLAnchorElement;
    status.set(id, small);
    entryEls.set(id, node);
    return node;
  };
  const action = (id: string, label: string, hint: string, run: (() => void) | null): HTMLButtonElement => {
    const b = card(id, label, hint) as HTMLButtonElement;
    actions.set(id, run);
    b.disabled = !run;
    b.addEventListener('click', () => { const fn = actions.get(id); if (!fn) return; close(false); fn(); });
    return b;
  };

  // ---- main view ----
  const cont = card('continue', 'Continue', 'Back to your farm') as HTMLButtonElement;
  cont.classList.add('hk-primary', 'menu-continue');
  cont.addEventListener('click', () => close());
  const modeGrid = el('div', { class: 'menu-entries menu-modes' });
  for (const m of MODES) {
    const a = card(m.id, m.label, m.hint, 'a', { href: m.href }) as HTMLAnchorElement;
    if (m.id === current) a.setAttribute('aria-current', 'page');
    modeGrid.append(a);
  }
  modeGrid.append(card('campaign', 'Lessons', 'Learn one recipe at a time', 'a', { href: '?mode=campaign', ...(current === 'campaign' ? { 'aria-current': 'page' } : {}) }));
  modeGrid.append(action('duels', 'Duels', 'Join a friend’s duel link', () => byId('btn-join-duel')?.click()));
  modeGrid.append(action('catalogue', 'Seed catalogue', 'Research crops, buildings, tools', () => window.dispatchEvent(new CustomEvent('tendril:open-catalogue'))));
  const profileOk = (): boolean => !!byId('rating-chip');
  modeGrid.append(action('profile', 'Profile', 'Your rating and last result', () => byId('rating-chip')?.click()));
  note(current, { live: ctx.ranked ? 'Playing now · server-verified' : 'Playing now · on this device', sandbox: 'Playing now', campaign: 'Playing now', daily: 'Playing now', season: 'Playing now' }[current]);

  const toolsGrid = el('div', { class: 'menu-entries menu-tools' });
  const tool = (id: string, label: string, hint: string, run: () => void): HTMLButtonElement => { const b = action(id, label, hint, run); toolsGrid.append(b); return b; };
  tool('progression', 'Achievements', 'Goals you have earned', () => panels.open('Achievements', decks('deck-goals')));
  tool('arena', 'Arena & lessons', 'Daily result, submit, lessons', () => panels.open('Arena & lessons', decks('lesson-card'), { wide: true }));
  const marketBtn = tool('market', 'Market', 'Shared market prices', () => {
    const m = q('.farm-market');
    if (m && !m.hidden) panels.open('Market', [m], { onOpen: () => m.classList.remove('collapsed'), onClose: () => m.classList.add('collapsed') });
  });
  tool('debugger', 'Debugger', 'Variables and breakpoints', () => ctx.openDebugger());
  tool('reference', 'Reference', 'Every Sprout command', () => q('#btn-reference')?.click());
  tool('account', 'Account', 'Sign in or out', () => byId('btn-account')?.click());
  tool('settings', 'Settings', 'Sound, graphics, motion, keys', () => showSettings());
  if (isDesktop) tool('quit', 'Quit', 'Close Tendril', () => (window as unknown as { tendrilDesktop?: { quit?(): void } }).tendrilDesktop?.quit?.());

  const links = el('div', { class: 'menu-links' });
  const topActions = q('.top-actions');
  if (topActions) links.append(topActions);

  const main = el('div', { class: 'menu-view', 'data-view': 'main' },
    el('p', { class: 'menu-label', text: 'Play' }), el('div', { class: 'menu-entries' }, cont), modeGrid,
    el('p', { class: 'menu-label', text: 'Farm and tools' }), toolsGrid, links);

  // ---- settings view ----
  const settingsBack = el('button', { class: 'hk-button', type: 'button', text: '← Menu' });
  const settingsView = el('div', { class: 'menu-view', 'data-view': 'settings', hidden: '' },
    el('div', { class: 'menu-subhead' }, settingsBack, el('h3', { text: 'Settings' })),
    buildSettingsPanel(el('div', { class: 'set-account' }, el('p', { id: 'set-account-line', text: '' }), (() => { const b = el('button', { class: 'hk-button', type: 'button', text: 'Sign in or out' }); b.addEventListener('click', () => { close(false); byId('btn-account')?.click(); }); return b; })())));
  const showView = (name: 'main' | 'settings'): void => {
    main.hidden = name !== 'main'; settingsView.hidden = name !== 'settings';
    (name === 'main' ? cont : settingsBack).focus();
  };
  const showSettings = (): void => { open(); const line = byId('set-account-line'); if (line) line.textContent = accountLine(); showView('settings'); };
  settingsBack.addEventListener('click', () => showView('main'));

  const closeBtn = el('button', { class: 'hk-button', type: 'button', text: 'Close', title: 'Close (Esc)' });
  closeBtn.addEventListener('click', () => close());
  overlay.append(el('div', { class: 'hk-card menu-card' },
    el('header', {}, el('div', { class: 'menu-title' }, el('h2', { text: 'Tendril' }), el('small', { text: 'Paused while the menu is open' })), closeBtn), main, settingsView));
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.body.append(overlay);

  const accountLine = (): string => { const label = byId('btn-account')?.textContent?.trim(); return label && label !== 'Sign in' ? `Signed in as ${label}` : 'Not signed in. Local play never needs an account.'; };
  const sync = (): void => {
    marketBtn.disabled = !q('.farm-market') || !!q('.farm-market')?.hidden;
    (entryEls.get('profile') as HTMLButtonElement).disabled = !profileOk();
    note('account', accountLine().replace('Not signed in. Local play never needs an account.', 'Sign in or out'));
  };

  // ---- pause while open (local modes; an Endless farm keeps its wall clock) ----
  let pausedByMenu = false;
  const pauseSim = (): void => { if (loop.mode !== 'live' && loop.running) { pausedByMenu = true; void loop.pause(); } };
  const resumeSim = (): void => { if (pausedByMenu) { pausedByMenu = false; loop.run(); } };

  // ---- status lines (fetched once per page, only when the menu first opens) ----
  let loaded = false;
  const loadStatus = (): void => {
    if (loaded) return; loaded = true;
    const show = (id: ModeKey, key: string): void => {
      void api.challenge(key).then((c) => {
        if (id === current) return;
        const num = c.number !== null && c.number > 0 ? `#${c.number}` : 'Practice';
        note(id, `${num} · par ${c.par?.toLocaleString('en-US') ?? '—'} · ${c.players.toLocaleString('en-US')} playing`);
      }).catch(() => { if (id !== current) note(id, 'Needs a connection'); });
    };
    show('daily', `d-${utcToday()}`);
    show('season', 'week');
    if (current !== 'live') note('live', ctx.ranked ? 'Server-verified' : 'Saved on this device');
  };

  let opener: HTMLElement | null = null;
  function open(): void {
    if (!overlay.hidden) return;
    opener = document.activeElement as HTMLElement | null;
    sync(); pauseSim(); loadStatus();
    showView('main');
    overlay.hidden = false;
    document.body.classList.add('menu-open');
    button.setAttribute('aria-expanded', 'true');
    cont.focus();
  }
  function close(restore = true): void {
    if (overlay.hidden) return;
    overlay.hidden = true;
    document.body.classList.remove('menu-open');
    button.setAttribute('aria-expanded', 'false');
    resumeSim();
    if (restore) (opener?.isConnected ? opener : button).focus?.();
  }
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', () => open());

  // Esc everywhere. Capture phase, so the code editor cannot swallow it; skipped when a dialog or panel is on top.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!overlay.hidden) { e.preventDefault(); e.stopPropagation(); if (!settingsView.hidden) showView('main'); else close(); return; }
    if (somethingElseOpen() || q('#start-card:not([hidden])')) return; // the start card takes Esc itself: it closes without starting the day
    e.preventDefault(); e.stopPropagation(); open();
  }, true);

  return {
    open, close: () => close(), toggle: () => (overlay.hidden ? open() : close()), get isOpen() { return !overlay.hidden; },
    setEntryAction(id, run, hint) {
      actions.set(id, run);
      const node = entryEls.get(id) as HTMLButtonElement | undefined;
      if (node && node instanceof HTMLButtonElement) node.disabled = !run;
      if (hint) note(id, hint);
    },
  };
}
