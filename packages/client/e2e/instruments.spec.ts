import { test, expect } from '@playwright/test';

for (const mode of ['sandbox', 'live']) {
  test(`API reference and instruments in ${mode}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`/?mode=${mode}`);
    await expect(page.locator('#farm-inspector')).toBeVisible();
    await page.locator('#btn-reference').click();
    const reference = page.locator('#api-reference');
    await expect(reference).toBeVisible();
    await expect(reference.locator('.api-entry')).toHaveCount(30);
    await reference.getByRole('searchbox').fill('bot.move');
    await expect(reference.locator('.api-entry:visible')).toHaveCount(1);
    await expect(reference.locator('.api-entry:visible .api-cost')).toHaveText('2 ticks');
    await reference.getByRole('searchbox').fill('bot.wait');
    await expect(reference.locator('.api-entry:visible .api-cost')).toHaveText('n ticks (1–1000)');
    await page.keyboard.press('Escape');
    await expect(reference).not.toBeVisible();
    await page.locator('#soil-overlay').selectOption('nitrogen');
    await expect(page.locator('#soil-overlay')).toHaveValue('nitrogen');
    await page.locator('#btn-focus-farm').click();
    expect(errors).toEqual([]);
  });
}
