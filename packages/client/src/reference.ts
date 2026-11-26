import { API } from '@tendril/lang/src/index.ts';
import { el } from './palette';
import './reference.css';

const KIND_TITLES: Record<string, string> = {
  action: 'Actions · cost ticks', farm: 'Farm actions · instant', query: 'Questions · free',
  utility: 'Helpers · free', constant: 'Names & constants', keyword: 'Language keywords',
};

/** The Sprout reference as the body of the Reference panel. Insert puts an example at the end of the program. */
export function buildReference(insert: (code: string) => void): HTMLElement {
  const dialog = el('section', { id: 'api-reference', 'aria-labelledby': 'reference-title' });
  const search = el('input', { type: 'search', placeholder: 'Find a command, question or keyword…', 'aria-label': 'Search the Sprout reference' });
  const content = el('div', { class: 'ref-body' });
  for (const kind of Object.keys(KIND_TITLES)) {
    const entries = API.filter((e) => e.kind === kind);
    if (!entries.length) continue;
    const group = el('section', { class: 'ref-group' }, el('h3', { text: KIND_TITLES[kind]! }));
    for (const api of entries) {
      const ticks = api.ticks === 'n' ? 'n ticks' : api.ticks === 0 ? 'free' : `${api.ticks} tick${api.ticks === 1 ? '' : 's'}`;
      const pre = el('pre', { text: api.example });
      const use = el('button', { type: 'button', class: 'quiet', text: 'Insert' });
      use.addEventListener('click', () => { insert(api.example); });
      group.append(el('article', { class: 'api-entry', 'data-function': api.name },
        el('header', {}, el('code', { text: api.signature }), el('span', { class: 'api-cost', text: ticks })),
        el('p', { text: api.doc }), el('div', { class: 'ex' }, pre, use)));
    }
    content.append(group);
  }
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    const entries = [...content.querySelectorAll<HTMLElement>('.api-entry')];
    // An exact name wins ("move" must not also list "remove"); otherwise search names, signatures and docs.
    const exact = entries.filter((a) => a.dataset.function === q);
    const hits = exact.length ? exact : entries.filter((a) => a.textContent!.toLowerCase().includes(q));
    for (const a of entries) a.hidden = !hits.includes(a);
    for (const g of content.querySelectorAll<HTMLElement>('.ref-group')) g.hidden = ![...g.querySelectorAll<HTMLElement>('.api-entry')].some((a) => !a.hidden);
  });
  dialog.append(el('header', { class: 'ref-head' }, el('div', {},
    el('span', { class: 'eyebrow', text: 'Sprout reference' }), el('h2', { id: 'reference-title', text: 'Everything your bots understand' }))),
  el('p', { class: 'muted', text: 'Coordinates start at the barn (0, 0); x grows east, y grows south. Every bot runs the same program. Actions end a bot\'s turn and cost ticks; questions are free.' }),
  search, content);
  return dialog;
}
