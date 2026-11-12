import { test, expect, type Page } from '@playwright/test';
import { createWorld, deserialize, hashWorld, replayChunk } from '@tendril/sim/src/index.ts';
import type { LogChunk } from '../src/real-sim';

async function sandbox(page: Page): Promise<void> {
  await page.goto('/?mode=sandbox');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'paused');
}

async function saved(page: Page, prefix = 'sprout.v1.sandbox.'): Promise<{ world: string; logs: LogChunk[]; hash: string; source: string }> {
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

const harvest = `# One restart-safe tile, one complete sale.
go_to 1, 0
if scan().empty:
    till
    plant carrot
while not scan().ripe:
    wait 10
harvest
go_to barn
deposit
sell carrot, all
say "carrots sold", coins()
repeat forever:
    wait 100
`;

const idle = 'repeat forever:\n    wait 1\n';

test('golden path uses Sprout, sells crops, checkpoints, replays and survives restart', async ({ page }) => {
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
    window.tendril!.editor.setSource('say "edited", tick()\nrepeat forever:\n    wait 1\n');
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

test('syntax and runtime errors show useful console text and the correct Sprout line', async ({ page }) => {
  await sandbox(page);
  await page.evaluate(() => window.tendril!.editor.setSource('# first line\nplnat carrot'));
  await page.click('#btn-run');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'error');
  await expect(page.locator('#editor')).toHaveAttribute('data-error-lines', '2');
  await expect(page.locator('#console .err').first()).toContainText('Line 2');
  await expect(page.locator('#console .err').first()).toContainText('plnat');
  await expect(page.locator('#hud-tick')).toHaveText('0');

  await page.evaluate(() => window.tendril!.editor.setSource('# first line\nmove "diagonal"'));
  await page.click('#btn-run');
  await expect(page.locator('#console')).toContainText('Bot 0 · line 2');
  await expect(page.locator('#console')).toContainText('Move north, east, south or west.');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'error');
  await expect(page.locator('#editor')).toHaveAttribute('data-error-lines', '2');
  await page.evaluate((source) => window.tendril!.editor.setSource(source), idle);
  await page.click('#btn-run');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'running');
  await expect(page.locator('#editor')).toHaveAttribute('data-error-lines', '');
  await page.click('#btn-pause');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'paused');
});

test('pause cancels a run that is still compiling the program', async ({ page }) => {
  await sandbox(page);
  await page.evaluate(() => {
    const sim = window.tendril!.sim;
    const original = sim.setSource.bind(sim);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    sim.setSource = async (source) => { await gate; await original(source); };
    window.addEventListener('test:release-compile', () => release(), { once: true });
  });
  await page.evaluate((source) => window.tendril!.editor.setSource(source), idle);
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
    tx.objectStore('kv').delete('sprout.v1.sandbox.meta');
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
    await loop.setSource('repeat forever:\n    wait 1\n');
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
    await loop.setSource('repeat forever:\n    wait 1\n');
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
  await expect(page.locator('#speed')).toBeHidden();
  await expect(page.locator('#speed-label')).toHaveText('Live farms run in real time');
  await page.evaluate(() => window.tendril!.loop.setSpeed(64)); // Even asked directly, speed cannot mint ticks.
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
  const beforeReload = await saved(page, 'sprout.v1.live.');
  await page.reload();
  await expect(page.locator('#status')).toHaveAttribute('data-state', /running|catching-up/);
  expect(await page.evaluate(() => window.tendril!.sim.meta)).toEqual(meta);
  expect(Number(await page.locator('#hud-tick').textContent())).toBeGreaterThanOrEqual(deserialize(beforeReload.world).tick);
  await page.evaluate(() => window.tendril!.loop.pause());
  const beforeReset = await saved(page, 'sprout.v1.live.');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.click('#btn-reset');
  expect((await saved(page, 'sprout.v1.live.')).world).toBe(beforeReset.world);
  page.once('dialog', (dialog) => dialog.accept());
  await page.click('#btn-reset');
  await expect(page.locator('#hud-tick')).toHaveText('0');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'paused');
  expect((await saved(page, 'sprout.v1.live.')).logs).toEqual([]);
  const resetMeta = await page.evaluate(() => window.tendril!.sim.meta);
  expect(resetMeta.startedAtMs).toBeGreaterThan(meta.startedAtMs);
});

async function gutterClick(page: Page, line: number): Promise<void> {
  await page.locator('#editor .margin-view-overlays .line-numbers', { hasText: new RegExp(`^${line}$`) }).click();
}

