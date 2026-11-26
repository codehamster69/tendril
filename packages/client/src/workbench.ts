// The docking workbench: every game panel is a tab in a tiled layout you can rearrange (dockview), or, on a phone, a bottom tab row under the farm.
// The panels' contents are the nodes the other modules already built and keep updating; the workbench only decides where they sit.
import 'dockview-core/dist/styles/dockview.css';
import { createDockview, type DockviewApi, type IContentRenderer, type IDockviewPanel, type GroupPanelPartInitParameters, type ITabRenderer, type TabPartInitParameters } from 'dockview-core';
import './workbench.css';
import { el } from './palette';
import {
  DEFAULT_PRESET, LAYOUT_KEY, PANELS, PHONE_SPLIT_KEY, PHONE_TABS, PHONE_TAB_KEY, PRESETS, clampSplit, decodeLayout, encodeLayout, firstPanel, isPanelId, isPhone,
  sizesOf, stepsOf, titleOf, type Node, type PanelId, type PresetId,
} from './workbench-layout';

const get = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const put = (k: string, v: string): void => { try { localStorage.setItem(k, v); } catch { /* storage blocked: the choice just does not persist */ } };
const del = (k: string): void => { try { localStorage.removeItem(k); } catch { /* ignore */ } };
const pinned = (id: PanelId): boolean => !!PANELS.find((p) => p.id === id)?.pinned;

/** Panels stack next to the first open panel of their own kind; otherwise they get a home below a fixed anchor. */
const COMPANIONS: Partial<Record<PanelId, PanelId[]>> = {
  console: ['debugger'], debugger: ['console'], settings: ['code'],
  orders: ['reference', 'bots', 'inspector', 'market', 'map'], reference: ['orders', 'bots', 'inspector', 'market', 'map'], bots: ['orders', 'inspector', 'reference', 'market', 'map'],
  inspector: ['bots', 'orders', 'reference', 'market', 'map'], market: ['orders', 'bots', 'inspector', 'reference', 'map'], map: ['market', 'orders', 'bots', 'inspector', 'reference'],
};
const ANCHOR: Partial<Record<PanelId, { ref: PanelId; dir: 'below' | 'right' }>> = { console: { ref: 'farm', dir: 'below' }, debugger: { ref: 'farm', dir: 'below' } };

export interface Workbench {
  /** Opens the panel if it is closed and brings it to the front. */
  open(id: PanelId, focus?: boolean): void;
  isOpen(id: PanelId): boolean;
  preset(id: PresetId): void;
  reset(): void;
  /** True on a phone-sized window: no docking, one panel under the farm. */
  readonly phone: boolean;
  /** Where the Layout and Panels buttons go. */
  mountMenus(into: HTMLElement): void;
}

export interface WorkbenchOptions { content: (id: PanelId) => HTMLElement }

/**
 * A panel's body. The content node is shown in it while the tab is in front; otherwise (hidden tab, closed panel) it goes back to
 * the parking element, so it stays in the document and `getElementById` keeps finding it.
 */
class Body implements IContentRenderer {
  readonly element = el('div', { class: 'wb-body' });
  constructor(private id: PanelId, private node: HTMLElement, private park: HTMLElement, private visible: (id: PanelId, shown: boolean) => void, register: (id: PanelId, body: HTMLElement) => void) {
    this.element.dataset.panel = id;
    this.element.tabIndex = -1;
    register(id, this.element);
  }
  init(p: GroupPanelPartInitParameters): void {
    p.api.onDidVisibilityChange((e) => this.sync(e.isVisible));
    this.sync(p.api.isVisible);
  }
  private sync(shown: boolean): void {
    if (shown) this.element.append(this.node); else if (this.node.parentElement === this.element) this.park.append(this.node);
    this.visible(this.id, shown);
  }
  dispose(): void { if (this.node.parentElement === this.element) this.park.append(this.node); }
}

