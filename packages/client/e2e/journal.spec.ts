import { test, expect, type Page } from '@playwright/test';

const prefix = 'sprout.v1.sandbox.';
async function read(page: Page) {
  return page.evaluate(async prefix => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('tendril', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const tx = db.transaction('kv', 'readonly');
    const result: Record<string, unknown> = {};
    await new Promise<void>((resolve, reject) => {
      const r = tx.objectStore('kv').openCursor();
      r.onsuccess = () => { const c = r.result; if (c) { if (String(c.key).startsWith(prefix)) result[String(c.key).slice(prefix.length)] = c.value; c.continue(); } };
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    });
    db.close(); return result;
  }, prefix);
}
async function boot(page: Page) {
  await page.goto('/?mode=sandbox');
  await expect(page.locator('#btn-step')).toBeEnabled();
}
async function advance(page: Page, n = 100) { await page.evaluate(n => window.tendril!.loop.step(n), n); }

test('legacy history migrates atomically and appends only new log records', async ({ page }) => {
  await boot(page); await advance(page);
  const before = await read(page);
  await page.evaluate(async ({ prefix, before }) => {
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open('tendril', 1); r.onsuccess = () => resolve(r.result); });
    const tx = db.transaction('kv', 'readwrite'); const store = tx.objectStore('kv');
    const index = before.journal as { ends: number[] };
    const logs = index.ends.map(end => before['log.' + end]);
    store.put(logs, prefix + 'pendingLog'); store.delete(prefix + 'journal');
    for (const end of index.ends) store.delete(prefix + 'log.' + end);
    await new Promise<void>(resolve => { tx.oncomplete = () => resolve(); }); db.close();
  }, { prefix, before });
  await page.reload(); await expect(page.locator('#hud-tick')).toHaveText('100');
  const migrated = await read(page);
  expect(migrated.pendingLog).toBeUndefined(); expect(migrated.world).toBe(before.world);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    (window as unknown as { logWrites: string[] }).logWrites = [];
    IDBObjectStore.prototype.put = function(value, key) {
      if (String(key).includes('.log.')) (window as unknown as { logWrites: string[] }).logWrites.push(String(key));
      return original.call(this, value, key);
    };
  });
  await advance(page);
  expect(await page.evaluate(() => (window as unknown as { logWrites: string[] }).logWrites)).toEqual([prefix + 'log.200']);
  const after = await read(page); expect(after['log.100']).toEqual(migrated['log.100']);
});

test('aborted append retains checkpoint and retry saves every pending action', async ({ page }) => {
  await boot(page); await advance(page);
  const before = await read(page);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      const request = original.call(this, value, key);
      if (String(key).endsWith('.journal')) this.transaction.abort();
      return request;
    };
    (window as unknown as { restorePut: () => void }).restorePut = () => { IDBObjectStore.prototype.put = original; };
  });
  await page.evaluate(async () => {
    const sim = window.tendril!.sim; sim.requestStep(100);
    while (sim.busy) await new Promise(resolve => setTimeout(resolve, 5));
  });
  expect(await read(page)).toEqual(before);
  await expect(page.locator('#status')).toContainText('save failed');
  await page.evaluate(() => (window as unknown as { restorePut: () => void }).restorePut());
  await page.evaluate(() => window.tendril!.loop.pause());
  const after = await read(page); expect(after['log.200']).toBeDefined();
  await page.reload(); await expect(page.locator('#hud-tick')).toHaveText('200');
});

test('concurrent journal writer is rejected without overwriting the newer checkpoint', async ({ page }) => {
  await boot(page); await advance(page);
  await page.evaluate(async prefix => {
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open('tendril', 1); r.onsuccess = () => resolve(r.result); });
    const tx = db.transaction('kv', 'readwrite'); const store = tx.objectStore('kv');
    const request = store.get(prefix + 'journal'); request.onsuccess = () => store.put({ ...request.result, revision: request.result.revision + 1 }, prefix + 'journal');
    await new Promise<void>(resolve => { tx.oncomplete = () => resolve(); }); db.close();
  }, prefix);
  const before = await read(page); await advance(page);
  expect(await read(page)).toEqual(before);
  await expect(page.locator('#status')).toContainText('another window');
});

test('reset removes old journal history only when replacement commits', async ({ page }) => {
  await boot(page); await advance(page);
  await page.click('#btn-reset');
  await expect(page.locator('#hud-tick')).toHaveText('0');
  const after = await read(page); expect(after['log.100']).toBeUndefined();
  expect((after.journal as { ends: number[] }).ends).toEqual([]);
  await page.reload(); await expect(page.locator('#hud-tick')).toHaveText('0');
});

test('a missing indexed chunk fails restore without replacing saved history', async ({ page }) => {
  await boot(page); await advance(page);
  await page.evaluate(async prefix => {
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open('tendril', 1); r.onsuccess = () => resolve(r.result); });
    const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').delete(prefix + 'log.100');
    await new Promise<void>(resolve => { tx.oncomplete = () => resolve(); }); db.close();
  }, prefix);
  const before = await read(page);
  await page.reload();
  await expect(page.locator('#console')).toContainText('missing a chunk');
  expect(await read(page)).toEqual(before);
});

test('aborted reset keeps the entire old journal until a replacement commits', async ({ page }) => {
  await boot(page); await advance(page);
  const before = await read(page);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      const request = original.call(this, value, key);
      if (String(key).endsWith('.journal') && (value as { ends: number[] }).ends.length === 0) this.transaction.abort();
      return request;
    };
    (window as unknown as { restorePut: () => void }).restorePut = () => { IDBObjectStore.prototype.put = original; };
  });
  await page.click('#btn-reset');
  await expect(page.locator('#status')).toContainText('save failed');
  const failed = await read(page);
  expect(failed.world).toEqual(before.world); expect(failed['log.100']).toEqual(before['log.100']);
  await page.evaluate(() => (window as unknown as { restorePut: () => void }).restorePut());
  await page.evaluate(() => window.tendril!.loop.pause());
  const after = await read(page); expect(after['log.100']).toBeUndefined();
  await page.reload(); await expect(page.locator('#hud-tick')).toHaveText('0');
});

test('aborted legacy migration preserves the legacy array for a successful retry', async ({ page }) => {
  await boot(page); await advance(page);
  await page.evaluate(async prefix => {
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open('tendril', 1); r.onsuccess = () => resolve(r.result); });
    const tx = db.transaction('kv', 'readwrite'); const store = tx.objectStore('kv');
    const request = store.get(prefix + 'log.100');
    request.onsuccess = () => { store.put([request.result], prefix + 'pendingLog'); store.delete(prefix + 'journal'); store.delete(prefix + 'log.100'); };
    await new Promise<void>(resolve => { tx.oncomplete = () => resolve(); }); db.close();
  }, prefix);
  const before = await read(page);
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      const request = original.call(this, value, key);
      if (String(key).endsWith('.journal')) this.transaction.abort();
      return request;
    };
    (window as unknown as { restorePut: () => void }).restorePut = () => { IDBObjectStore.prototype.put = original; };
  });
  await page.reload();
  await expect(page.locator('#status')).toContainText('save failed');
  expect(await read(page)).toEqual(before);
  await page.evaluate(() => (window as unknown as { restorePut: () => void }).restorePut());
  await page.evaluate(() => window.tendril!.loop.pause());
  const after = await read(page); expect(after.pendingLog).toBeUndefined();
  expect(after['log.100']).toEqual((before.pendingLog as unknown[])[0]);
  expect(after.world).toEqual(before.world);
});
