import { test, expect, type Page } from '@playwright/test';
import { createWorld, deserialize, hashWorld, replayChunk } from '@tendril/sim/src/index.ts';
import type { LogChunk } from '../src/real-sim';

async function sandbox(page: Page): Promise<void> {
  await page.goto('/?mode=sandbox');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'paused');
}

async function saved(page: Page, prefix = 'sandbox.'): Promise<{ world: string; logs: LogChunk[]; hash: string; source: string }> {
  return page.evaluate(async (prefix) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('tendril', 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const tx = db.transaction('kv', 'readonly');
    const get = <T,>(key: string): Promise<T> => new Promise((resolve, reject) => {
      const req = tx.objectStore('kv').get(prefix + key);
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
    const [world, logs, hash, source] = await Promise.all([
      get<string>('world'), get<LogChunk[]>('pendingLog'), get<string>('hash'), get<string>('source'),
    ]);
    db.close();
    return { world, logs, hash, source };
  }, prefix);
}

const harvest = `-- One restart-safe tile, one complete sale.
local function walk(x, y)
  local bx, by = bot.pos()
  while bx < x do bot.move("east"); bx, by = bot.pos() end
  while bx > x do bot.move("west"); bx, by = bot.pos() end
  while by < y do bot.move("south"); bx, by = bot.pos() end
  while by > y do bot.move("north"); bx, by = bot.pos() end
end
walk(1, 0)
if not bot.scan().crop then bot.till(); bot.plant("carrot") end
while bot.scan().stage < 3 do bot.wait(10) end
bot.harvest()
walk(0, 0)
bot.deposit()
local stock = market.stock()
if stock.carrot then market.sell("carrot", stock.carrot) end
log("carrots sold", market.coins())
while true do bot.wait(100) end`;

test('golden path uses Lua, sells crops, checkpoints, replays and survives restart', async ({ page }) => {
  await sandbox(page);
  await page.evaluate((source) => window.tendril!.loop.setSource(source), harvest);
  await page.click('#btn-step');
  await expect(page.locator('#hud-tick')).toHaveText('100');
  await page.click('#btn-step');
  await expect(page.locator('#hud-tick')).toHaveText('200');
  await expect(page.locator('#hud-coins')).toHaveText('8');
  await expect(page.locator('#console')).toContainText('carrots sold');
  await page.evaluate(() => window.tendril!.sim.flush());
  const checkpoint = await saved(page);
  const world = deserialize(checkpoint.world);
  expect(hashWorld(world)).toBe(checkpoint.hash);
  expect(checkpoint.source).toBe(harvest);
  const replay = createWorld({ id: world.id, seed: world.seed });
  for (const chunk of checkpoint.logs) {
    expect(replay.tick).toBe(chunk.fromTick);
    expect(hashWorld(replay)).toBe(chunk.fromHash);
    replayChunk(replay, chunk.actions, chunk.toTick);
    expect(hashWorld(replay)).toBe(chunk.hash);
  }
  expect(hashWorld(replay)).toBe(hashWorld(world));
  await page.reload();
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'paused');
  await expect(page.locator('#hud-tick')).toHaveText('200');
  await expect(page.locator('#hud-coins')).toHaveText('8');
  expect(await page.evaluate(() => window.tendril!.editor.getSource())).toBe(harvest);
  expect((await saved(page)).logs).toEqual(checkpoint.logs);
});

test('run recompiles edits at the current farm and snapshot events match the seam', async ({ page }) => {
  await sandbox(page);
  await page.click('#btn-step');
  await expect(page.locator('#hud-tick')).toHaveText('100');
  await page.evaluate(() => {
    window.tendril!.editor.setSource('log("edited", world.tick())\nwhile true do bot.wait(1) end');
    window.addEventListener('tendril:snapshot', (e) => {
      document.body.dataset.snapshotTick = String((e as CustomEvent).detail.tick);
    });
  });
  await page.selectOption('#speed', '64');
  await page.click('#btn-run');
  await expect(page.locator('#console')).toContainText('edited');
  await page.click('#btn-pause');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'paused');
  const tick = await page.locator('#hud-tick').textContent();
  expect(Number(tick)).toBeGreaterThan(100);
  expect(await page.evaluate(() => window.tendril!.loop.snapshot()!.tick)).toBe(Number(tick));
  await expect(page.locator('body')).toHaveAttribute('data-snapshot-tick', tick!);
  await expect(page.locator('#console')).toContainText('farm kept');
});