test('a breakpoint pauses a bot at the chosen line and stepLine advances one line', async ({ page }) => {
  await sandbox(page);
  await page.evaluate(() => window.tendril!.editor.setSource('x = 1\ny = x + 1\nrepeat forever:\n    z = y + 1\n    wait 1\n'));
  await gutterClick(page, 4);
  await expect(page.locator('#editor')).toHaveAttribute('data-breakpoints', '4');
  await page.selectOption('#speed', '64');
  await page.click('#btn-run');
  await expect(page.locator('#status')).toContainText('bot 0 on line 4');
  await expect(page.locator('#debugger .bot.paused')).toContainText('line 4');
  expect(await page.evaluate(() => window.tendril!.loop.debug()[0]!.line)).toBe(4);
  expect(await page.evaluate(() => window.tendril!.loop.debug()[0]!.status)).toBe('paused');
  const tick = await page.locator('#hud-tick').textContent();
  await page.waitForTimeout(400); // Paused means paused: nothing advances.
  await expect(page.locator('#hud-tick')).toHaveText(tick!);
  await page.click('#btn-step-line');
  await expect(page.locator('#status')).toContainText('bot 0 on line 5');
  expect(await page.evaluate(() => window.tendril!.loop.debug()[0]!.line)).toBe(5);
  await expect(page.locator('#hud-tick')).toHaveText(tick!);
  // Removing the breakpoint and running continues past line 4 without pausing again.
  await gutterClick(page, 4);
  await expect(page.locator('#editor')).toHaveAttribute('data-breakpoints', '');
  await page.click('#btn-run');
  await expect.poll(async () => Number(await page.locator('#hud-tick').textContent())).toBeGreaterThan(Number(tick) + 20);
  await page.click('#btn-pause');
});

test('stopping inside a tick keeps the saved log replayable and loses no action', async ({ page }) => {
  await sandbox(page);
  // buy_plot is an instant farm action logged at tick 0 before the breakpoint on line 2 stops the world mid-tick.
  await page.evaluate(() => window.tendril!.loop.startScenario({
    kind: 'sandbox', setup: { coins: 1000 }, seed: 7, source: 'buy_plot 1, 0\nsay "after"\nrepeat forever:\n    wait 1\n',
  }));
  await expect(page.locator('#hud-coins')).toHaveText('1,000');
  await gutterClick(page, 2);
  await page.click('#btn-run');
  await expect(page.locator('#status')).toContainText('bot 0 on line 2');
  expect(await page.evaluate(() => window.tendril!.loop.snapshot()!.plots.length)).toBe(2);
  const midTick = await saved(page);
  expect(deserialize(midTick.world).plots.length).toBe(1); // The unfinished tick is not a checkpoint.
  await gutterClick(page, 2);
  await page.click('#btn-step');
  await expect(page.locator('#hud-tick')).toHaveText('100');
  await page.evaluate(() => window.tendril!.sim.flush());
  const checkpoint = await saved(page);
  const world = deserialize(checkpoint.world);
  expect(world.plots).toHaveLength(2);
  const replay = createWorld({ id: world.id, seed: world.seed }, { coins: 1000 });
  for (const chunk of checkpoint.logs) {
    expect(replay.tick).toBe(chunk.fromTick);
    expect(hashWorld(replay)).toBe(chunk.fromHash);
    replayChunk(replay, chunk.actions, chunk.toTick);
    expect(hashWorld(replay)).toBe(chunk.hash);
  }
  expect(hashWorld(replay)).toBe(hashWorld(world));
});

test('a compile error marks the right line and the farm keeps running the previous program', async ({ page }) => {
  await sandbox(page);
  await page.evaluate((source) => window.tendril!.editor.setSource(source), idle);
  await page.selectOption('#speed', '64');
  await page.click('#btn-run');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'running');
  const diagnostics = await page.evaluate(() => window.tendril!.loop.setSource('repeat forever:\n    wait 1\nplnat carrot\n'));
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ line: 3, severity: 'error' });
  expect(diagnostics[0]!.message).toContain('plnat');
  await expect(page.locator('#editor')).toHaveAttribute('data-error-lines', '3');
  await expect(page.locator('#console .err').first()).toContainText('Line 3');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'running');
  const tick = Number(await page.locator('#hud-tick').textContent());
  await expect.poll(async () => Number(await page.locator('#hud-tick').textContent())).toBeGreaterThan(tick + 20);
  // The bot is still executing the last good program (line 2), not an empty one.
  expect(await page.evaluate(() => window.tendril!.loop.debug()[0]!.status)).not.toBe('done');
  await page.click('#btn-pause');
});
