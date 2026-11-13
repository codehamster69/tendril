import { test, expect, type Page } from '@playwright/test';
import { dailySeed, DAILY_PAR, BASE_RULES_VERSION } from '@tendril/sim/src/index.ts';

const profile = { id: 'u1', login: 'octo', displayName: 'Octo Cat', avatarUrl: null };
const tier = (key: string, name: string, floor: number, next: number | null) => ({ key, name, floor, next });
const bloom = tier('bloom', 'Bloom', 1600, 1800), vine = tier('vine', 'Vine', 1400, 1600);
const change = (over: Record<string, unknown> = {}) => ({ place: 14, field: 312, delta: 38, before: 1604, rating: 1642, tier: bloom, previousTier: bloom, promoted: false, provisional: false, events: 9, entryId: 'e1', ...over });
const latest = (overall: unknown, id = 'd-2026-12-04') => ({ latest: { challengeId: id, kind: 'daily', closesAt: Date.now() - 3_600_000, overall, speed: null, brevity: null } });

async function mock(page: Page, signedIn: boolean, body: unknown): Promise<{ calls: () => number }> {
  let calls = 0;
  if (signedIn) await page.addInitScript(() => localStorage.setItem('tendril.signedin', '1'));
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (status: number, b: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (path === '/api/me') return signedIn ? json(200, { profile }) : json(401, { error: 'Sign in first.' });
    if (path === '/api/ratings/me/latest') { calls++; return json(200, body); }
    return json(404, { error: 'not mocked' });
  });
  return { calls: () => calls };
}
test.beforeEach(async ({ context }) => { await context.grantPermissions(['clipboard-read', 'clipboard-write']); });

test('morning card shows once after a rated close, chip stays, reload does not repeat it', async ({ page }) => {
  await mock(page, true, latest(change()));
  await page.goto('/?mode=sandbox');
  const card = page.locator('#rating-card');
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-state', 'result');
  await expect(card).toContainText('14th of 312');
  await expect(card).toContainText('+38');
  await expect(card).toContainText('You are now 1,642, Bloom.');
  await expect(page.locator('#rating-chip')).toHaveText('1,642 Bloom');
  await card.getByRole('button', { name: 'Copy result' }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('14th of 312');
  expect(copied).toContain('Rating 1,642 · Bloom');
  expect(copied).toContain('/u/octo');
  await card.getByRole('button', { name: 'Close' }).click();
  await expect(card).toBeHidden();
  await page.reload();
  await expect(page.locator('#rating-chip')).toHaveText('1,642 Bloom');
  await expect(card).toHaveCount(0);
  await page.locator('#rating-chip').click(); // the chip reopens the last result on demand
  await expect(card).toContainText('Last result');
});

test('a newer rated close shows a new card', async ({ page }) => {
  await mock(page, true, latest(change(), 'd-2026-12-05'));
  await page.addInitScript(() => localStorage.setItem('tendril.rating.seen.u1', 'd-2026-12-04'));
  await page.goto('/?mode=sandbox');
  await expect(page.locator('#rating-card')).toBeVisible();
});

test('crossing a tier shows the promotion moment', async ({ page }) => {
  await mock(page, true, latest(change({ before: 1590, rating: 1628, previousTier: vine, promoted: true })));
  await page.goto('/?mode=sandbox');
  const card = page.locator('#rating-card');
  await expect(card).toHaveAttribute('data-state', 'promotion');
  await expect(card.getByRole('heading')).toHaveText('Promoted to Bloom');
  await card.getByRole('button', { name: 'Copy result' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('Promoted to Bloom');
});

test('placement ratings carry a question mark', async ({ page }) => {
  await mock(page, true, latest(change({ rating: 1310, tier: tier('shoot', 'Shoot', 1200, 1400), provisional: true, events: 2 })));
  await page.goto('/?mode=sandbox');
  await expect(page.locator('#rating-chip')).toHaveText('1,310? Shoot');
  await expect(page.locator('#rating-now')).toContainText('Placement: 2 of 5');
});

test('signed out: no rating UI and no rating request', async ({ page }) => {
  const m = await mock(page, false, latest(change()));
  await page.goto('/?mode=sandbox');
  await expect(page.locator('#btn-account')).toHaveText('Sign in');
  await expect(page.locator('#rating-chip')).toHaveCount(0);
  await expect(page.locator('#rating-card')).toHaveCount(0);
  expect(m.calls()).toBe(0);
});

test('signed in but never rated: no chip, no card', async ({ page }) => {
  const m = await mock(page, true, { latest: null });
  await page.goto('/?mode=sandbox');
  await expect(page.locator('#btn-account')).toHaveText('octo');
  await expect.poll(m.calls).toBe(1);
  await expect(page.locator('#rating-chip')).toHaveCount(0);
  await expect(page.locator('#rating-card')).toHaveCount(0);
});

test('result panel says whether the run is on course to be rated', async ({ page }) => {
  const date = new Date().toISOString().slice(0, 10);
  const challenge = { id: `d-${date}`, kind: 'daily', number: 5, seed: dailySeed(date), ticks: 3000, par: DAILY_PAR, opensAt: Date.now() - 3_600_000, closesAt: Date.now() + 3_600_000, rulesVersion: BASE_RULES_VERSION, players: 3, best: 400 };
  let parTick: number | null = 1140;
  await page.addInitScript(() => localStorage.setItem('tendril.signedin', '1'));
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (status: number, b: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (path === '/api/me') return json(200, { profile });
    if (path === '/api/ratings/me/latest') return json(200, { latest: null });
    if (path === `/api/challenges/${challenge.id}`) return json(200, challenge);
    if (path === `/api/challenges/${challenge.id}/entries`) return json(200, { entryId: 'k3f9Zq1AbCdE', netWorth: 512, parTick, tokens: null, mosaic: 'B' + '1'.repeat(63), ranks: { wealth: 4, speed: null, brevity: null }, percentile: 97, improved: true, total: 120 });
    return json(404, { error: 'not mocked' });
  });
  await page.goto('/?mode=daily');
  await page.click('#btn-run-end');
  await expect(page.locator('#arena-rated')).toContainText('On course to be rated', { timeout: 15_000 });
  parTick = null;
  await page.reload();
  await page.click('#btn-run-end');
  await expect(page.locator('#arena-rated')).toContainText('Not on course to be rated', { timeout: 15_000 });
});
