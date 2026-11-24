import { test, expect, type Page } from '@playwright/test';
import { ready } from './game.ts';

// Dry run on a live farm: the editor's code runs on a private copy; the real farm only changes on Apply code.

const pacer = 'while true:\n    move east\n    move west\n';
const farmer = [
  'while true:',
  '    for each x in [1, 2, 3]:',
  '        go_to x, 0',
  '        if scan().ripe:',
  '            harvest',
  '        if scan().empty:',
  '            till',
  '            plant carrot',
  '    go_to barn',
  '    deposit',
  '    sell carrot, all',
  '    wait 20',
].join('\n');

async function liveFarmRunning(page: Page, source: string): Promise<void> {
  await page.goto('/?mode=live&coach=0');
  await ready(page);
  await expect(page.locator('#status')).toHaveAttribute('data-state', /running|catching-up/);
  await page.evaluate((s) => { window.tendril!.editor.setSource(s); window.tendril!.loop.run(); }, source);
  await expect.poll(() => page.evaluate(() => window.tendril!.loop.runningSource)).toBe(source);
}

const cell = (page: Page, row: string, col: 1 | 2) => page.locator('#dry-run .dr-table tbody tr', { has: page.locator(`th:text-is("${row}")`) }).locator('td').nth(col - 1);

test('dry run compares new code on a copy and only Apply code changes the farm', async ({ page }) => {
  test.slow(); // two simulated runs plus a software-rendered farm on a shared CPU
  await liveFarmRunning(page, pacer);
  await expect(page.locator('#tp-dryrun')).toBeEnabled();
  await page.evaluate((s) => window.tendril!.editor.setSource(s), farmer);

  const before = await page.evaluate(() => ({ prefix: window.tendril!.sim.prefix, seed: window.tendril!.sim.meta.seed, plots: window.tendril!.sim.latest()!.plots.length }));
  await page.click('#tp-dryrun');
  await expect(page.locator('#dry-run')).toBeVisible();
  await page.click('#dry-run .dr-span[data-ticks="3000"]');
  await page.click('#dry-run .dr-start');
  await expect(page.locator('#dry-run .dr-results')).toBeVisible();

  // The pacer walks all the time and earns nothing; the farmer earns and walks less.
  await expect(cell(page, 'Coins per 1,000 ticks', 1)).toHaveText('0');
  expect(Number((await cell(page, 'Coins per 1,000 ticks', 2).textContent())!.replace(/[^\d-]/g, ''))).toBeGreaterThan(0);
  expect(Number((await cell(page, 'Time spent walking', 1).textContent())!.replace('%', ''))).toBeGreaterThanOrEqual(95);
  expect(Number((await cell(page, 'Time spent walking', 2).textContent())!.replace('%', ''))).toBeLessThan(95);
  await expect(page.locator('#dry-run tr', { has: page.locator('th:text-is("Coins per 1,000 ticks")') })).toHaveAttribute('data-better', 'true');
  await expect(page.locator('#dry-run .dr-verdict')).toContainText('grows your farm faster');

  // Nothing on the real farm changed: same program, same save, the clock still running.
  const after = await page.evaluate(() => ({ prefix: window.tendril!.sim.prefix, seed: window.tendril!.sim.meta.seed, plots: window.tendril!.sim.latest()!.plots.length }));
  expect(after).toEqual(before);
  expect(await page.evaluate(() => window.tendril!.loop.runningSource)).toBe(pacer);
  await expect(page.locator('#status')).toHaveAttribute('data-state', /running|catching-up/);

  // Apply code puts the tested program on the farm.
  await page.click('#dry-run .dr-apply');
  await expect(page.locator('#dry-run')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.tendril!.loop.runningSource)).toBe(farmer);
});

test('dry run refuses broken code and stale results', async ({ page }) => {
  test.slow();
  await liveFarmRunning(page, pacer);
  await page.evaluate(() => window.tendril!.editor.setSource('while true\n    move east\n'));
  await page.click('#tp-dryrun');
  await page.click('#dry-run .dr-span[data-ticks="1000"]');
  await page.click('#dry-run .dr-start');
  await expect(page.locator('#dry-run .dr-verdict')).toContainText('has errors');
  await expect(page.locator('#dry-run .dr-apply')).toBeDisabled();
  await expect(page.locator('#dry-run .dr-hint').first()).toContainText('Line 1');

  // A good result goes stale once the editor changes.
  await page.evaluate((s) => window.tendril!.editor.setSource(s), farmer);
  await page.click('#dry-run .dr-again');
  await expect(page.locator('#dry-run .dr-apply')).toBeEnabled();
  await page.evaluate((s) => window.tendril!.editor.setSource(s + '\n# edited'), farmer);
  await expect(page.locator('#dry-run .dr-apply')).toBeDisabled();
  await expect(page.locator('#dry-run .dr-note')).toContainText('editor has changed');
  await page.focus('#dry-run .dr-again');
  await page.keyboard.press('Escape');
  await expect(page.locator('#dry-run')).toBeHidden();
  expect(await page.evaluate(() => window.tendril!.loop.runningSource)).toBe(pacer);
});
