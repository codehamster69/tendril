// "Publish my program" (C3). The program is always sent with a signed-in submission so the server can check it and
// award Brevity; it stays private until the challenge closes and only becomes readable if this box is ticked.
import { ApiError } from './api-client';
import type { ChallengeInfo, EntryResult, FarmApi } from './api-client';
import type { LogEntry } from '@tendril/sim/src/index.ts';
import { el } from './palette';

const KEY = 'tendril.publishSource';

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
  if (source === null || source.trim() === '') return { ...(await api.submitEntry(c.id, base)), program: 'none' };
  try {
    return { ...(await api.submitEntry(c.id, { ...base, source, sourcePublic: publishPreference() })), program: 'verified' };
  } catch (e) {
    if (!isSourceRefusal(e)) throw e;
    return { ...(await api.submitEntry(c.id, base)), program: e.status === 503 ? 'unavailable' : 'mismatch' };
  }
}
