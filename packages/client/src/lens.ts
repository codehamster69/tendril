import type { FarmView } from './farm-view';
import { el } from './palette';

/** Keys 1 to 4 pick a lens. The same key again goes back to natural. */
const LENSES = [
  { key: '1', id: 'nitrogen', name: 'Soil', lo: 'poor', hi: 'rich', grad: '#e0c898, #468653' },
  { key: '2', id: 'moisture', name: 'Water', lo: 'dry', hi: 'wet', grad: '#e0bb79, #287caf' },
  { key: '3', id: 'growth', name: 'Growth', lo: 'bare', hi: 'ripe', grad: '#9aa98c, #f2b84b' },
  { key: '4', id: 'price', name: 'Value', lo: 'cheap', hi: 'dear', grad: '#3b6fa8, #cfe0c8, #ff8a2e' },
] as const;

const typing = (t: EventTarget | null): boolean => {
  const e = t as HTMLElement | null;
  return !!e && (e.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName) || !!e.closest?.('.cm-editor, .monaco-editor, dialog, .hk-overlay'));
};

/** One lens at a time, a tiny legend, and number keys. The soil-lens select in the farm bar stays in step. */
export function mountLens(view: FarmView, stage: HTMLElement): void {
  const legend = el('div', { id: 'lens-legend', class: 'hk-chip lens-legend', role: 'status', hidden: '' });
  const name = el('small');
  const lo = el('span', { class: 'lens-end' }), hi = el('span', { class: 'lens-end' });
  const bar = el('i', { class: 'lens-bar', 'aria-hidden': 'true' });
  legend.append(name, lo, bar, hi);
  stage.append(legend);
  const select = document.getElementById('soil-overlay') as HTMLSelectElement | null;

  const show = (): void => {
    const cur = select?.value ?? 'none';
    const l = LENSES.find((x) => x.id === cur);
    legend.hidden = !l;
    if (!l) return;
    name.textContent = `${l.key} ${l.name}`;
    lo.textContent = l.lo; hi.textContent = l.hi;
    bar.style.background = `linear-gradient(90deg, ${l.grad})`;
  };
  const set = (id: string): void => {
    if (!select) { view.setLens(id as never); return; }
    if (id === 'price' && !view.priceAvailable()) return;
    select.value = id;
    select.dispatchEvent(new Event('change'));
    show();
  };
  select?.addEventListener('change', show);
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat || typing(e.target)) return;
    const l = LENSES.find((x) => x.key === e.key);
    if (!l) return;
    e.preventDefault();
    set(select?.value === l.id ? 'none' : l.id);
  });
  show();
}
