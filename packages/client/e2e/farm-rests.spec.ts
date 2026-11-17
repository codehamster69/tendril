import { test, expect } from '@playwright/test';
import { ready } from './game.ts';
import { createWorld, hashWorld, netWorth, serialize, BASE_RULES_VERSION } from '@tendril/sim/src/index.ts';

const HOUR = 3_600_000;
const profile = { id: 'u1', login: 'octo', displayName: 'Octo Cat', avatarUrl: null };

test('a farm 58 hours behind is rested down to 6 hours when it opens', async ({ page }) => {
  const startedAtMs = Date.now() - 58 * HOUR;
  const world = createWorld({ id: 'farm-1', seed: 7 });
  let restedMs = 0;
  const wakes: unknown[] = [];
  const farm = () => ({
    id: 'farm-1', seed: 7, startedAtMs, restedMs, tick: world.tick, checkpoint: serialize(world),
    checkpointHash: hashWorld(world), rulesVersion: BASE_RULES_VERSION, coins: world.coins, netWorth: netWorth(world),
  });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/me') return json(200, { profile });
    if (path === '/api/farms/me') return json(200, farm());
    if (path === '/api/farms/wake') {
      wakes.push(route.request().postDataJSON());
      // Same arithmetic as the server's wakeFarm.
      const behind = Date.now() - startedAtMs - restedMs - world.tick * 100;
      const excess = Math.max(0, behind - 6 * HOUR);
      restedMs += excess;
      return json(200, { ...farm(), restedNowMs: excess });
    }
    return json(404, { error: 'not mocked' });
  });
  await page.addInitScript(() => localStorage.setItem('tendril.signedin', '1'));
  await page.goto('/?mode=live');
  await ready(page);
  expect(wakes).toEqual([{ atTick: 0 }]);
  await expect(page.getByText('Your farm rested')).toBeVisible();
  await expect(page.getByText(/rested for 52 hours/)).toBeVisible();
  const behindTicks = await page.evaluate(() => {
    const t = (window as unknown as { tendril: { sim: { meta: { startedAtMs: number; restedMs?: number }; latest(): { tick: number } | null } } }).tendril;
    return { rested: t.sim.meta.restedMs, target: Math.floor((Date.now() - t.sim.meta.startedAtMs - (t.sim.meta.restedMs ?? 0)) / 100), tick: t.sim.latest()?.tick ?? 0 };
  });
  expect(Math.abs(behindTicks.rested! - 52 * HOUR)).toBeLessThan(120_000); // 58h at test start, a few seconds of boot since
  expect(behindTicks.target).toBeGreaterThan(215_000);
  expect(behindTicks.target).toBeLessThan(217_500);
});
