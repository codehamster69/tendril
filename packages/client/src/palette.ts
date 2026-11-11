import { BUILDINGS, ITEMS } from '@tendril/sim/src/index.ts';

export const ITEM_COLORS = ['#000', '#E8873A', '#D9B85C', '#7FBF6A', '#D9732F', '#B0457A', '#C8423B', '#E5B33A', '#7A5A3A'];
export const itemName = (i: number): string => ITEMS[i]?.name ?? '?';
export const buildingName = (k: number): string => BUILDINGS[k]?.name ?? '';
export const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else e.setAttribute(k, v);
  }
  e.append(...kids);
  return e;
}

export function toast(title: string, body: string): void {
  const host = document.getElementById('toast-host');
  if (!host) return;
  const t = el('div', { class: 'toast', role: 'status' }, el('b', { text: title }), body);
  host.append(t);
  setTimeout(() => t.remove(), 5200);
}
