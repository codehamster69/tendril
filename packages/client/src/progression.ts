import { UNLOCKS } from '@tendril/sim/src/index.ts';
import type { LogEntry, Snapshot } from '@tendril/sim/src/index.ts';
import type { Editor } from './editor';
import type { GameLoop } from './game-loop';
import type { FarmApi } from './api-client';
import type { FarmView } from './farm-view';
import { cap, el, toast } from './palette';
import { LESSONS, type Lesson } from './lessons';
import './progression.css';

export function today(): string { return new Date().toISOString().slice(0, 10); }
export function selectedLesson(): Lesson { return LESSONS.find((l) => l.id === new URLSearchParams(location.search).get('lesson')) ?? LESSONS[0]!; }
const loadSet = (key: string): Set<string> => { try { const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]'); return new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []); } catch { return new Set(); } };
const saveSet = (key: string, value: Set<string>): void => { try { localStorage.setItem(key, JSON.stringify([...value])); } catch { toast('Progress not saved', 'Browser storage is full; keep this window open.'); } };
interface Achievement { id: string; title: string; detail: string; test: (s: Snapshot, log: LogEntry[]) => boolean }
const ACHIEVEMENTS: Achievement[] = [
  { id: 'planted', title: 'A small beginning', detail: 'Plant your first crop.', test: (s) => s.tiles.some((t) => t.crop > 0) },
  { id: 'harvest', title: 'Hands full', detail: 'Carry your first harvest.', test: (s) => s.bots.some((b) => b.load > 0) },
  { id: 'deposit', title: 'Homeward bound', detail: 'Store produce in the barn.', test: (s) => s.stock.some((n) => n > 0) },
  ...[1, 100, 1000, 10_000].map((n): Achievement => ({ id: `coins-${n}`, title: n === 1 ? 'Market day' : `${n.toLocaleString()} coins`, detail: `Reach ${n.toLocaleString()} coins.`, test: (s) => s.coins >= n })),
  ...[2, 4, 8].map((n): Achievement => ({ id: `bots-${n}`, title: `${n} helping hands`, detail: `Own ${n} bots.`, test: (s) => s.bots.length >= n })),
  ...[2, 4].map((n): Achievement => ({ id: `plots-${n}`, title: `${n} plots of possibility`, detail: `Own ${n} plots.`, test: (s) => s.plots.length >= n })),
  ...UNLOCKS.slice(1).map((u, i): Achievement => ({ id: `research-${u.name}`, title: `${cap(u.name)} researcher`, detail: `Research ${u.name}.`, test: (s) => !!(s.unlocks & (1 << (i + 1))) })),
  { id: 'honey', title: 'Sweet work', detail: 'Harvest honey.', test: (s) => s.bots.some((b) => b.items[7]! > 0) || s.stock[7]! > 0 },
  { id: 'contract', title: 'A promise kept', detail: 'Deliver a market contract.', test: (s, log) => s.coins > 0 && log.some((e) => e[2] === 6) },
  { id: 'compost', title: 'Waste not', detail: 'Create compost.', test: (s) => s.bots.some((b) => b.items[8]! > 0) },
  { id: 'fertilize', title: 'Give back to the soil', detail: 'Apply compost to soil.', test: (_s, log) => log.some((e) => e[2] === 14) },
  { id: 'all-research', title: 'The whole almanac', detail: 'Research every upgrade.', test: (s) => s.unlocks === 511 },
];
export function mountProgression({ loop, editor }: { loop: GameLoop; editor: Editor; view?: FarmView; api?: FarmApi }): void {
  const goals = document.getElementById('deck-goals')!, research = document.getElementById('deck-research')!;
  const completed = loadSet('tendril.campaign.v1'), earned = loadSet('tendril.achievements.v1');
  const renderGoals = (): void => {
    goals.replaceChildren(el('div', { class: 'achievement-grid' }, ...ACHIEVEMENTS.map((a) => el('div', { class: `achievement${earned.has(a.id) ? ' earned' : ''}`, title: a.detail }, el('b', { text: a.title }), el('span', { text: earned.has(a.id) ? 'Earned' : a.detail })))));
  };
  renderGoals();
  const showLessonMap = (): void => {
    const dialog = el('dialog', { class: 'campaign-map', 'aria-label': 'Campaign lessons' });
    const close = el('button', { text: 'Close' }); close.addEventListener('click', () => { dialog.close(); dialog.remove(); });
    const links = LESSONS.map((l, i) => {
      const unlocked = i === 0 || completed.has(LESSONS[i - 1]!.id) || completed.has(l.id);
      return el('a', { href: unlocked ? `?mode=campaign&lesson=${l.id}` : '#', class: `lesson-link${unlocked ? '' : ' locked'}` }, el('span', { text: String(i + 1).padStart(2, '0') }), el('div', {}, el('b', { text: l.title }), el('small', { text: completed.has(l.id) ? 'Complete' : unlocked ? l.goal : 'Complete the previous lesson' })));
    });
    dialog.append(el('header', {}, el('h2', { text: 'Grow your programming skills' }), close), ...links); document.body.append(dialog); dialog.showModal();
  };
  if (loop.mode === 'campaign') {
    const lesson = selectedLesson(), idx = LESSONS.indexOf(lesson);
    if (idx > 0 && !completed.has(LESSONS[idx - 1]!.id) && !completed.has(lesson.id)) { location.replace('?mode=campaign'); return; }
    const host = document.getElementById('lesson-card')!; host.hidden = false;
    const map = el('button', { text: 'Lesson map' }); map.addEventListener('click', showLessonMap);
    const hint = el('button', { text: 'Show example solution', class: 'quiet' }); hint.addEventListener('click', () => { editor.setSource(lesson.solution); toast('Example loaded', 'Press Run to try it. Your current farm is kept.'); });
    const goal = el('p', { id: 'lesson-goal', class: 'goal', text: lesson.goal });
    host.append(el('header', {}, el('span', { class: 'eyebrow', text: `Lesson ${idx + 1} of ${LESSONS.length}` }), map), el('h3', { text: lesson.title }), el('p', { text: lesson.intro }), goal, hint);
    editor.setFeatures(new Set(lesson.features));
    let done = completed.has(lesson.id);
    window.addEventListener('tendril:snapshot', (event) => {
      const s = (event as CustomEvent<Snapshot>).detail;
      if (!done && lesson.check(s, loop.logChunks().flatMap((c) => c.actions))) {
        done = true; completed.add(lesson.id); saveSet('tendril.campaign.v1', completed);
        goal.textContent = 'Complete · ' + lesson.goal; goal.classList.add('complete');
        toast('Lesson complete', LESSONS[idx + 1] ? `Next: ${LESSONS[idx + 1]!.title}` : 'You have completed the campaign.');
        const next = LESSONS[idx + 1]; if (next) host.append(el('a', { class: 'next-lesson', href: `?mode=campaign&lesson=${next.id}`, text: 'Next lesson →' }));
        void loop.pause();
      }
    });
  }
  window.addEventListener('tendril:snapshot', (event) => {
    const s = (event as CustomEvent<Snapshot>).detail, log = loop.logChunks().flatMap((c) => c.actions);
    const tree = el('div', { class: 'research-grid' });
    UNLOCKS.forEach((u, i) => {
      const unlocked = !!(s.unlocks & (1 << i)), insert = el('button', { class: `research-node${unlocked ? ' unlocked' : ''}`, title: `Insert unlock ${u.name}` });
      insert.append(el('b', { text: cap(u.name) }), el('span', { text: unlocked ? 'Researched' : `${u.price} coins` }));
      insert.addEventListener('click', () => { if (!unlocked) editor.setSource(editor.getSource() + `\nunlock ${u.name}\n`); }); tree.append(insert);
    });
    research.replaceChildren(el('p', { class: 'muted', text: 'Buy research with code: unlock wheat. Click an upgrade to insert its command. Research is separate from campaign language lessons.' }), tree);
    let changed = false;
    for (const a of ACHIEVEMENTS) if (!earned.has(a.id) && a.test(s, log)) { earned.add(a.id); changed = true; toast(a.title, a.detail); }
    if (changed) { saveSet('tendril.achievements.v1', earned); renderGoals(); }
  });
}
