import { test, expect } from '@playwright/test';

test('canvas is not blank', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(1500);
  const buf = await page.locator('#farm-canvas').screenshot();
  const colours = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const set = new Set<number>();
    for (let i = 0; i < d.length; i += 4) set.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    return set.size;
  }, buf.toString('base64'));
  expect(colours).toBeGreaterThan(50);
});

test('monaco suggests bot functions', async ({ page }) => {
  await page.goto('/');
  const editor = page.locator('#editor .monaco-editor');
  await expect(editor).toBeVisible();
  await page.locator('#editor .view-lines').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('bot.');
  await expect(page.locator('.suggest-widget .monaco-list-row', { hasText: 'move' }).first()).toBeVisible();
});

test('run increases tick, pause stops it', async ({ page }) => {
  await page.goto('/');
  const tick = async () => Number(await page.locator('#hud-tick').textContent());
  expect(await tick()).toBe(0);
  await page.click('#btn-run');
  await expect.poll(tick, { timeout: 3000 }).toBeGreaterThan(0);
  await page.click('#btn-pause');
  await page.waitForTimeout(300);
  const a = await tick();
  await page.waitForTimeout(700);
  expect(await tick()).toBe(a);
});

test('no console errors on load', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  await page.waitForTimeout(1500);
  expect(errors).toEqual([]);
});
