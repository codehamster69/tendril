import { test, expect } from '@playwright/test';
import { API } from '@tendril/lang/src/index.ts';

for (const mode of ['sandbox', 'live']) {
  test(`API reference and instruments in ${mode}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`/?mode=${mode}`);
    await expect(page.locator('#farm-inspector')).toBeVisible();
    await page.locator('#btn-reference').click();
    const reference = page.locator('#api-reference');
    await expect(reference).toBeVisible();
    await expect(reference.locator('.api-entry')).toHaveCount(API.length);
    await reference.getByRole('searchbox').fill('move');
    await expect(reference.locator('.api-entry:visible')).toHaveCount(1);
    await expect(reference.locator('.api-entry:visible')).toHaveAttribute('data-function', 'move');
    await expect(reference.locator('.api-entry:visible .api-cost')).toHaveText('2 ticks');
    await reference.getByRole('searchbox').fill('wait');
    await expect(reference.locator('.api-entry:visible .api-cost')).toHaveText('n ticks');
    await page.keyboard.press('Escape');
    await expect(reference).not.toBeVisible();
    await page.locator('#soil-overlay').selectOption('nitrogen');
    await expect(page.locator('#soil-overlay')).toHaveValue('nitrogen');
    await page.locator('#btn-focus-farm').click();
    expect(errors).toEqual([]);
  });
}
