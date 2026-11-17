import { test, expect } from '@playwright/test';
import { ready } from './game.ts';
import { createWorld, hashWorld, netWorth, replayChunk, serialize, BASE_RULES_VERSION } from '@tendril/sim/src/index.ts';

const profile = { id: 'u1', login: 'octo', displayName: 'Octo Cat', avatarUrl: null };
const grower = `repeat forever:
    for each tile in tiles():
        go_to tile
        if scan().ripe:
            harvest
        if scan().empty:
            till
            plant carrot
    go_to barn
    deposit
    sell carrot, all
    wait 5
`;

test('a saved copy whose logs do not reach its world is set aside and the farm rebuilt from the server', async ({ page }) => {
  test.slow();
  const startedAtMs = Date.now() - 120_000;
  const server = createWorld({ id: 'farm-1', seed: 7 });
  const farm = () => ({ id: 'farm-1', seed: 7, startedAtMs, restedMs: 0, tick: server.tick, checkpoint: serialize(server), checkpointHash: hashWorld(server), rulesVersion: BASE_RULES_VERSION, coins: server.coins, netWorth: netWorth(server) });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/me') return json(200, { profile });
    if (path === '/api/farms/me') return json(200, farm());
    if (path === '/api/farms/farm-1/chunks') {
      const body = route.request().postDataJSON() as { fromTick: number; toTick: number; actions: never[] };
      if (body.fromTick !== server.tick) return json(409, { error: 'Stale checkpoint' });
      replayChunk(server, body.actions, body.toTick);
      return json(200, { tick: server.tick, checkpointHash: hashWorld(server), netWorth: netWorth(server), rank: 1 });
    }
    return json(404, { error: 'not mocked' });
  });
  await page.addInitScript(() => localStorage.setItem('tendril.signedin', '1'));
  await page.goto('/?mode=live');
  await ready(page);
  await page.evaluate((src) => window.tendril!.loop.setSource(src), grower);
  await page.evaluate(() => window.tendril!.loop.run());
  await expect.poll(() => server.tick, { timeout: 60_000 }).toBeGreaterThan(500);
  await page.evaluate(() => window.tendril!.loop.pause());
  await page.evaluate(() => window.tendril!.sim.flush());
  // Damage the save the way the bug report showed: the saved world is ahead of an emptied log.
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('tendril', 1);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', 'readwrite');
      tx.objectStore('kv').put([], 'ranked.farm-1.logIdx');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
  }));
  await page.reload();
  await ready(page);
  await expect.poll(() => page.evaluate(() => window.tendril!.sim.latest()?.tick ?? 0)).toBeGreaterThan(500);
  expect(await page.evaluate(() => window.tendril!.sim.drainErrors().filter((e) => e.kind !== 'script').length)).toBe(0);
  const reason = await page.evaluate(() => new Promise<string | null>((resolve) => {
    const open = indexedDB.open('tendril', 1);
    open.onsuccess = () => { const get = open.result.transaction('kv').objectStore('kv').get('ranked.farm-1.quarantine'); get.onsuccess = () => resolve(get.result?.reason ?? null); };
  }));
  expect(reason).toContain('do not reach the durable checkpoint');
});
