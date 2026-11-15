import { journalKey, validateJournal, type JournalIndex } from './log-journal';
import type { LogChunk } from './chunks';
// IndexedDB "tendril" / "kv". A write resolves at transaction completion, not put success.
const DB = 'tendril';
const STORE = 'kv';
let dbPromise: Promise<IDBDatabase> | null = null;
let writes: Promise<void> = Promise.resolve();

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => {
      req.result.onversionchange = () => { req.result.close(); dbPromise = null; };
      resolve(req.result);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onblocked = () => reject(new Error('Farm storage is blocked by another open window.'));
  });
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('Farm save was aborted.'));
    tx.onerror = () => reject(tx.error ?? new Error('Farm save failed.'));
  });
}

/** Several related values read from the same database revision. */
export async function kvGetMany<T extends Record<string, unknown>>(keys: string[]): Promise<Partial<T>> {
  await writes;
  const db = await open();
  const tx = db.transaction(STORE, 'readonly');
  const complete = done(tx);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => { result[key] = req.result; };
  }
  await complete;
  return result as Partial<T>;
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  return (await kvGetMany<Record<string, T>>([key]))[key];
}

function write(entries: Record<string, unknown>, remove: string[]): Promise<void> {
  // Capture now: callers may mutate their arrays while a prior save is in flight.
  const values = structuredClone(entries);
  const next = writes.then(async () => {
    const db = await open();
    const tx = db.transaction(STORE, 'readwrite', { durability: 'strict' });
    const complete = done(tx);
    for (const [key, value] of Object.entries(values)) tx.objectStore(STORE).put(value, key);
    for (const key of remove) tx.objectStore(STORE).delete(key);
    await complete;
  });
  writes = next.catch(() => {}); // A failed save must not poison explicit retries.
  return next;
}

/** Ordered, atomic checkpoint/meta/log writes. */
export function kvSetMany(entries: Record<string, unknown>): Promise<void> { return write(entries, []); }
export function kvDelete(keys: string[]): Promise<void> { return write({}, keys); }

/** Reads the checkpoint and dynamically indexed log records from one revision. */
export async function kvGetFarm(prefix: string): Promise<{ saved: Record<string, unknown>; journal?: JournalIndex }> {
  await writes;
  const db = await open();
  const tx = db.transaction(STORE, 'readonly');
  const complete = done(tx);
  const store = tx.objectStore(STORE);
  const saved: Record<string, unknown> = {};
  let journal: JournalIndex | undefined;
  let failure: unknown;
  for (const name of ['world', 'meta', 'pendingLog', 'source', 'hash', 'accepted']) {
    const key = prefix + name;
    const request = store.get(key);
    request.onsuccess = () => { saved[key] = request.result; };
  }
  const request = store.get(prefix + 'journal');
  request.onsuccess = () => {
    if (request.result === undefined) return;
    try {
      journal = validateJournal(request.result);
      const logs: LogChunk[] = new Array(journal.ends.length);
      // Override legacy only after the complete transaction succeeds.
      journal.ends.forEach((end, i) => {
        const chunk = store.get(journalKey(prefix, end));
        chunk.onsuccess = () => {
          if (!chunk.result || chunk.result.toTick !== end) { failure = new Error('Saved log journal is missing a chunk. Logs retained.'); tx.abort(); return; }
          logs[i] = chunk.result;
        };
      });
      saved[prefix + 'journalLogs'] = logs;
    } catch (error) { failure = error; tx.abort(); }
  };
  try { await complete; } catch (error) { throw failure ?? error; }
  if (journal) { saved[prefix + 'pendingLog'] = saved[prefix + 'journalLogs']; delete saved[prefix + 'journalLogs']; }
  return { saved, journal };
}

/** Compare and mutate in the same strict transaction so another app window
 * cannot overwrite a newer durable farm. Failed writes leave every old key intact. */
export function kvCommitFarm(prefix: string, expected: JournalIndex | undefined, entries: Record<string, unknown>, remove: string[]): Promise<void> {
  const values = structuredClone(entries);
  const expectedRevision = expected?.revision;
  const next = writes.then(async () => {
    const db = await open();
    const tx = db.transaction(STORE, 'readwrite', { durability: 'strict' });
    const complete = done(tx);
    const store = tx.objectStore(STORE);
    let conflict = false;
    let failure: unknown;
    const request = store.get(prefix + 'journal');
    request.onsuccess = () => {
      if (request.result?.revision !== expectedRevision) { conflict = true; tx.abort(); return; }
      try {
        for (const [key, value] of Object.entries(values)) store.put(value, key);
        for (const key of remove) store.delete(key);
      } catch (error) { failure = error; tx.abort(); }
    };
    try { await complete; } catch (error) {
      if (conflict) throw new Error('Farm changed in another window. Reload before continuing; local logs are kept.', { cause: error });
      throw failure ?? error;
    }
  });
  writes = next.catch(() => {});
  return next;
}
