// "Things to try": a small, dismissable list in the menu that points at parts of the game the player has not used yet.
// To advertise a new feature, add one line to TRY_IT. Only list things that exist: a link must never go nowhere.
import { el } from './palette';
import type { ModeKey } from './menu';

interface Idea { id: string; title: string; text: string; href?: string; entry?: string; mode?: ModeKey }

export const TRY_IT: Idea[] = [
  { id: 'daily', title: "Beat today's par", text: 'The same farm for everyone, ranked.', href: '?mode=daily', mode: 'daily' },
  { id: 'duels', title: 'Race a friend', text: 'Share a duel link and play the same farm.', entry: 'duels' },
  { id: 'live', title: 'Grow an Endless farm', text: 'Your own farm that keeps growing.', href: '?mode=live', mode: 'live' },
  { id: 'campaign', title: 'Learn with lessons', text: 'Short goals that teach Sprout.', href: '?mode=campaign', mode: 'campaign' },
  { id: 'catalogue', title: 'Open the seed catalogue', text: 'See every crop and building you can unlock.', entry: 'catalogue' },
  { id: 'reference', title: 'Search the reference', text: 'Every Sprout command with an example.', entry: 'reference' },
  { id: 'sandbox', title: 'Experiment in the sandbox', text: 'Nothing is ranked, so try anything.', href: '?mode=sandbox', mode: 'sandbox' },
];

const KEY = 'tendril.tryit.v1';
interface Saved { hidden: boolean; done: string[] }
const read = (): Saved => { try { const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Saved>; return { hidden: !!v.hidden, done: Array.isArray(v.done) ? v.done : [] }; } catch { return { hidden: false, done: [] }; } };
const write = (s: Saved): void => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* blocked storage: the list just comes back next time */ } };

/** Builds the list node. Playing a mode counts as having tried it; pressing an idea does too. */
export function mountTryIt({ current }: { current: ModeKey | 'campaign' }): { node: HTMLElement } {
  const saved = read();
  const idea = TRY_IT.find((i) => i.mode === current);
  if (idea && !saved.done.includes(idea.id)) { saved.done.push(idea.id); write(saved); }
  const node = el('section', { class: 'try-it', 'aria-label': 'Things to try' });
  const render = (): void => {
    const left = TRY_IT.filter((i) => !saved.done.includes(i.id)).slice(0, 3);
    node.hidden = saved.hidden || left.length === 0;
    const hide = el('button', { class: 'hk-button try-hide', type: 'button', text: 'Hide', title: 'Hide this list' });
    hide.addEventListener('click', () => { saved.hidden = true; write(saved); render(); });
    node.replaceChildren(
      el('div', { class: 'try-head' }, el('p', { class: 'menu-label', text: 'Things to try' }), hide),
      el('div', { class: 'menu-entries' }, ...left.map((i) => {
        const body = [el('b', { text: i.title }), el('small', { text: i.text })];
        const mark = (): void => { if (!saved.done.includes(i.id)) { saved.done.push(i.id); write(saved); } };
        if (i.href) { const a = el('a', { class: 'hk-button menu-entry', href: i.href }, ...body); a.addEventListener('click', mark); return a; }
        const b = el('button', { class: 'hk-button menu-entry', type: 'button' }, ...body);
        b.addEventListener('click', () => { mark(); document.querySelector<HTMLElement>(`#menu-overlay [data-entry="${i.entry}"]`)?.click(); render(); });
        return b;
      })));
  };
  render();
  return { node };
}
