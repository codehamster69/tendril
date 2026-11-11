import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

const expander = readFileSync(new URL('../../lang/examples/expander.sprout', import.meta.url), 'utf8');

// Only runs when SHOT=1: SHOT=1 pnpm exec playwright test shot --trace off
test('screenshot', async ({ page }) => {
  test.skip(!process.env.SHOT, 'set SHOT=1');
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/?mode=sandbox');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'paused');
  await page.evaluate((source) => window.tendril!.editor.setSource(source), expander);
  await page.selectOption('#speed', '64');
  await page.click('#btn-run');
  await page.waitForTimeout(60_000);
  await page.screenshot({ path: 'e2e/screenshot.png' });
});
