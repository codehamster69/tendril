import './style.css';
import { dailySeed, DAILY_TICKS } from '@tendril/sim/src/index.ts';
import { createEditor, EXAMPLES } from './editor';
import { FarmView } from './farm-view';
import { GameLoop } from './game-loop';
import { RealSim } from './real-sim';
import { mountReference } from './reference';
import { mountInspectors } from './inspectors';
import { mountDebugger } from './debugger';
import { mountProgression, selectedLesson, today } from './progression';
import { ApiError, FarmApi, signIn, writeToken } from './api-client';
import { el, toast } from './palette';
import type { Mode } from './clock';
import type { Scenario } from './sim-protocol';

const query = new URLSearchParams(location.search);
const requested = query.get('mode');
const mode: Mode = requested === 'sandbox' || requested === 'campaign' || requested === 'daily' ? requested : 'live';
for (const tab of document.querySelectorAll<HTMLAnchorElement>('#mode-tabs a')) if (tab.dataset.mode === mode) tab.setAttribute('aria-current', 'page');
const names = { live: 'Live farm', sandbox: 'Sandbox', campaign: 'Campaign', daily: 'Daily challenge' };
document.getElementById('mode-label')!.textContent = names[mode];
document.getElementById('mode-note')!.textContent = mode === 'live' ? '10 ticks per second · local and unverified until connected' : mode === 'sandbox' ? 'Experiment freely · separate from your live farm' : mode === 'daily' ? 'The same seed for everyone · 3,000 ticks' : 'Learn one recipe at a time';
const api = new FarmApi();
const lesson = selectedLesson();
const storageKey = `tendril.sprout.v1.${mode}${mode === 'campaign' ? `.${lesson.id}` : mode === 'daily' ? `.${today()}` : ''}`;
const scenario: Scenario = { kind: mode, ...(mode === 'campaign' ? { features: lesson.features, setup: lesson.setup, tickLimit: lesson.tickLimit } : mode === 'daily' ? { tickLimit: DAILY_TICKS, farmId: `daily-${today()}` } : {}) };
const editor = createEditor(document.getElementById('editor')!, storageKey, mode === 'campaign' ? lesson.starter : mode === 'daily' ? EXAMPLES.daily!.source : undefined);
const view = new FarmView(document.getElementById('farm-canvas') as HTMLCanvasElement);
let authoritative;
if (mode === 'live' && query.get('ranked') === '1') {
  try { authoritative = await api.farm(); } catch (e) { if (e instanceof ApiError && e.status === 404) authoritative = await api.createFarm(); else toast('Could not connect ranked farm', e instanceof Error ? e.message : 'Sign in first.'); }
}
const sim = new RealSim(mode, { scenario, storageKey: `sprout.v1.${mode}${mode === 'campaign' ? `.${lesson.id}` : mode === 'daily' ? `.${today()}` : ''}`, seed: mode === 'campaign' ? lesson.seed : mode === 'daily' ? dailySeed(today()) : undefined, authoritative });
const loop = new GameLoop(sim, view, editor);
mountReference((code) => editor.setSource(editor.getSource() + '\n' + code + '\n'));
mountInspectors(view, () => sim.meta.seed);
mountDebugger();
mountProgression({ loop, editor, api });

declare global { interface Window { tendril?: { sim: RealSim; editor: typeof editor; loop: GameLoop } } }
if (import.meta.env.DEV || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) window.tendril = { sim, editor, loop };

const examples = document.getElementById('examples') as HTMLSelectElement;
for (const [key, entry] of Object.entries(EXAMPLES)) examples.append(el('option', { value: key, text: entry.title }));
examples.addEventListener('change', () => { const example = EXAMPLES[examples.value]; if (example && confirm('Replace your editor draft with this example? The farm is kept.')) { editor.setSource(example.source); editor.setErrors([]); editor.setDiagnostics([]); } });
for (const tab of document.querySelectorAll<HTMLButtonElement>('.deck-tabs button')) tab.addEventListener('click', () => {
  for (const t of document.querySelectorAll<HTMLButtonElement>('.deck-tabs button')) t.setAttribute('aria-selected', String(t === tab));
  for (const p of document.querySelectorAll<HTMLElement>('#view .deck')) p.hidden = p.id !== `deck-${tab.dataset.tab}`;
});

const account = document.getElementById('btn-account') as HTMLButtonElement;
account.addEventListener('click', async () => {
  const dialog = el('dialog', { class: 'campaign-map', 'aria-label': 'Account and ranked farm' });
  const close = el('button', { text: 'Close' }); close.addEventListener('click', () => { dialog.close(); dialog.remove(); });
  dialog.append(el('header', {}, el('h2', { text: 'A fair field for everyone' }), close));
  try {
    const { profile } = await api.me(); dialog.append(el('p', { text: `Signed in as ${profile.displayName}` }));
    dialog.append(el('a', { href: '?mode=live&ranked=1', class: 'next-lesson', text: 'Open your server-verified farm' }));
    if (sim.ranked) {
      const sync = el('button', { text: 'Pause and sync one chunk', class: 'primary' });
      sync.addEventListener('click', async () => { sync.disabled = true; try { await loop.pause(); const plan = sim.prepareChunk(); if (plan) { const response = await api.submit(sim.accepted!.farm.id, plan.request); await sim.acknowledge(plan, response); toast('Farm verified', `Tick ${response.tick}, rank ${response.rank}.`); } else toast('Already synced', 'No new ticks need verifying.'); } catch (e) { toast('Sync stopped', e instanceof Error ? e.message : 'Your local logs are kept.'); } finally { sync.disabled = false; } }); dialog.append(sync);
    }
    const logout = el('button', { text: 'Sign out', class: 'quiet' }); logout.addEventListener('click', async () => { await api.logout(); writeToken(null); location.href = '?mode=live'; }); dialog.append(logout);
  } catch {
    dialog.append(el('p', { text: 'Local play never needs an account. Sign in with GitHub to verify your farm and submit daily scores.' }));
    const login = el('button', { text: 'Continue with GitHub', class: 'primary' }); login.addEventListener('click', () => { void signIn().catch((e: unknown) => toast('Sign-in unavailable', e instanceof Error ? e.message : 'Try again later.')); }); dialog.append(login);
  }
  document.body.append(dialog); dialog.showModal();
});
void api.me().then(({ profile }) => { account.textContent = profile.displayName; }).catch(() => {});
document.addEventListener('visibilitychange', () => { if (document.hidden && sim.latest()) void sim.flush().catch(() => {}); });
window.addEventListener('pagehide', () => { loop.dispose(); view.dispose(); sim.dispose(); });
window.addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });
void loop.init().catch(() => {});
