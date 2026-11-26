// Workbench layout: the panel table, the four presets as plain trees, and the saved-layout rules. No DOM and no dockview here, so it is unit tested.

export type PanelId = 'farm' | 'code' | 'console' | 'debugger' | 'reference' | 'orders' | 'inspector' | 'bots' | 'market' | 'map' | 'settings';

export interface PanelInfo { id: PanelId; title: string; /** Ctrl+<n> focuses it. */ key?: number; /** The farm and the code cannot be closed: the game is not playable without them. */ pinned?: boolean }

export const PANELS: readonly PanelInfo[] = [
  { id: 'farm', title: 'Farm', key: 1, pinned: true },
  { id: 'code', title: 'Code', key: 2, pinned: true },
  { id: 'console', title: 'Console', key: 3 },
  { id: 'debugger', title: 'Debugger', key: 4 },
  { id: 'orders', title: 'Orders', key: 5 },
  { id: 'reference', title: 'Reference', key: 6 },
  { id: 'bots', title: 'Bots', key: 7 },
  { id: 'inspector', title: 'Inspector', key: 8 },
  { id: 'market', title: 'Market', key: 9 },
  { id: 'map', title: 'Map' },
  { id: 'settings', title: 'Settings' },
];
export const PANEL_IDS: readonly PanelId[] = PANELS.map((p) => p.id);
export const isPanelId = (v: unknown): v is PanelId => typeof v === 'string' && (PANEL_IDS as readonly string[]).includes(v);
export const titleOf = (id: PanelId): string => PANELS.find((p) => p.id === id)!.title;

/** A tab group, or a row/column of nodes. `sizes` are relative weights. */
export type Node = { tabs: PanelId[]; active?: PanelId } | { split: 'row' | 'col'; children: Node[]; sizes: number[] };

const G = (tabs: PanelId[], active?: PanelId): Node => ({ tabs, active });
const S = (split: 'row' | 'col', children: Node[], sizes: number[]): Node => ({ split, children, sizes });

export type PresetId = 'farm' | 'code' | 'debug' | 'wide';
export const PRESETS: Record<PresetId, { label: string; tree: () => Node }> = {
  farm: { label: 'Farm first', tree: () => S('row', [S('col', [G(['farm']), G(['console', 'debugger'], 'console')], [3, 1.2]), S('col', [G(['code', 'settings'], 'code'), G(['orders', 'reference', 'bots', 'inspector', 'market', 'map'], 'orders')], [3, 1.3])], [1.25, 1]) },
  code: { label: 'Code first', tree: () => S('row', [G(['code', 'settings'], 'code'), S('col', [G(['farm']), G(['console', 'orders', 'reference', 'debugger'], 'console')], [1.1, 1])], [1.5, 1]) },
  debug: { label: 'Debugging', tree: () => S('row', [S('col', [G(['code']), G(['console'])], [2.4, 1]), S('col', [G(['farm']), G(['debugger', 'inspector'], 'debugger'), G(['bots'])], [1.3, 1.3, 0.7])], [1.3, 1]) },
  wide: { label: 'Wide screen', tree: () => S('row', [G(['reference', 'orders'], 'orders'), G(['farm']), S('col', [G(['code']), G(['console', 'debugger'], 'console')], [2.2, 1])], [0.7, 1.4, 1.2]) },
};
export const DEFAULT_PRESET: PresetId = 'farm';

export const leaves = (n: Node): PanelId[] => ('tabs' in n ? n.tabs : n.children.flatMap(leaves));
export const firstPanel = (n: Node): PanelId => leaves(n)[0]!;

/** One dockview `addPanel` call: `ref` null means the first panel; `within` stacks as a tab, the rest split the reference's group. */
export interface Step { id: PanelId; ref: PanelId | null; dir: 'right' | 'below' | 'within' }

/**
 * Turns a tree into placement steps. Every child's first panel is placed first (so the row/column splits happen at the
 * right level), then each child is filled in. Panels in one tab group are added `within` the group's first panel.
 */
export function stepsOf(root: Node): Step[] {
  const steps: Step[] = [];
  const fill = (n: Node, head: PanelId): void => {
    if ('tabs' in n) { for (const t of n.tabs) if (t !== head) steps.push({ id: t, ref: head, dir: 'within' }); return; }
    const heads = n.children.map(firstPanel);
    for (let i = 1; i < n.children.length; i++) steps.push({ id: heads[i]!, ref: heads[i - 1]!, dir: n.split === 'row' ? 'right' : 'below' });
    n.children.forEach((c, i) => fill(c, heads[i]!));
  };
  const head = firstPanel(root);
  steps.push({ id: head, ref: null, dir: 'right' });
  fill(root, head);
  return steps;
}

/** Target sizes in px for the first panel of each child, so the weights in `sizes` hold: [panel, width|height]. */
export function sizesOf(root: Node, width: number, height: number): { id: PanelId; width?: number; height?: number }[] {
  const out: { id: PanelId; width?: number; height?: number }[] = [];
  const walk = (n: Node, w: number, h: number): void => {
    if ('tabs' in n) return;
    const sum = n.sizes.reduce((a, b) => a + b, 0) || 1;
    n.children.forEach((c, i) => {
      const share = n.sizes[i]! / sum;
      const cw = n.split === 'row' ? Math.round(w * share) : w, ch = n.split === 'col' ? Math.round(h * share) : h;
      out.push(n.split === 'row' ? { id: firstPanel(c), width: cw } : { id: firstPanel(c), height: ch });
      walk(c, cw, ch);
    });
  };
  walk(root, width, height);
  return out;
}

// ---- saved layout ----
export const LAYOUT_KEY = 'tendril.workbench.layout';
export const LAYOUT_VERSION = 1;
export interface Saved { v: typeof LAYOUT_VERSION; layout: unknown; panels: PanelId[] }

/** What goes into storage: the dockview layout plus the list of open panels (used to validate it on the way back). */
export const encodeLayout = (layout: unknown, panels: PanelId[]): string => JSON.stringify({ v: LAYOUT_VERSION, layout, panels } satisfies Saved);

/** Reads a saved layout; anything unexpected (wrong version, unknown panel, farm or code missing, bad JSON) gives null, meaning "use the default". */
export function decodeLayout(raw: string | null): Saved | null {
  if (!raw) return null;
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return null; }
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.v !== LAYOUT_VERSION || typeof d.layout !== 'object' || d.layout === null || !Array.isArray(d.panels)) return null;
  const panels = d.panels as unknown[];
  if (!panels.every(isPanelId) || new Set(panels).size !== panels.length) return null;
  if (!panels.includes('farm') || !panels.includes('code')) return null;
  return { v: LAYOUT_VERSION, layout: d.layout, panels: panels as PanelId[] };
}

// ---- phone mode ----
export const PHONE_MAX = 759; // below 760px wide there is no docking
export const isPhone = (width: number): boolean => width <= PHONE_MAX;
/** The tabs shown on the phone's bottom row, in order. The farm is always the top half, so it is not a tab. */
export const PHONE_TABS: readonly PanelId[] = ['code', 'console', 'orders', 'bots', 'inspector', 'market', 'map', 'debugger', 'reference', 'settings'];
export const PHONE_TAB_KEY = 'tendril.workbench.phone-tab';
export const PHONE_SPLIT_KEY = 'tendril.workbench.phone-split';
export const clampSplit = (fraction: number): number => Math.round(Math.min(0.7, Math.max(0.2, Number.isFinite(fraction) ? fraction : 0.4)) * 1000) / 1000;