test('syntax and runtime errors show useful console text and the correct Lua line', async ({ page }) => {
  await sandbox(page);
  await page.evaluate(() => window.tendril!.editor.setSource('-- first line\nlocal = 2'));
  await page.click('#btn-run');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'error');
  await expect(page.locator('#editor')).toHaveAttribute('data-error-lines', '2');
  await expect(page.locator('#console .err')).toContainText('bot:2:');
  await expect(page.locator('#hud-tick')).toHaveText('0');

  await page.evaluate(() => window.tendril!.editor.setSource('-- first line\nbot.move("diagonal")'));
  await page.click('#btn-run');
  await expect(page.locator('#console')).toContainText("unknown direction 'diagonal'");
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'error');
  await expect(page.locator('#editor')).toHaveAttribute('data-error-lines', '2');
  await page.evaluate(() => window.tendril!.editor.setSource('while true do bot.wait(1) end'));
  await page.click('#btn-run');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'running');
  await expect(page.locator('#editor')).toHaveAttribute('data-error-lines', '');
  await page.click('#btn-pause');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'paused');
});

test('pause cancels a run that is still compiling Lua', async ({ page }) => {
  await sandbox(page);
  await page.evaluate(() => {
    const sim = window.tendril!.sim;
    const original = sim.setSource.bind(sim);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    sim.setSource = async (source) => { await gate; await original(source); };
    window.addEventListener('test:release-compile', () => release(), { once: true });
  });
  await page.click('#btn-run');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'compiling');
  await page.click('#btn-pause');
  await page.evaluate(() => window.dispatchEvent(new Event('test:release-compile')));
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'paused');
  await page.waitForTimeout(300); // Verify the late compile cannot restart ticking.
  await expect(page.locator('#hud-tick')).toHaveText('0');
});

test('a damaged saved clock is reported without deleting it, and explicit reset recovers', async ({ page }) => {
  await sandbox(page);
  const original = await saved(page);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const req = indexedDB.open('tendril', 1);
      req.onsuccess = () => resolve(req.result);
    });
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').delete('sandbox.meta');
    await new Promise<void>((resolve) => { tx.oncomplete = () => resolve(); });
    db.close();
  });
  await page.reload();
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'error');
  await expect(page.locator('#console')).toContainText('missing its clock');
  expect((await saved(page)).world).toBe(original.world);
  await page.click('#btn-reset');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'paused');
  await expect(page.locator('#hud-tick')).toHaveText('0');
  await page.click('#btn-step');
  await expect(page.locator('#hud-tick')).toHaveText('100');
});

test('more than 200 chunks retain every action, with correct fromTick after reload', async ({ page }) => {
  await sandbox(page);
  await page.evaluate(async () => {
    const { sim, loop } = window.tendril!;
    await loop.setSource('while true do bot.wait(1) end');
    for (let i = 0; i < 205; i++) {
      sim.requestStep(1);
      await sim.flush();
    }
  });
  const checkpoint = await saved(page);
  expect(checkpoint.logs).toHaveLength(205);
  expect(checkpoint.logs[0].fromTick).toBe(0);
  expect(checkpoint.logs.flatMap((chunk) => chunk.actions)).toHaveLength(205);
  await page.reload();
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'paused');
  await page.click('#btn-step');
  await expect(page.locator('#hud-tick')).toHaveText('305');
  const latest = await saved(page);
  expect(latest.logs).toHaveLength(206);
  expect(latest.logs[205].fromTick).toBe(205);
  expect(latest.logs[205].actions[0][0]).toBe(205);
  expect(latest.logs.slice(0, 205)).toEqual(checkpoint.logs);
});

