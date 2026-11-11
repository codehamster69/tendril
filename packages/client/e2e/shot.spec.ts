import { test } from '@playwright/test';

// Only runs when SHOT=1: pnpm exec playwright test shot --trace off
test('screenshot', async ({ page }) => {
  test.skip(!process.env.SHOT, 'set SHOT=1');
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/');
  await page.selectOption('#speed', '16');
  await page.click('#btn-run');
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'e2e/screenshot.png' });
});
