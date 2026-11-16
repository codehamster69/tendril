import { test, expect } from '@playwright/test';
import { BASE_RULES_VERSION } from '@tendril/sim/src/index.ts';

test('Esc opens and closes the menu, and every mode is two clicks away', async ({ page }) => {
  await page.goto('/?mode=sandbox');
  const menu = page.locator('#menu-overlay');
  await expect(menu).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(menu).toBeVisible();
  for (const id of ['continue', 'daily', 'season', 'live', 'sandbox', 'campaign', 'duels', 'seeds', 'profile', 'settings']) await expect(menu.locator(`[data-entry="${id}"]`)).toBeVisible();
  await expect(menu.locator('a[data-entry="sandbox"]')).toHaveAttribute('aria-current', 'page');
  await expect(menu.locator('a[data-entry="daily"]')).toHaveAttribute('href', '?mode=daily');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(page.locator('#mode-tabs')).toHaveCount(0);
});

test('settings persist across a reload and apply to the page', async ({ page }) => {
  await page.goto('/?mode=sandbox');
  await page.click('#btn-menu');
  await page.click('[data-entry="settings"]');
  await page.click('#settings-panel [aria-label="Graphics quality"] [data-value="low"]');
  await page.click('#settings-panel [aria-label="Reduced motion"] [data-value="reduced"]');
  await page.fill('#set-font', '18');
  await page.locator('#set-font').dispatchEvent('change');
  await expect(page.locator('html')).toHaveAttribute('data-quality', 'low');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-quality', 'low');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--editor-font'))).toBe('18px');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('tendril.settings.v1')!));
  expect(saved).toMatchObject({ quality: 'low', motion: 'reduced', fontSize: 18 });
});

test('the menu pauses a running local run and resumes it on close', async ({ page }) => {
  await page.goto('/?mode=sandbox');
  await expect(page.locator('#tp-play')).toBeEnabled();
  await page.click('#tp-play');
  await expect(page.locator('#tp-play')).toHaveAttribute('aria-label', 'Pause');
  await page.keyboard.press('Escape');
  await expect(page.locator('#tp-play')).toHaveAttribute('aria-label', 'Run');
  await page.keyboard.press('Escape');
  await expect(page.locator('#tp-play')).toHaveAttribute('aria-label', 'Pause');
});

test('a challenge opens with the start-of-day card and Enter starts the day', async ({ page }) => {
  const date = new Date().toISOString().slice(0, 10);
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/api/challenges/')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: `d-${date}`, kind: 'daily', number: 3, seed: 7, ticks: 3000, par: 300, opensAt: Date.now() - 1e6, closesAt: Date.now() + 1e6, rulesVersion: BASE_RULES_VERSION, players: 5, best: null }) });
    return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Sign in first.' }) });
  });
  await page.goto('/?mode=daily');
  const card = page.locator('#start-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Daily farm #3');
  await expect(card).toContainText('300 coins');
  await expect(card).toContainText('3,000 ticks');
  await page.keyboard.press('Enter');
  await expect(card).toBeHidden();
  await expect(page.locator('#tp-play')).toHaveAttribute('aria-label', 'Pause');
});
