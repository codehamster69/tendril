import type { Snapshot } from '@tendril/sim/src/index.ts';
import type { Editor } from './editor';
import { DEFAULT_SCRIPT } from './editor';
import { LESSONS } from './lessons';
import { el, toast } from './palette';
import { kvGetMany } from './store';

const FLAG = 'tendril.firstrun.v1'; // absent | 'active' | 'done'
const read = (key: string): string | null => { try { return localStorage.getItem(key); } catch { return 'unavailable'; } };
const write = (key: string, value: string): void => { try { localStorage.setItem(key, value); } catch { /* storage full or blocked: the coach just shows again */ } };

/** True for a brand-new local live farm: no saved program, no saved farm, never dismissed. `?coach=0` opts out. */
export async function isFirstRun(mode: string, ranked: boolean, params: URLSearchParams, farmKey: string): Promise<boolean> {
  if (mode !== 'live' || ranked || params.get('coach') === '0') return false;
  const flag = read(FLAG);
  if (flag === 'done' || flag === 'unavailable') return false;
  if (flag === 'active') return true;
  if (read('tendril.sprout.v1.live') !== null) return false;
  try { return (await kvGetMany<Record<string, unknown>>([farmKey + 'world']))[farmKey + 'world'] === undefined; } catch { return false; }
}

const STEPS: { text: string; code: string; test: RegExp }[] = [
  { text: 'Walk one tile.', code: 'move east', test: /^\s*move east\b/m },
  { text: 'Prepare the soil.', code: 'till', test: /^\s*till\b/m },
  { text: 'Plant a carrot.', code: 'plant carrot', test: /^\s*plant carrot\b/m },
];

/** The coach is the live-farm version of campaign lesson 1; it never touches ranked or campaign state. */
export function mountFirstRun({ editor, host }: { editor: Editor; host: HTMLElement }): void {
  write(FLAG, 'active');
  const lesson = LESSONS[0]!;
  const list = el('ol', { class: 'coach-steps' });
  const items = STEPS.map((s) => { const li = el('li', {}, el('span', { text: s.text + ' ' }), el('code', { text: s.code })); list.append(li); return li; });
  const status = el('p', { class: 'goal', text: 'Type the three lines in the editor, then press Run.' });
  const skip = el('button', { class: 'quiet', text: 'Skip the tour' });
  host.append(el('header', {}, el('span', { class: 'eyebrow', text: 'Your first program' })), el('h3', { text: 'Make your bot plant a carrot' }), el('p', { text: lesson.intro }), list, status, skip);
  host.hidden = false;
  let finished = false;
  const finish = (loadExample: boolean): void => {
    if (finished) return; finished = true; write(FLAG, 'done');
    window.removeEventListener('tendril:snapshot', onSnapshot);
    if (!loadExample) { host.hidden = true; host.replaceChildren(); return; }
    status.textContent = 'You wrote a program. Here is a bigger one to learn from.'; status.classList.add('complete');
    list.remove(); skip.remove();
    const example = el('button', { text: 'Load the starter example' }); example.addEventListener('click', () => { editor.setSource(DEFAULT_SCRIPT); host.hidden = true; });
    host.append(example, el('a', { class: 'next-lesson', href: '?mode=daily', text: "Play today's farm →" }));
    toast('First program done', "Today's farm is waiting.");
  };
  const refresh = (): void => { const src = editor.getSource(); STEPS.forEach((s, i) => items[i]!.classList.toggle('done', s.test.test(src))); };
  const onSnapshot = (event: Event): void => { if ((event as CustomEvent<Snapshot>).detail.tiles.some((t) => t.crop > 0)) finish(true); };
  editor.onChange(refresh); refresh();
  window.addEventListener('tendril:snapshot', onSnapshot);
  skip.addEventListener('click', () => { editor.setSource(DEFAULT_SCRIPT); finish(false); });
}
