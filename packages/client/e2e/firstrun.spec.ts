import { test, expect } from '@playwright/test';

test('first visit: empty editor, coach panel, finishing offers the starter and today\'s farm', async ({ page }) => {
  await page.goto('/?mode=live&ranked=0');
  await expect(page.locator('#lesson-card')).toContainText('Make your bot plant a carrot');
  expect(await page.evaluate(() => window.tendril!.editor.getSource())).toBe('');
  await page.evaluate(() => window.tendril!.editor.setSource('move east\ntill\nplant carrot\n'));
  await expect(page.locator('.coach-steps li.done')).toHaveCount(3);
  await page.click('#btn-run');
  await expect(page.locator('#lesson-card')).toContainText('You wrote a program', { timeout: 20_000 });
  await expect(page.locator('#lesson-card a.next-lesson')).toHaveAttribute('href', '?mode=daily');
  await page.click('#lesson-card >> text=Load the starter example');
  expect(await page.evaluate(() => window.tendril!.editor.getSource())).toContain('plant');
  await page.reload();
  await expect(page.locator('#lesson-card')).toBeHidden();
});

test('existing storage: saved program is untouched and no coach appears', async ({ page }) => {
  await page.addInitScript(() => { if (!localStorage.getItem('tendril.sprout.v1.live')) localStorage.setItem('tendril.sprout.v1.live', 'move west\n'); });
  await page.goto('/?mode=live&ranked=0');
  await expect(page.locator('#btn-run')).toBeVisible();
  expect(await page.evaluate(() => window.tendril!.editor.getSource())).toBe('move west\n');
  await expect(page.locator('#lesson-card')).toBeHidden();
});
