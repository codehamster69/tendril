import { test, expect } from '@playwright/test';

test('first visit: three prompts on the real controls, ending on the first sale, never shown again', async ({ page }) => {
  await page.goto('/?mode=live&ranked=0');
  await expect(page.locator('#splash')).toHaveCount(0, { timeout: 30_000 });
  const card = page.locator('.fr-card');
  await expect(card).toContainText('Give your bot a program');
  expect(await page.evaluate(() => window.tendril!.editor.getSource())).toBe('');
  await card.getByRole('button', { name: 'Use the starter' }).click();
  expect(await page.evaluate(() => window.tendril!.editor.getSource())).toContain('plant carrot');
  await expect(card).toContainText('Press Play');
  await expect(page.locator('#tp-play')).toHaveClass(/fr-spot/);
  await expect(page.locator('#tp-play')).toBeEnabled();
  await page.click('#tp-play');
  await expect(card).toContainText('Watch the first harvest');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('tendril:events', { detail: [[1, 1, 0, 0, 0]] })));
  await expect(card).toContainText('Now it sells');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('tendril:events', { detail: [[2, 2, 0, 1, 5]] })));
  await expect(card).toHaveCount(0);
  await page.reload();
  await expect(page.locator('#splash')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator('.fr-card')).toHaveCount(0);
});

test('skipping the tour loads the starter and is remembered', async ({ page }) => {
  await page.goto('/?mode=live&ranked=0');
  await expect(page.locator('.fr-card')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Skip tour' }).click();
  await expect(page.locator('.fr-card')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('tendril.firstrun.v1'))).toBe('done');
});

test('existing storage: saved program is untouched and no tour appears', async ({ page }) => {
  await page.addInitScript(() => { if (!localStorage.getItem('tendril.sprout.v1.live')) localStorage.setItem('tendril.sprout.v1.live', 'move west\n'); });
  await page.goto('/?mode=live&ranked=0');
  await expect(page.locator('#splash')).toHaveCount(0, { timeout: 30_000 });
  expect(await page.evaluate(() => window.tendril!.editor.getSource())).toBe('move west\n');
  await expect(page.locator('.fr-card')).toHaveCount(0);
});
