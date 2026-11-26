import { test, expect, type Page } from '@playwright/test';
import { ready } from './game.ts';
import { createWorld, hashWorld, netWorth, serialize, BASE_RULES_VERSION } from '@tendril/sim/src/index.ts';

const HOUR = 3_600_000;
const profile = { id: 'u1', login: 'octo', displayName: 'Octo Cat', avatarUrl: null };
const SHOTS = process.env.SHOTS ?? '';

const seller = `repeat forever:
    for each tile in tiles():
        if tile.x % bots() == my_id():
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
const broken = `wait 50
say 1 / 0
`;

async function openFarm(page: Page, hoursAway: number, program: string): Promise<{ wakes: unknown[] }> {
  const startedAtMs = Date.now() - hoursAway * HOUR;
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
    if (path === '/api/players/octo') return json(200, { streak: { current: 5, best: 9, lastDay: '2026-11-23' } });
    if (path === '/api/farms/me') return json(200, farm());
    if (path === '/api/farms/wake') {
      wakes.push(route.request().postDataJSON());
      const excess = Math.max(0, Date.now() - startedAtMs - restedMs - world.tick * 100 - 6 * HOUR);
      restedMs += excess;
      return json(200, { ...farm(), restedNowMs: excess });
    }
    return json(404, { error: 'not mocked' });
  });
  await page.addInitScript((src) => { localStorage.setItem('tendril.signedin', '1'); localStorage.setItem('tendril.sprout.v1.live', src); }, program);
  await page.goto('/?mode=live');
  await ready(page);
  return { wakes };
}

test('a farm opened after 3 hours shows what happened while away', async ({ page }) => {
  test.setTimeout(120_000);
  await openFarm(page, 3, seller);
  const card = page.locator('#away-card');
  await expect(card).toBeVisible({ timeout: 90_000 });
  await expect(card).toContainText('While you were away (3 h');
  await expect(card).toContainText(/\+[\d,]+ coins/);
  await expect(card).toContainText('carrots sold');
  await expect(card).toContainText('5-day streak');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/away-desktop.png` });
  await card.getByRole('button', { name: 'Close' }).click();
  await expect(card).toHaveCount(0);
});

test('a bot that stopped is named, with a button to its line', async ({ page }) => {
  test.setTimeout(120_000);
  await openFarm(page, 2, broken);
  const card = page.locator('#away-card');
  await expect(card).toBeVisible({ timeout: 90_000 });
  await expect(card).toContainText(/Bot 0 stopped at line 2 at tick [\d,]+/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/away-error.png` });
  await card.getByRole('button', { name: 'Show line 2' }).click();
});

test('a farm gone for 8 hours says it stopped growing', async ({ page }) => {
  test.setTimeout(150_000);
  await openFarm(page, 8, seller);
  const card = page.locator('#away-card');
  await expect(card).toBeVisible({ timeout: 120_000 });
  await expect(card).toContainText(/stopped growing 2 h/);
});

test('a farm opened within minutes shows no card', async ({ page }) => {
  await openFarm(page, 0.05, seller);
  await page.waitForTimeout(3000);
  await expect(page.locator('#away-card')).toHaveCount(0);
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('the card fits a phone and the menu shows the streak', async ({ page }) => {
    test.setTimeout(120_000);
    await openFarm(page, 3, seller);
    const card = page.locator('#away-card');
    await expect(card).toBeVisible({ timeout: 90_000 });
    await expect(card).toContainText('5-day streak');
    const box = (await card.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/away-phone.png` });
    await page.click('#btn-menu');
    await expect(page.locator('#menu-streak')).toContainText('5-day streak');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/menu-streak-phone.png` });
  });
});
