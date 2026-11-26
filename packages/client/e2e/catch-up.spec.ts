import { test, expect, type Page } from '@playwright/test';
import { ready } from './game';

/** A farm that grows itself: the first bot buys bots and plots whenever it can, all bots farm. */
const grower = `repeat forever:
    if my_id() == 0:
        while bots() < 60 and coins() >= bot_cost():
            buy_bot
        while len(plots()) < 40 and coins() >= plot_cost():
            n = len(plots())
            buy_plot n % 8, (n - n % 8) / 8
    for each tile in tiles():
        if tile.x % bots() == my_id():
            go_to tile
            if scan().ripe:
                harvest
            if scan().empty:
                till
                plant carrot
    go_to barn
    deposit
    sell carrot, all
    wait 5
`;

/** The page's clock runs ahead by an offset kept in sessionStorage, so a reload keeps the same "time away". */
async function offsetClock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const real = Date.now.bind(Date);
    Date.now = () => real() + Number(sessionStorage.getItem('clockOffset') ?? 0);
    // Longest gap between animation frames, kept across the reload.
    const w = window as unknown as { __worst: number };
    w.__worst = Number(sessionStorage.getItem('worst') ?? 0);
    let last = performance.now();
    const frame = (t: number): void => { if (t > 8000) { w.__worst = Math.max(w.__worst, t - last) } last = t; sessionStorage.setItem('worst', String(w.__worst)); requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
  });
}
const tickOf = (page: Page): Promise<number> => page.evaluate(() => window.tendril!.sim.latest()?.tick ?? 0);

test('a farm 500,000 ticks (14 hours) behind catches up without freezing the page, and a reload resumes it', async ({ page }) => {
  test.setTimeout(10 * 60_000);
  await offsetClock(page);
  await page.goto('/?mode=live');
  await ready(page);
  await page.evaluate((src) => window.tendril!.loop.setSource(src), grower);
  await page.evaluate(() => window.tendril!.loop.run());
  await expect.poll(() => tickOf(page), { timeout: 30_000 }).toBeGreaterThan(100);
  await page.evaluate(() => window.tendril!.loop.pause());
  const BEHIND = 500_000;
  await page.evaluate((n) => { sessionStorage.setItem('clockOffset', String(n * 100)); sessionStorage.setItem('worst', '0'); (window as unknown as { __worst: number }).__worst = 0; }, BEHIND);
  await page.evaluate(() => window.tendril!.loop.run());
  const card = page.locator('#catchup-card');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText('Catching up');
  await page.screenshot({ path: test.info().outputPath('catchup-card.png') });
  await expect.poll(() => tickOf(page), { timeout: 60_000 }).toBeGreaterThan(100_000);
  // Reload mid catch-up: the farm resumes from its last checkpoint, not from the start.
  const before = await tickOf(page);
  await page.evaluate(() => window.tendril!.sim.flush());
  await page.reload();
  await ready(page);
  await expect.poll(() => tickOf(page), { timeout: 30_000 }).toBeGreaterThan(before - 40_000);
  const started = Date.now();
  await expect(card).toBeHidden({ timeout: 8 * 60_000 });
  const after = await tickOf(page);
  const target = await page.evaluate(() => { const m = window.tendril!.sim.meta; return Math.floor((Date.now() - m.startedAtMs) / 100); });
  expect(target - after).toBeLessThan(2000);
  const worst = await page.evaluate(() => (window as unknown as { __worst: number }).__worst);
  console.log(`caught up in ${((Date.now() - started) / 1000).toFixed(0)} s after reload; worst frame gap ${worst.toFixed(0)} ms`);
  // Headless software GL makes each drawn frame slow (250-500 ms), and the 2-core CI runner adds stalls of 1.5-4.5 s while it
  // also runs the worker and the browser (seen on several CI runs). A real freeze is many seconds, so 8 s still catches it.
  expect(worst).toBeLessThan(8000);
});