test('flush is an ordered durability barrier and save failure retains logs for retry', async ({ page }) => {
  await sandbox(page);
  const result = await page.evaluate(async () => {
    const { sim, loop } = window.tendril!;
    await loop.setSource('while true do bot.wait(1) end');
    const original = IDBObjectStore.prototype.put;
    let fail = true;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (fail) { fail = false; throw new DOMException('Test disk full', 'QuotaExceededError'); }
      return original.apply(this, args);
    };
    sim.requestStep(100);
    while (sim.busy) await new Promise((resolve) => setTimeout(resolve, 5));
    const failure = sim.persistenceError;
    const retained = sim.logChunks();
    IDBObjectStore.prototype.put = original;
    await loop.pause();
    return { failure, retained, durableTick: sim.durableTick, error: sim.persistenceError, hash: sim.hash };
  });
  expect(result.failure).toContain('Test disk full');
  expect(result.retained.flatMap((chunk) => chunk.actions)).toHaveLength(100);
  expect(result.durableTick).toBe(100);
  expect(result.error).toBeNull();
  const checkpoint = await saved(page);
  expect(checkpoint.logs).toEqual(result.retained);
  expect(checkpoint.hash).toBe(result.hash);
  expect(deserialize(checkpoint.world).tick).toBe(100);
  await expect(page.locator('#console')).toContainText('Farm save failed');
});

test('live clock catches up offline, speed cannot mint ticks and reset needs confirmation', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveAttribute('data-state', /running|catching-up/);
  await expect(page.locator('#mode-label')).toHaveText('Local live · unverified');
  await expect(page.locator('#btn-step')).toBeHidden();
  await page.evaluate(() => window.tendril!.loop.pause());
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'paused');
  const meta = await page.evaluate(() => window.tendril!.sim.meta);
  const oldTick = Number(await page.locator('#hud-tick').textContent());
  await page.clock.install({ time: new Date(meta.startedAtMs + (oldTick + 1000) * 100) });
  await page.selectOption('#speed', '64');
  await page.click('#btn-run');
  await expect(page.locator('#status')).toContainText('Catching up');
  await page.clock.runFor(2000);
  await expect.poll(async () => Number(await page.locator('#hud-tick').textContent())).toBeGreaterThanOrEqual(oldTick + 1000);
  await page.evaluate(() => window.tendril!.loop.pause());
  const gate = await page.evaluate(async () => {
    const { sim } = window.tendril!;
    sim.requestStep(20_000); // Even the test seam is locally clock-gated.
    await sim.flush();
    return { tick: sim.latest()!.tick, target: Math.floor((Date.now() - sim.meta.startedAtMs) / 100) };
  });
  expect(gate.tick).toBeLessThanOrEqual(gate.target);
  expect(gate.tick).toBeGreaterThan(oldTick);
  const beforeReload = await saved(page, '');
  await page.reload();
  await expect(page.locator('#status')).toHaveAttribute('data-state', /running|catching-up/);
  expect(await page.evaluate(() => window.tendril!.sim.meta)).toEqual(meta);
  expect(Number(await page.locator('#hud-tick').textContent())).toBeGreaterThanOrEqual(deserialize(beforeReload.world).tick);
  await page.evaluate(() => window.tendril!.loop.pause());
  const beforeReset = await saved(page, '');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.click('#btn-reset');
  expect((await saved(page, '')).world).toBe(beforeReset.world);
  page.once('dialog', (dialog) => dialog.accept());
  await page.click('#btn-reset');
  await expect(page.locator('#hud-tick')).toHaveText('0');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'paused');
  expect((await saved(page, '')).logs).toEqual([]);
  const resetMeta = await page.evaluate(() => window.tendril!.sim.meta);
  expect(resetMeta.startedAtMs).toBeGreaterThan(meta.startedAtMs);
});
