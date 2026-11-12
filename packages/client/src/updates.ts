import { el, toast } from './palette';

/** Mirrors the state object sent by electron/updater.cjs. */
export interface UpdateState {
  version: string;
  platform: string;
  mode: 'install' | 'notify' | 'off';
  auto: boolean;
  status: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'error';
  latest: string | null;
  percent: number;
  error: string | null;
  checkedAt: number | null;
}

interface UpdateBridge {
  getState(): Promise<UpdateState | null>;
  check(): void;
  download(): void;
  install(): void;
  setAuto(auto: boolean): void;
  onState(listener: (state: UpdateState) => void): () => void;
}

declare const __APP_VERSION__: string;

function bridge(): UpdateBridge | null {
  const desktop = (window as unknown as { tendrilDesktop?: { updates?: UpdateBridge } }).tendrilDesktop;
  return desktop?.updates ?? null;
}

/** One line describing where the update stands. */
export function describe(state: UpdateState): string {
  switch (state.status) {
    case 'checking': return 'Checking for updates…';
    case 'current': return 'You have the latest version.';
    case 'available': return state.mode === 'install'
      ? `Version ${state.latest} is available.`
      : `Version ${state.latest} is available. Download it from the release page.`;
    case 'downloading': return `Downloading version ${state.latest ?? ''}… ${state.percent}%`;
    case 'ready': return `Version ${state.latest} is ready. Restart Tendril to finish updating.`;
    case 'error': return 'Could not check for updates. Tendril will try again later.';
    default: return state.mode === 'off' ? 'Updates are checked only in the installed app.' : 'Updates are checked automatically.';
  }
}

/** Version chip in the status bar, with a small panel for update status and controls. */
export function mountUpdates(): void {
  const chip = document.getElementById('app-version');
  if (!chip) return;
  const version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';
  const updates = bridge();
  chip.textContent = `v${version}`;

  const panel = el('div', { id: 'update-panel', role: 'dialog', 'aria-label': 'About Tendril' });
  panel.hidden = true;
  document.body.append(panel);
  const close = (): void => { panel.hidden = true; chip.setAttribute('aria-expanded', 'false'); };
  chip.setAttribute('aria-expanded', 'false');
  chip.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    chip.setAttribute('aria-expanded', String(!panel.hidden));
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
  document.addEventListener('pointerdown', (event) => {
    if (!panel.hidden && !panel.contains(event.target as Node) && event.target !== chip) close();
  });

  if (!updates) {
    panel.append(el('b', { text: `Tendril v${version}` }),
      el('p', { text: 'You are playing the web version, which is always up to date.' }));
    return;
  }

  let announced: string | null = null;
  const render = (state: UpdateState): void => {
    chip.textContent = `v${state.version}`;
    const pending = state.status === 'available' || state.status === 'ready';
    chip.classList.toggle('has-update', pending);
    chip.title = pending ? describe(state) : `Tendril v${state.version}`;

    const actions = el('div', { class: 'update-actions' });
    if (state.status === 'ready') {
      const restart = el('button', { class: 'primary', type: 'button', text: 'Restart and update' });
      restart.addEventListener('click', () => updates.install());
      actions.append(restart);
    } else if (state.status === 'available') {
      const get = el('button', { class: 'primary', type: 'button', text: state.mode === 'install' ? 'Download update' : 'Open download page' });
      get.addEventListener('click', () => updates.download());
      actions.append(get);
    }
    if (state.mode !== 'off' && state.status !== 'ready' && state.status !== 'downloading') {
      const check = el('button', { class: 'ghost', type: 'button', text: 'Check now' });
      check.disabled = state.status === 'checking';
      check.addEventListener('click', () => updates.check());
      actions.append(check);
    }

    const body: Node[] = [el('b', { text: `Tendril v${state.version}` }), el('p', { class: 'update-status', text: describe(state) })];
    if (state.status === 'downloading') {
      const bar = el('progress', { max: '100', value: String(state.percent) });
      body.push(bar);
    }
    if (actions.childElementCount) body.push(actions);
    if (state.mode === 'install') {
      const box = el('input', { type: 'checkbox' });
      box.checked = state.auto;
      box.addEventListener('change', () => updates.setAuto(box.checked));
      body.push(el('label', { class: 'update-auto' }, box, ' Download updates automatically'));
    } else if (state.mode === 'notify' && state.platform === 'darwin') {
      body.push(el('p', { class: 'update-note', text: 'On macOS, new versions are installed from the release page: open the .dmg and drag Tendril into Applications.' }));
    }
    if (state.checkedAt) body.push(el('p', { class: 'update-note', text: `Last checked ${new Date(state.checkedAt).toLocaleTimeString()}` }));
    panel.replaceChildren(...body);

    const key = `${state.status}:${state.latest}`;
    if (pending && announced !== key) {
      announced = key;
      toast(state.status === 'ready' ? 'Update ready' : 'Update available', `${describe(state)} Click the version number in the bottom bar.`);
    }
  };

  updates.onState(render);
  void updates.getState().then((state) => { if (state) render(state); });
}
