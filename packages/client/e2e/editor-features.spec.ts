import { test, expect, type Page } from '@playwright/test';
import { ready, press } from './game.ts';

async function sandbox(page: Page): Promise<void> {
  await page.goto('/?mode=sandbox');
  await ready(page);
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'paused');
}
const setSource = (page: Page, source: string) => page.evaluate((s) => window.tendril!.editor.setSource(s), source);

test('tick column shows what each line spent, with the costliest line marked', async ({ page }) => {
  await sandbox(page);
  await setSource(page, 'repeat forever:\n    till\n    wait 50\n    move east\n');
  await page.locator('#speed').evaluate((el: HTMLSelectElement) => { el.value = '16'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await press(page, '#btn-run');
  const hot = page.locator('#editor .cm-tick-gutter .cm-tick-hot');
  await expect(hot).toHaveCount(1);
  await expect(hot).toHaveText(/^\d+$/);
  expect(Number(await hot.textContent())).toBeGreaterThanOrEqual(50);
  await press(page, '#btn-pause');
  // Editing a line clears its number.
  await page.evaluate(() => window.tendril!.editor.setSource('repeat forever:\n    till\n    wait 51\n    move east\n'));
  await expect(page.locator('#editor .cm-tick-gutter .cm-tick-hot')).toHaveCount(0);
});

test('an unknown name shows its message under the line with a Fix button', async ({ page }) => {
  await sandbox(page);
  await setSource(page, 'repeat forever:\n    till\n    plant carot\n');
  await press(page, '#btn-run');
  const msg = page.locator('#editor .cm-err-line');
  await expect(msg).toContainText("I don't know what `carot` means");
  await msg.locator('.cm-fix-btn').click();
  expect(await page.evaluate(() => window.tendril!.editor.getSource())).toBe('repeat forever:\n    till\n    plant carrot\n');
  await expect(msg).toHaveCount(0);
});

test('editor settings: theme, tick column and tab width persist across a reload', async ({ page }) => {
  await sandbox(page);
  await page.locator('.editor-footer > .ed-settings-btn').click();
  await page.selectOption('#ed-theme', 'field');
  await page.selectOption('#ed-tab', '2');
  await page.uncheck('#ed-ticks');
  await expect(page.locator('#editor')).toHaveAttribute('data-theme', 'field');
  await expect(page.locator('#editor .cm-tick-gutter')).toHaveCount(0);
  await page.reload();
  await ready(page);
  await expect(page.locator('#editor')).toHaveAttribute('data-theme', 'field');
  await expect(page.locator('#editor .cm-tick-gutter')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('tendril.editor.v1'))).toBe('{"theme":"field","tabWidth":2,"tickColumn":false}');
});

test('blocks fold and Ctrl+D adds the next match as another cursor', async ({ page }) => {
  await sandbox(page);
  await setSource(page, 'repeat forever:\n    till\n    wait 5\nmove east\n');
  await page.locator('#editor .cm-foldGutter .cm-gutterElement').nth(1).click();
  await expect(page.locator('#editor .cm-foldPlaceholder')).toHaveCount(1);
  await setSource(page, 'carrot a\ncarrot b\n');
  await page.locator('#editor .cm-content').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Shift+Control+ArrowRight');
  await page.keyboard.press('Control+d');
  await page.keyboard.type('wheat');
  expect(await page.evaluate(() => window.tendril!.editor.getSource())).toBe('wheat a\nwheat b\n');
});
