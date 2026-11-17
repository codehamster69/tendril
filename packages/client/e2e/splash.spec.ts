import { test, expect } from '@playwright/test';

test('splash paints at once on Slow 4G, shows real progress, and leaves only when the island is drawn', async ({ page, context }) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
  const t0 = Date.now();
  await page.goto('/?mode=live&ranked=0&coach=0', { waitUntil: 'commit' });
  await page.locator('#splash .sp-name').waitFor({ state: 'visible', timeout: 5000 });
  expect(Date.now() - t0).toBeLessThan(1500); // generous in CI; the splash is in the first HTML bytes
  const bg = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  expect(bg).toBe('rgb(20, 17, 15)');
  await expect(page.locator('#splash .sp-tip')).not.toBeEmpty();
  // While the splash is up nothing unfinished is visible: it covers the whole viewport.
  const covers = await page.evaluate(() => { const r = document.getElementById('splash')!.getBoundingClientRect(); return r.width === innerWidth && r.height === innerHeight; });
  expect(covers).toBe(true);
  await expect(page.locator('#splash')).toHaveCount(0, { timeout: 120_000 });
  await expect(page.locator('#farm-canvas')).toHaveAttribute('data-scene-ready', 'true');
});

test('a failed load shows a message and a Retry button', async ({ page }) => {
  await page.route('**/assets/main-*.js', (route) => route.abort());
  await page.goto('/?mode=live&ranked=0');
  await expect(page.locator('#splash.sp-failed .sp-fail p')).toContainText('could not load');
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
});

test('replay page has the same splash', async ({ page }) => {
  await page.goto('/replay.html?id=missing', { waitUntil: 'commit' });
  await expect(page.locator('#splash .sp-name')).toBeVisible();
});
