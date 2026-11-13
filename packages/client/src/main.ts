import './style.css';
import { createEditor, EXAMPLES } from './editor';
import { FarmView } from './farm-view';
import { GameLoop } from './game-loop';
import { RealSim } from './real-sim';
import { mountReference } from './reference';
import { mountInspectors } from './inspectors';
import { mountDebugger } from './debugger';
import { mountConsole } from './console-panel';
import { mountControls } from './ui';
import { mountAccount, connectRanked } from './account';
import { mountNotice } from './notice';
import { mountUpdates } from './updates';
import { isFirstRun, mountFirstRun } from './firstrun';
import { mountProgression, selectedLesson } from './progression';
import { mountRating } from './rating';
import { challengeScenario, loadChallenge, mountArena } from './arena';
import { FarmApi, signedInHint, wireSiteLinks } from './api-client';
import { mountJoinDuel } from './join-duel';
import { mountAutoSync } from './autosync';
import { el } from './palette';
import type { Mode } from './clock';
import type { Scenario } from './sim-protocol';

wireSiteLinks();
mountJoinDuel();
const query = new URLSearchParams(location.search);
const requested = query.get('mode');
// ?mode=challenge&id=<challenge id> plays any challenge; it shares the daily sim mode.
const mode: Mode = requested === 'sandbox' || requested === 'campaign' || requested === 'daily' ? requested : requested === 'challenge' ? 'daily' : 'live';
// Signed-in players get their Endless farm by default; ?ranked=0 opens the local farm instead.
const rankedParam = query.get('ranked');
const ranked = mode === 'live' && (rankedParam === '1' || (rankedParam === null && signedInHint()));

const api = new FarmApi();
const lesson = selectedLesson();
const challenge = mode === 'daily' ? await loadChallenge(api, query) : null;
const isSeason = challenge?.kind === 'season';
for (const tab of document.querySelectorAll<HTMLAnchorElement>('#mode-tabs a')) {
  if (tab.dataset.mode === (isSeason ? 'season' : mode)) tab.setAttribute('aria-current', 'page');
}
const suffix = mode === 'campaign' ? `.${lesson.id}` : challenge ? `.${challenge.id}` : '';
const scenario: Scenario = { kind: mode, ...(mode === 'campaign' ? { features: lesson.features, setup: lesson.setup, tickLimit: lesson.tickLimit } : challenge ? challengeScenario(challenge) : {}) };
const sim = new RealSim(mode, {
  scenario, storageKey: `sprout.v1.${mode}${suffix}`, authoritative: ranked ? await connectRanked(api, rankedParam !== '1') : undefined,
  seed: mode === 'campaign' ? lesson.seed : challenge?.seed,
});
const names = { live: sim.ranked ? 'Endless · server-verified' : 'Local live · unverified', sandbox: 'Sandbox', campaign: 'Campaign', daily: isSeason ? 'Weekly season' : 'Daily challenge' };
document.getElementById('mode-label')!.textContent = names[mode];
document.getElementById('mode-note')!.textContent = mode === 'live' ? (sim.ranked ? '10 ticks per second · syncs to the server as it runs' : '10 ticks per second · local and unverified until connected') : mode === 'sandbox' ? 'Experiment freely · separate from your live farm' : mode === 'daily' ? `The same seed for everyone · ${challenge?.ticks.toLocaleString('en-US') ?? '3,000'} ticks` : 'Learn one recipe at a time';
const loop = new GameLoop(sim);
const firstRun = await isFirstRun(mode, sim.ranked, query, sim.prefix);
const editor = createEditor(document.getElementById('editor')!, `tendril.sprout.v1.${mode}${suffix}`, mode === 'campaign' ? lesson.starter : mode === 'daily' ? EXAMPLES.daily!.source : firstRun ? '' : undefined);
const view = new FarmView(document.getElementById('farm-canvas') as HTMLCanvasElement);

mountControls({ loop, editor });
mountConsole(editor);
mountDebugger();
mountReference((code) => editor.setSource(editor.getSource() + '\n' + code + '\n'));
mountInspectors(view, () => sim.meta.seed);
mountProgression({ loop, editor, view, api });
if (firstRun) mountFirstRun({ editor, host: document.getElementById('lesson-card')! });
if (challenge) mountArena({ loop, api, challenge });
mountNotice({ live: mode === 'live', verified: sim.ranked });
mountUpdates();
mountRating(api);
mountAccount(api, sim);
if (sim.ranked) mountAutoSync(api, sim, document.getElementById('mode-note'));
window.addEventListener('tendril:snapshot', (event) => view.update((event as CustomEvent).detail));

declare global { interface Window { tendril?: { sim: RealSim; editor: typeof editor; loop: GameLoop } } }
if (import.meta.env.DEV || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) window.tendril = { sim, editor, loop };

const examples = document.getElementById('examples') as HTMLSelectElement;
for (const [key, entry] of Object.entries(EXAMPLES)) examples.append(el('option', { value: key, text: entry.title }));
examples.addEventListener('change', () => {
  const example = EXAMPLES[examples.value];
  if (example && confirm('Replace your editor draft with this example? The farm is kept.')) { editor.setSource(example.source); editor.setErrors([]); editor.setDiagnostics([]); }
  examples.value = '';
});
for (const tab of document.querySelectorAll<HTMLButtonElement>('.deck-tabs button')) tab.addEventListener('click', () => {
  for (const t of document.querySelectorAll<HTMLButtonElement>('.deck-tabs button')) t.setAttribute('aria-selected', String(t === tab));
  for (const p of document.querySelectorAll<HTMLElement>('#view .deck')) p.hidden = p.id !== `deck-${tab.dataset.tab}`;
});

document.querySelector('.skip-link')?.addEventListener('click', (e) => { e.preventDefault(); editor.revealLine(1); });

document.addEventListener('visibilitychange', () => { if (document.hidden && sim.latest()) void sim.flush().catch(() => {}); });
window.addEventListener('pagehide', () => { loop.dispose(); view.dispose(); sim.dispose(); });
window.addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });
void loop.setBreakpoints(editor.breakpoints());
void loop.init(scenario, editor.getSource()).catch(() => {});
