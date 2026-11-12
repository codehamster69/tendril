// "Publish my program" (C3). The program is always sent with a signed-in submission so the server can check it and
// award Brevity; it stays private until the challenge closes and only becomes readable if this box is ticked.
import { ApiError } from './api-client';
import type { ChallengeInfo, EntryResult, FarmApi } from './api-client';
import type { LogEntry } from '@tendril/sim/src/index.ts';
import { el } from './palette';

const KEY = 'tendril.publishSource';
const MODEL_KEY = 'tendril.modelName';

export function publishPreference(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

/** The tick box. Remembers the choice on this device; read it again at submit time with publishPreference(). */
export function publishBox(): HTMLElement {
  const box = el('input', { type: 'checkbox', id: 'publish-source' });
  box.checked = publishPreference();
  box.addEventListener('change', () => { try { localStorage.setItem(KEY, box.checked ? '1' : '0'); } catch { /* private mode */ } });
  return el('label', { id: 'publish-source-row', class: 'publish-source', title: 'Your program is checked by the server for the Brevity medal and stays private. If you tick this, anyone can read it once the challenge has closed.' },
    box, ' Publish my program when this challenge closes');
}

/** The model name typed into the "a model wrote this" box, or null when the box is unticked. Declaration is on the honour system. */
export function declaredModel(): string | null {
  try { const m = (localStorage.getItem(MODEL_KEY) ?? '').trim(); return m === '' ? null : m.slice(0, 64); } catch { return null; }
}

/** "A model wrote this program": a model entry must be published, so ticking it also publishes. */
export function modelBox(): HTMLElement {
  const box = el('input', { type: 'checkbox', id: 'model-entry' });
  const name = el('input', { type: 'text', id: 'model-name', maxlength: '64', placeholder: 'model name, e.g. my-model-1', 'aria-label': 'Model name' });
  const saved = declaredModel();
  box.checked = saved !== null; name.value = saved ?? ''; name.hidden = saved === null;
  const save = (): void => { try { if (box.checked && name.value.trim() !== '') localStorage.setItem(MODEL_KEY, name.value.trim()); else localStorage.removeItem(MODEL_KEY); } catch { /* private mode */ } };
  box.addEventListener('change', () => { name.hidden = !box.checked; if (box.checked) name.focus(); save(); });
  name.addEventListener('input', save);
  return el('label', { id: 'model-entry-row', class: 'publish-source', title: 'Tick this if an AI model wrote the program. It goes on the models board, and its program is published when the challenge closes. This is on the honour system.' },
    box, ' A model wrote this program ', name);
}

export type ProgramStatus = 'verified' | 'mismatch' | 'unavailable' | 'none';
export type SubmittedEntry = EntryResult & { program: ProgramStatus };

/** The server refuses a program that does not reproduce the run (edited mid-run, farm clicked by hand) with 422 "Source ...". */
const isSourceRefusal = (e: unknown): e is ApiError => e instanceof ApiError && ((e.status === 422 && /^Source /.test(e.message)) || e.status === 503);

/**
 * Submits the run with its program. If the program cannot be matched to the run, the run still counts: the same log is
 * sent again without the program, so a player never loses a score because of the Brevity check.
 */
export async function submitWithProgram(api: FarmApi, c: ChallengeInfo, actions: LogEntry[], source: string | null): Promise<SubmittedEntry> {
  const base = { rulesVersion: c.rulesVersion, actions };
  const model = declaredModel();
  if (model !== null && (source === null || source.trim() === '')) throw new ApiError(422, 'A model entry needs a program. Write one in the editor first.');
  if (source === null || source.trim() === '') return { ...(await api.submitEntry(c.id, base)), program: 'none' };
  try {
    const declared = model === null ? {} : { authorKind: 'model' as const, model };
    return { ...(await api.submitEntry(c.id, { ...base, source, sourcePublic: model !== null || publishPreference(), ...declared })), program: 'verified' };
  } catch (e) {
    if (model !== null) throw e; // a declared model entry is never downgraded to a plain human run
    if (!isSourceRefusal(e)) throw e;
    return { ...(await api.submitEntry(c.id, base)), program: e.status === 503 ? 'unavailable' : 'mismatch' };
  }
}
