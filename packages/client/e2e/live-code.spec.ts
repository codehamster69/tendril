import { test, expect, type Page } from '@playwright/test';
import { ready } from './game.ts';
import { dailyNumber, dailySeed, DAILY_PAR, BASE_RULES_VERSION } from '@tendril/sim/src/index.ts';

// Live code: edits equip while the farm runs, a typo leaves the farm running, and a mid-run edit on a rated day is stated plainly.

const pacer = 'while true:\n    move east\n    move west\n';
const sleeper = 'while true:\n    wait 5\n';
const running = (page: Page) => page.evaluate(() => window.tendril!.loop.runningSource);

async function farm(page: Page, source: string, url = '/?coach=0'): Promise<void> {
  await page.goto(url);
  await ready(page);
  await expect(page.locator('#status')).toHaveAttribute('data-state', /running|catching-up/);
  await page.evaluate((s) => { window.tendril!.editor.setSource(s); window.tendril!.loop.run(); }, source);
  await expect.poll(() => running(page)).toBe(source);
}

test('editing a running farm equips the new code by itself; comments do not; a typo keeps the last working code', async ({ page }) => {
  test.slow();
  await farm(page, pacer);
  const chip = page.locator('#equip-chip');
  await page.evaluate((s) => window.tendril!.editor.setSource(s), sleeper);
  // Applies on its own after the typing pause, without pressing Run.
  await expect.poll(() => running(page), { timeout: 5000 }).toBe(sleeper);
  await expect(chip).toContainText(/Equipped at tick \d/);
  await expect(chip).toHaveAttribute('data-state', 'equipped');
  await expect(page.locator('#status')).toHaveAttribute('data-state', /running|catching-up/);

  // A comment is not a change.
  await page.evaluate((s) => window.tendril!.editor.setSource(s), sleeper + '# a note for me\n');
  await page.waitForTimeout(1500);
  expect(await running(page)).toBe(sleeper);

  // A typo: the old program keeps running, the line is underlined, the chip says so once.
  const typo = 'while true:\n    wait 5\n    plant (\n';
  await page.evaluate((s) => window.tendril!.editor.setSource(s), typo);
  await expect(chip).toHaveText('Still running your last working code');
  await expect(page.locator('#editor')).toHaveAttribute('data-error-lines', /^3(,4)?$|^4$/);
  expect(await running(page)).toBe(sleeper);
  await expect(page.locator('#status')).toHaveAttribute('data-state', /running|catching-up/);
  const notes = await page.locator('#console').innerText();
  expect(notes.match(/Still running your last working code/g)?.length ?? 0).toBe(1);

  // Fixing it equips again.
  await page.evaluate((s) => window.tendril!.editor.setSource(s), pacer);
  await expect.poll(() => running(page), { timeout: 5000 }).toBe(pacer);
  await expect(chip).toContainText(/Equipped at tick/);
});

test('with "Apply code as I type" off, edits wait for Run', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('tendril.settings.v1', JSON.stringify({ liveCode: false })));
  await farm(page, pacer);
  await page.evaluate((s) => window.tendril!.editor.setSource(s), sleeper);
  await expect(page.locator('#equip-chip')).toHaveText('Edited · press Run to apply');
  await page.waitForTimeout(1500);
  expect(await running(page)).toBe(pacer);
  await page.evaluate(() => window.tendril!.loop.run());
  await expect.poll(() => running(page)).toBe(sleeper);
});

test('the setting is in the menu and defaults on', async ({ page }) => {
  await page.goto('/?coach=0');
  await ready(page);
  await page.click('#btn-menu');
  await page.click('#menu-overlay [data-entry="settings"]');
  const box = page.locator('#set-live-code');
  await expect(box).toBeChecked();
  await box.uncheck();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('tendril.settings.v1')!).liveCode)).toBe(false);
});

test('a rated day changed mid-run says so and offers a re-run of the final code from the start', async ({ page }) => {
  test.slow();
  const date = new Date().toISOString().slice(0, 10);
  const challenge = { id: `d-${date}`, kind: 'daily', number: dailyNumber(date), seed: dailySeed(date), ticks: 3000, par: DAILY_PAR, opensAt: Date.now() - 3_600_000, closesAt: Date.now() + 3_600_000, rulesVersion: BASE_RULES_VERSION, players: 41, best: 400 };
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/api/challenges/${challenge.id}`) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(challenge) });
    return route.fulfill({ status: path === '/api/me' ? 401 : 404, contentType: 'application/json', body: JSON.stringify({ error: 'not mocked' }) });
  });
  await page.goto('/?mode=daily');
  await ready(page);
  await page.evaluate((s) => { const t = window.tendril!; t.loop.setSpeed(8); t.editor.setSource(s); t.loop.run(); }, pacer);
  await expect.poll(() => page.evaluate(() => window.tendril!.sim.latest()?.tick ?? 0), { timeout: 20_000 }).toBeGreaterThan(40);
  await page.evaluate((s) => window.tendril!.editor.setSource(s), sleeper);
  await expect.poll(() => running(page), { timeout: 8000 }).toBe(sleeper);
  expect(await page.evaluate(() => window.tendril!.loop.editedMidRun)).toBe(true);
  await page.evaluate(() => window.tendril!.loop.pause());
  await page.click('#tp-sunset');
  const card = page.locator('.rs-card');
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card.locator('.rs-edited')).toContainText('You changed your code during this run');
  await card.locator('.rs-rerun').click();
  await expect(page.locator('.rs-layer')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.tendril!.loop.editedMidRun)).toBe(false);
  expect(await running(page)).toBe(sleeper);
});
