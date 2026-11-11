import { test, expect } from '@playwright/test';

// Playwright supplies a fresh context (including IndexedDB) per test.
test.beforeEach(async ({ page }) => {
  await page.goto('/?mode=sandbox');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'paused');
});

test('greenhouse loads a real farm and a nonblank canvas', async ({ page }, testInfo) => {
  await expect(page.locator('#mode-label')).toHaveText('Sandbox');
  await expect(page.locator('#hud-tick')).toHaveText('0');
  await expect(page.locator('#editor .monaco-editor')).toBeVisible();
  const buf = await page.locator('#farm-canvas').screenshot({ animations: 'disabled' });
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
  // Screenshot is observational, not a pixel golden: the renderer has an animated bot.
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.click('#btn-step');
  await expect(page.locator('#hud-tick')).toHaveText('100');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'paused');
  await page.screenshot({ path: testInfo.outputPath('greenhouse.png'), fullPage: true, animations: 'disabled' });
});

test('monaco suggests bot functions', async ({ page }) => {
  await page.getByRole('textbox', { name: 'Farm Lua program' }).focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('bot.');
  await expect(page.locator('.suggest-widget .monaco-list-row', { hasText: 'move' }).first()).toBeVisible();
});

test('sandbox steps exactly 100, runs at selected speed and pauses durably', async ({ page }) => {
  await page.click('#btn-step');
  await expect(page.locator('#hud-tick')).toHaveText('100');
  await expect(page.locator('#save-status')).toHaveText('Saved locally · tick 100');
  await page.selectOption('#speed', '64');
  await page.click('#btn-run');
  await expect.poll(async () => Number(await page.locator('#hud-tick').textContent())).toBeGreaterThan(110);
  await page.click('#btn-pause');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'paused');
  const tick = await page.locator('#hud-tick').textContent();
  await page.waitForTimeout(500); // Deliberately prove no new ticks while paused.
  await expect(page.locator('#hud-tick')).toHaveText(tick!);
  await expect(page.locator('#save-status')).toHaveText(`Saved locally · tick ${tick}`);
});

test('examples edit the Lua without resetting or starting the farm', async ({ page }) => {
  await page.click('#btn-step');
  await expect(page.locator('#hud-tick')).toHaveText('100');
  page.once('dialog', (dialog) => dialog.accept());
  await page.selectOption('#examples', 'expander.lua');
  expect(await page.evaluate(() => window.tendril!.editor.getSource())).toContain('farm.buy_plot');
  await expect(page.locator('#hud-tick')).toHaveText('100');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'paused');
  await page.reload();
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'paused');
  expect(await page.evaluate(() => window.tendril!.editor.getSource())).toContain('farm.buy_plot');
  await expect(page.locator('#hud-tick')).toHaveText('100');
});

test('mobile layout stays usable with keyboard focus and reduced motion', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('#farm-canvas')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator('#btn-run').focus();
  await expect(page.locator('#btn-run')).toBeFocused();
  expect(await page.locator('#btn-run').evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
  await page.screenshot({ path: testInfo.outputPath('greenhouse-mobile.png'), fullPage: true, animations: 'disabled' });
});

test('real worker loads without browser errors', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/?mode=sandbox');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'paused');
  await page.click('#btn-step');
  await expect(page.locator('#hud-tick')).toHaveText('100');
  expect(errors).toEqual([]);
  await context.close();
});
