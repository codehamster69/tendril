/**
 * Boot progress for the splash screen (markup and CSS are inlined in each page by vite-splash.mjs).
 * The bar shows real progress: every step has a weight and finishes when its module calls `boot.done(name)`.
 * To change what loading waits for, edit PROFILES below and nothing else.
 */
export type StepName = 'script' | 'models' | 'frame' | 'worker' | 'editor' | 'save';
type Step = { name: StepName; weight: number; label: string };

const PROFILES: Record<'game' | 'lite', Step[]> = {
  game: [
    { name: 'script', weight: 2, label: 'Starting up…' },
    { name: 'save', weight: 1, label: 'Opening your saved farm…' },
    { name: 'models', weight: 3, label: 'Loading models…' },
    { name: 'worker', weight: 2, label: 'Waking the simulation…' },
    { name: 'editor', weight: 1, label: 'Preparing the editor…' },
    { name: 'frame', weight: 2, label: 'Drawing the island…' },
  ],
  // Replay and room pages have no editor, saved farm or live simulation worker.
  lite: [
    { name: 'script', weight: 2, label: 'Starting up…' },
    { name: 'models', weight: 3, label: 'Loading models…' },
    { name: 'frame', weight: 2, label: 'Drawing the farm…' },
  ],
};

const MIN_MS = 600;       // never flash: show the splash at least this long
const FADE_MS = 400;
const SLOW_MS = 8000;     // after this, say it is taking a while
const GIVE_UP_MS = 30000; // after this, offer Retry

let steps = PROFILES.game;
const finished = new Set<StepName>();
let ended = false;
let ready: () => void = () => {};
const readyPromise = new Promise<void>((r) => { ready = r; });

const splash = (): HTMLElement | null => document.getElementById('splash');
const reduced = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;

function render(): void {
  const s = splash();
  if (!s) return;
  const total = steps.reduce((a, x) => a + x.weight, 0);
  const done = steps.filter((x) => finished.has(x.name)).reduce((a, x) => a + x.weight, 0);
  const p = total ? done / total : 1;
  s.style.setProperty('--p', p.toFixed(3));
  s.querySelector('.sp-bar')?.setAttribute('aria-valuenow', String(Math.round(p * 100)));
  const next = steps.find((x) => !finished.has(x.name));
  const status = s.querySelector('.sp-status');
  if (status) status.textContent = next ? next.label : 'Ready';
}

function finish(): void {
  if (ended) return;
  ended = true;
  const s = splash();
  const wait = Math.max(0, MIN_MS - performance.now());
  window.setTimeout(() => {
    document.getElementById('farm-stage')?.classList.add('sp-glide');
    if (!s) { ready(); return; }
    s.classList.add('sp-out');
    s.removeAttribute('role');
    window.setTimeout(() => { s.remove(); ready(); }, reduced() ? 0 : FADE_MS);
  }, wait);
}

export const boot = {
  /** Pick the step list for this page. Call before anything reports; the default is the game page. */
  profile(name: 'game' | 'lite'): void { steps = PROFILES[name]; render(); },
  /** A named step finished. Unknown names and repeats are ignored. */
  done(name: StepName): void {
    if (ended || finished.has(name) || !steps.some((x) => x.name === name)) return;
    finished.add(name);
    render();
    if (steps.every((x) => finished.has(x.name))) finish();
  },
  /** Loading failed for good: show the message and a Retry button. */
  fail(message: string): void {
    if (ended) return;
    (window as unknown as { __splashFail?: (m: string) => void }).__splashFail?.(message);
  },
  /** Resolves once the splash is gone and the game is showing. First-run prompts wait on this. */
  whenReady: (): Promise<void> => readyPromise,
  /** Names of steps still pending (for tests and the failure message). */
  pending: (): StepName[] => steps.filter((x) => !finished.has(x.name)).map((x) => x.name),
};

window.setTimeout(() => {
  if (ended) return;
  const status = splash()?.querySelector('.sp-status');
  if (status) status.textContent = 'Still loading. Slow connections take a little longer.';
}, SLOW_MS);
window.setTimeout(() => { if (!ended) boot.fail(`Loading is taking too long (waiting on ${boot.pending().join(', ')}). Check your connection and try again.`); }, GIVE_UP_MS);
// `import './boot'` runs this, which is the first step.
boot.done('script');
