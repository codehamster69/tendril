import { test, expect } from '@playwright/test';
import { BASE_RULES_VERSION } from '@tendril/sim/src/index.ts';

test('Esc opens and closes the menu, and every mode is two clicks away', async ({ page }) => {
  await page.goto('/?mode=sandbox');
  const menu = page.locator('#menu-overlay');
  await expect(menu).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(menu).toBeVisible();
  for (const id of ['continue', 'daily', 'season', 'live', 'sandbox', 'campaign', 'duels', 'catalogue', 'profile', 'settings']) await expect(menu.locator(`[data-entry="${id}"]`)).toBeVisible();
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

// Each setting must change the game, not just the stored record (task U5 wiring).
const openSettings = async (page: import('@playwright/test').Page): Promise<void> => {
  await page.click('#btn-menu');
  await page.click('[data-entry="settings"]');
  await expect(page.locator('#settings-panel')).toBeVisible();
};

test('graphics quality changes the renderer at once: Low drops shadows and resolution, High restores them', async ({ page }) => {
  await page.goto('/?mode=sandbox');
  const canvas = page.locator('#farm-canvas');
  await expect(canvas).toHaveAttribute('data-scene-ready', 'true');
  await expect(canvas).toHaveAttribute('data-quality', 'auto');
  await expect(canvas).toHaveAttribute('data-shadows', 'true');
  await openSettings(page);
  await page.click('#settings-panel [aria-label="Graphics quality"] [data-value="low"]');
  await expect(canvas).toHaveAttribute('data-quality', 'low');
  await expect(canvas).toHaveAttribute('data-shadows', 'false');
  await expect(canvas).toHaveAttribute('data-max-ratio', '1');
  await page.click('#settings-panel [aria-label="Graphics quality"] [data-value="high"]');
  await expect(canvas).toHaveAttribute('data-quality', 'high');
  await expect(canvas).toHaveAttribute('data-shadows', 'true');
  // A reload starts the renderer at the saved quality.
  await page.reload();
  await expect(canvas).toHaveAttribute('data-scene-ready', 'true');
  await expect(canvas).toHaveAttribute('data-quality', 'high');
});

test('Sound off and Volume drive the game audio', async ({ page }) => {
  await page.goto('/?mode=sandbox');
  await openSettings(page); // the clicks unlock audio
  const gain = (): Promise<string | undefined> => page.evaluate(() => document.documentElement.dataset.soundGain);
  await expect.poll(gain).toBe('0.6');
  await page.locator('#set-volume').fill('25');
  await expect.poll(gain).toBe('0.25');
  await page.click('#set-muted');
  await expect.poll(gain).toBe('0');
  await page.click('#set-muted');
  await expect.poll(gain).toBe('0.25');
  // The saved volume is used after a reload too.
  await page.reload();
  await page.click('#btn-menu');
  await expect.poll(gain).toBe('0.25');
});

test('Reduced motion follows the setting, and Off overrides a system that asks for reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?mode=sandbox');
  const html = page.locator('html');
  const transition = (): Promise<string> => page.locator('#btn-menu').evaluate((b) => getComputedStyle(b).transitionDuration);
  await expect(html).toHaveAttribute('data-motion', 'reduced');
  await expect.poll(transition).toMatch(/^0s(, 0s)*$/);
  await openSettings(page);
  await page.click('#settings-panel [aria-label="Reduced motion"] [data-value="full"]');
  await expect(html).toHaveAttribute('data-motion', 'full');
  await expect.poll(transition).not.toMatch(/^0s(, 0s)*$/);
  await page.click('#settings-panel [aria-label="Reduced motion"] [data-value="reduced"]');
  await expect(html).toHaveAttribute('data-motion', 'reduced');
  await expect.poll(transition).toMatch(/^0s(, 0s)*$/);
});

test('editor font size resizes the code', async ({ page }) => {
  await page.goto('/?mode=sandbox');
  const size = (): Promise<string> => page.locator('.cm-content').first().evaluate((c) => getComputedStyle(c).fontSize);
  await expect.poll(size).toBe('14px');
  await openSettings(page);
  await page.fill('#set-font', '18');
  await page.locator('#set-font').dispatchEvent('change');
  await expect.poll(size).toBe('18px');
});

test('a first visit lands on the start card; "?" lists the shortcuts; Things to try can be hidden', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#splash')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.locator('#start-card')).toBeVisible();
  await expect(page.locator('#mode-label')).toContainText(/daily|practice/i);
  await page.keyboard.press('Escape'); // closes the card without starting the day
  await expect(page.locator('#start-card')).toBeHidden();
  await page.keyboard.press('?');
  await expect(page.locator('#panel-overlay .keys-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.click('#btn-menu');
  const tryIt = page.locator('#menu-overlay .try-it');
  await expect(tryIt.locator('.menu-entry')).toHaveCount(3);
  await tryIt.getByRole('button', { name: 'Hide' }).click();
  await expect(tryIt).toBeHidden();
  await page.reload(); // second visit: no more first-visit redirect, and the list stays hidden
  await expect(page.locator('#splash')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.locator('#mode-label')).toContainText(/Local live/);
});