class Tab implements ITabRenderer {
  readonly element = el('div', { class: 'wb-tab' });
  init(p: TabPartInitParameters): void {
    const id = p.api.id as PanelId;
    this.element.dataset.panel = id;
    this.element.append(el('span', { class: 'wb-tab-title', text: p.title ?? titleOf(id) }));
    if (!pinned(id)) {
      const close = el('button', { class: 'wb-tab-close', type: 'button', 'aria-label': `Close ${titleOf(id)}`, title: 'Close (Ctrl+W)', text: '×' });
      close.addEventListener('pointerdown', (e) => e.stopPropagation());
      close.addEventListener('click', (e) => { e.stopPropagation(); p.api.close(); });
      this.element.append(close);
    }
    this.element.addEventListener('dblclick', (e) => { if ((e.target as HTMLElement).closest('.wb-tab-close')) return; if (p.api.isMaximized()) p.api.exitMaximized(); else p.api.maximize(); });
    this.element.addEventListener('auxclick', (e) => { if (e.button === 1 && !pinned(id)) { e.preventDefault(); p.api.close(); } });
  }
}

export function mountWorkbench({ content }: WorkbenchOptions): Workbench {
  const body = document.body;
  const root = el('div', { id: 'dock-root', class: 'dockview-theme-tendril' });
  body.append(root);

  const bodies = new Map<PanelId, HTMLElement>();
  const register = (id: PanelId, host: HTMLElement): void => { bodies.set(id, host); };
  // Every panel's content lives here until a panel shows it, so nothing ever leaves the document.
  const park = el('div', { id: 'wb-park', hidden: '', 'aria-hidden': 'true' });
  body.append(park);
  for (const p of PANELS) park.append(content(p.id));
  let building = false;
  let phoneMode = isPhone(window.innerWidth);
  const menus: { button: HTMLButtonElement; menu: HTMLElement; fill: () => void }[] = []; // declared early: layout events can fire as soon as the dock exists

  const farmVisible = (v: boolean): void => { window.dispatchEvent(new CustomEvent('tendril:farm-visible', { detail: v })); };
  const panelOf = (id: PanelId): IDockviewPanel | undefined => api.getPanel(id);
  const openIds = (): PanelId[] => api.panels.map((p) => p.id as PanelId);

  // ---------------------------------------------------------------- dockview
  const api: DockviewApi = createDockview(root, {
    theme: { name: 'tendril', className: 'dockview-theme-tendril' },
    defaultTabComponent: 'tab',
    disableFloatingGroups: true,
    createComponent: (o) => new Body(o.name as PanelId, content(o.name as PanelId), park, (id, shown) => { if (id === 'farm') farmVisible(shown); }, register),
    createTabComponent: () => new Tab(),
  });

  const addPanel = (id: PanelId, position?: { referencePanel: string; direction: 'right' | 'below' | 'within' }): IDockviewPanel =>
    api.addPanel({ id, component: id, tabComponent: 'tab', title: titleOf(id), ...(position ? { position } : {}) } as Parameters<DockviewApi['addPanel']>[0]);

  const layoutSize = (): { width: number; height: number } => ({ width: root.clientWidth || window.innerWidth, height: root.clientHeight || window.innerHeight });

  const build = (tree: Node): void => {
    building = true;
    try {
      api.clear();
      bodies.clear();
      for (const s of stepsOf(tree)) addPanel(s.id, s.ref ? { referencePanel: s.ref, direction: s.dir } : undefined);
      const { width, height } = layoutSize();
      api.layout(width, height);
      for (const s of sizesOf(tree, width, height)) panelOf(s.id)?.group.api.setSize({ width: s.width, height: s.height });
      const active = (n: Node): void => {
        if ('tabs' in n) { if (n.active) panelOf(n.active)?.api.setActive(); return; }
        n.children.forEach(active);
      };
      active(tree);
    } finally { building = false; }
    save();
  };

  // Maximising another group hides the farm without changing its tab state, so the farm hears about that too.
  api.onDidMaximizedGroupChange(() => { const f = panelOf('farm'); if (!phoneMode && f) farmVisible(f.api.isVisible && (!api.hasMaximizedGroup() || f.group.api.isMaximized())); });
  const save = (): void => { if (!phoneMode || api.panels.length) put(LAYOUT_KEY, encodeLayout(api.toJSON(), openIds())); };
  let saveTimer = 0;
  api.onDidLayoutChange(() => { if (building) return; window.clearTimeout(saveTimer); saveTimer = window.setTimeout(save, 200); refreshMenus(); });

  const restore = (): void => {
    const saved = decodeLayout(get(LAYOUT_KEY));
    if (saved) {
      try {
        building = true; api.clear(); bodies.clear();
        api.fromJSON(saved.layout as Parameters<DockviewApi['fromJSON']>[0]);
        const ids = openIds();
        if (ids.length !== saved.panels.length || !saved.panels.every((p) => ids.includes(p)) || !ids.includes('farm') || !ids.includes('code')) throw new Error('layout does not match');
        building = false;
        return;
      } catch { building = false; del(LAYOUT_KEY); }
    }
    build(PRESETS[DEFAULT_PRESET].tree());
  };
  restore();

  // ---------------------------------------------------------------- opening, focusing, closing
  const focusContent = (id: PanelId): void => {
    const host = bodies.get(id) ?? content(id);
    const target = id === 'code' ? host.querySelector<HTMLElement>('.cm-content') : id === 'console' ? host.querySelector<HTMLElement>('#console') : id === 'reference' ? host.querySelector<HTMLElement>('input') : null;
    (target ?? host.closest<HTMLElement>('.wb-body') ?? host).focus({ preventScroll: true });
  };
  const open = (id: PanelId, focus = true): void => {
    if (phoneMode) { if (id !== 'farm') phoneTab(id); return; }
    let p = panelOf(id);
    if (!p) {
      const mate = (COMPANIONS[id] ?? []).find((c) => panelOf(c));
      const anchor = ANCHOR[id];
      p = mate ? addPanel(id, { referencePanel: mate, direction: 'within' })
        : addPanel(id, anchor && panelOf(anchor.ref) ? { referencePanel: anchor.ref, direction: anchor.dir } : panelOf('code') ? { referencePanel: 'code', direction: 'below' } : undefined);
    }
    if (api.hasMaximizedGroup() && !p.api.isMaximized()) api.exitMaximizedGroup();
    p.api.setActive();
    if (focus) focusContent(id);
    refreshMenus();
  };
  const close = (id: PanelId): void => { if (!pinned(id)) panelOf(id)?.api.close(); };

  window.addEventListener('tendril:open-panel', (e) => { const id = (e as CustomEvent<{ id: PanelId }>).detail?.id; if (isPanelId(id)) open(id); });
  window.addEventListener('tendril:debug', (e) => { if ((e as CustomEvent<{ paused: unknown }>).detail.paused) open('debugger', false); });

  // Ctrl/Alt+1..9 focus a panel; Ctrl/Alt+W closes the focused one; Ctrl/Cmd+E jumps to the code. Capture phase, so the editor cannot swallow them.
  window.addEventListener('keydown', (e) => {
    if (e.shiftKey || e.defaultPrevented) return;
    const mod = (e.ctrlKey || e.altKey) && !(e.ctrlKey && e.altKey) && !e.metaKey;
    const digit = /^[1-9]$/.test(e.key) ? Number(e.key) : /^Digit[1-9]$/.test(e.code) ? Number(e.code.slice(5)) : 0;
    if (mod && digit) {
      const info = PANELS.find((p) => p.key === digit);
      if (info) { e.preventDefault(); e.stopPropagation(); open(info.id); }
    } else if (mod && e.key.toLowerCase() === 'w' && !phoneMode) {
      const active = api.activePanel?.id as PanelId | undefined;
      if (active && !pinned(active)) { e.preventDefault(); e.stopPropagation(); close(active); }
    } else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'e') { e.preventDefault(); e.stopPropagation(); open('code'); }
  }, true);

  // ---------------------------------------------------------------- phone: farm on top, one panel below, a tab row at the bottom
  const phone = el('div', { id: 'wb-phone', hidden: '' });
  const phoneFarm = el('div', { class: 'wb-phone-farm' });
  const divider = el('div', { class: 'wb-phone-divider', role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Drag to resize the farm and the panel', tabindex: '0' });
  const phonePanel = el('div', { class: 'wb-phone-panel', role: 'tabpanel' });
  const tabRow = el('div', { class: 'wb-phone-tabs', role: 'tablist', 'aria-label': 'Panels' });
  phone.append(phoneFarm, divider, phonePanel, tabRow);
  body.append(phone);
  const tabButtons = new Map<PanelId, HTMLButtonElement>();
  for (const id of PHONE_TABS) {
    const b = el('button', { type: 'button', role: 'tab', class: 'wb-phone-tab', 'data-panel': id, 'aria-selected': 'false', text: titleOf(id) });
    b.addEventListener('click', () => phoneTab(id));
    tabButtons.set(id, b);
    tabRow.append(b);
  }
  let split = clampSplit(Number(get(PHONE_SPLIT_KEY)) || 0.4);
  const applySplit = (): void => { phone.style.setProperty('--wb-split', String(split)); };
  applySplit();
  divider.addEventListener('pointerdown', (e) => {
    e.preventDefault(); divider.setPointerCapture(e.pointerId); body.classList.add('resizing');
    const move = (ev: PointerEvent): void => { const r = phone.getBoundingClientRect(); const tabs = tabRow.getBoundingClientRect().height; split = clampSplit((ev.clientY - r.top) / Math.max(1, r.height - tabs)); applySplit(); };
    const up = (): void => { divider.removeEventListener('pointermove', move); divider.removeEventListener('pointerup', up); divider.removeEventListener('pointercancel', up); body.classList.remove('resizing'); put(PHONE_SPLIT_KEY, String(split)); };
    divider.addEventListener('pointermove', move); divider.addEventListener('pointerup', up); divider.addEventListener('pointercancel', up);
  });
  divider.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault(); split = clampSplit(split + (e.key === 'ArrowDown' ? 0.05 : -0.05)); applySplit(); put(PHONE_SPLIT_KEY, String(split));
  });
  let currentTab: PanelId = (PHONE_TABS as readonly string[]).includes(get(PHONE_TAB_KEY) ?? '') ? (get(PHONE_TAB_KEY) as PanelId) : 'code';
  function phoneTab(id: PanelId): void {
    if (!tabButtons.has(id)) return;
    currentTab = id; put(PHONE_TAB_KEY, id);
    park.append(...phonePanel.children);
    phonePanel.append(content(id));
    phonePanel.dataset.panel = id;
    for (const [k, b] of tabButtons) { b.setAttribute('aria-selected', String(k === id)); if (k === id) b.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }
  }

  const setMode = (): void => {
    const next = isPhone(window.innerWidth);
    if (next === phoneMode && phone.dataset.ready === '1') return;
    phoneMode = next;
    phone.dataset.ready = '1';
    body.classList.toggle('wb-phone-mode', phoneMode);
    phone.hidden = !phoneMode; root.hidden = phoneMode;
    if (phoneMode) {
      phoneFarm.append(content('farm'));
      phoneTab(currentTab);
      farmVisible(true);
    } else {
      for (const [id, host] of bodies) { const front = panelOf(id)?.api.isVisible; if (front) host.append(content(id)); else park.append(content(id)); }
      const f = panelOf('farm'); farmVisible(f ? f.api.isVisible : true);
      const { width, height } = layoutSize(); api.layout(width, height);
    }
    refreshMenus();
  };
  window.addEventListener('resize', setMode);
  setMode();

  // ---------------------------------------------------------------- Layout and Panels menus
  function closeMenus(): void { for (const m of menus) { m.menu.hidden = true; m.button.setAttribute('aria-expanded', 'false'); } }
  function refreshMenus(): void { for (const m of menus) if (!m.menu.hidden) m.fill(); }
  const makeMenu = (label: string, id: string, fill: (menu: HTMLElement) => void): HTMLButtonElement => {
    const button = el('button', { id: `btn-${id}`, class: 'hk-button wb-menu-button', type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-controls': `menu-${id}`, text: label });
    const menu = el('div', { id: `menu-${id}`, class: 'wb-menu', role: 'menu', hidden: '' });
    body.append(menu);
    const fillNow = (): void => { menu.replaceChildren(); fill(menu); };
    const place = (): void => { const r = button.getBoundingClientRect(); menu.style.top = `${Math.round(r.bottom + 4)}px`; menu.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`; };
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      const was = menu.hidden;
      closeMenus();
      if (was) { fillNow(); menu.hidden = false; place(); button.setAttribute('aria-expanded', 'true'); menu.querySelector<HTMLElement>('button')?.focus(); }
    });
    menu.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeMenus(); button.focus(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = [...menu.querySelectorAll<HTMLButtonElement>('button')]; const i = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
      }
    }, true);
    menus.push({ button, menu, fill: fillNow });
    return button;
  };
  document.addEventListener('pointerdown', (e) => { if (!(e.target as HTMLElement).closest('.wb-menu, .wb-menu-button')) closeMenus(); });
  window.addEventListener('resize', closeMenus);

  const item = (menu: HTMLElement, label: string, run: () => void, opts: { on?: boolean; hint?: string; danger?: boolean } = {}): void => {
    const b = el('button', { type: 'button', role: opts.on === undefined ? 'menuitem' : 'menuitemcheckbox', class: `wb-menu-item${opts.danger ? ' danger' : ''}`, ...(opts.on === undefined ? {} : { 'aria-checked': String(opts.on) }) }, el('span', { text: label }), ...(opts.hint ? [el('kbd', { text: opts.hint })] : []));
    b.addEventListener('click', () => { closeMenus(); run(); });
    menu.append(b);
  };
  const layoutButton = makeMenu('Layout', 'layout', (menu) => {
    menu.append(el('p', { class: 'wb-menu-label', text: 'Presets' }));
    for (const [k, p] of Object.entries(PRESETS)) item(menu, p.label, () => applyPreset(k as PresetId));
    menu.append(el('p', { class: 'wb-menu-label', text: 'Your layout saves itself' }));
    item(menu, 'Reset layout', reset, { danger: true });
  });
  const panelsButton = makeMenu('Panels', 'panels', (menu) => {
    menu.append(el('p', { class: 'wb-menu-label', text: 'Show or hide' }));
    for (const p of PANELS) {
      const isOpen = phoneMode ? true : !!panelOf(p.id);
      item(menu, p.title, () => { if (phoneMode) open(p.id); else if (isOpen && !p.pinned) close(p.id); else open(p.id); }, { on: isOpen, hint: p.key ? `Ctrl+${p.key}` : undefined });
    }
  });
  // Phone: no docking, so the layout menu is of no use there.
  const sync = (): void => { layoutButton.hidden = phoneMode; panelsButton.hidden = phoneMode; };
  window.addEventListener('resize', sync); sync();

  function applyPreset(id: PresetId): void { if (phoneMode) return; build(PRESETS[id].tree()); refreshMenus(); }
  function reset(): void { del(LAYOUT_KEY); applyPreset(DEFAULT_PRESET); }

  return {
    open, isOpen: (id) => (phoneMode ? true : !!panelOf(id)), preset: applyPreset, reset,
    get phone() { return phoneMode; },
    mountMenus(into) { into.append(layoutButton, panelsButton); },
  };
}

export { firstPanel };
