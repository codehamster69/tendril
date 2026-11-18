// Daily briefs in the client (K6): start card, goal HUD, result screen with hidden farms, practice farms, and the offline fallback.
// The server is mocked; the brief is drawn locally from the seed exactly as the real server's replay does. K6_SHOTS=<dir> saves screenshots.
import { test, expect, type Page } from '@playwright/test';
import { BASE_RULES_VERSION, SETUP_BRIEF, challengeSetup, dailyNumber } from '@tendril/sim/src/index.ts';

const SHOTS = process.env.K6_SHOTS;
const date = new Date().toISOString().slice(0, 10);
const seedFor = (kind: string): number => {
  for (let seed = 7; seed < 4000; seed++) {
    const b = challengeSetup('daily', seed, SETUP_BRIEF).brief!;
    if (b.goal.kind === kind && (kind !== 'festival' || (b.goal.quotas ?? []).filter((q) => q > 0).length >= 2) && b.labels.length >= 1) return seed;
  }
  throw new Error(`no ${kind} seed`);
};
const info = (kind: string, extra: Record<string, unknown> = {}) => ({
  id: `d-${date}`, kind: 'daily', number: dailyNumber(date), seed: seedFor(kind), ticks: 3000, par: kind === 'festival' ? 100 : 200,
  opensAt: Date.now() - 3_600_000, closesAt: Date.now() + 3_600_000, rulesVersion: BASE_RULES_VERSION, setupVersion: SETUP_BRIEF, players: 12, best: null,
  hiddenFarms: 2, siblingSeeds: null, ...extra,
});
const profile = { id: 'u1', login: 'octo', displayName: 'Octo Cat', avatarUrl: null };
const entry = { entryId: 'k3f9Zq1AbCdE', netWorth: 512, parTick: null, tokens: null, mosaic: 'B' + '1'.repeat(63), ranks: { wealth: 4, speed: null, brevity: null }, percentile: 90, improved: true, total: 12, score: 120, finalScore: null, finalParTick: null, provisional: true };
let posts = 0;

async function mock(page: Page, served: Record<string, unknown>, reply: Record<string, unknown> = entry): Promise<void> {
  posts = 0;
  await page.addInitScript(() => localStorage.setItem('tendril.signedin', '1'));
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/me') return json(200, { profile });
    if (path === `/api/challenges/${served.id}` && route.request().method() === 'GET') return json(200, served);
    if (path === `/api/challenges/${served.id}/entries`) { posts++; return json(200, reply); }
    return json(404, { error: 'not mocked' });
  });
}
const shot = async (page: Page, name: string): Promise<void> => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };
async function openCard(page: Page, search = '/?mode=daily'): Promise<void> {
  await page.goto(search);
  await expect(page.locator('#splash')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.locator('#start-card')).toBeVisible();
}
async function startAndFinish(page: Page) {
  await page.keyboard.press('Escape'); // look first; sunset runs the whole day at once
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'paused');
  await expect(page.locator('#tp-sunset')).toBeEnabled();
  await page.click('#tp-sunset');
  const card = page.locator('.rs-card');
  await expect(card).toBeVisible({ timeout: 30_000 });
  return card;
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

for (const [label, size] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]] as const) {
  test(`festival brief on ${label}: start card, quota bars, provisional result`, async ({ page }) => {
    await page.setViewportSize(size);
    await mock(page, info('festival'));
    await openCard(page);
    const card = page.locator('#start-card');
    await expect(card.locator('.start-notice')).toContainText('village fair');
    await expect(card.locator('dt', { hasText: 'Harvest festival' })).toBeVisible();
    await expect(card.locator('dt', { hasText: 'Twists' })).toBeVisible();
    await expect(card.locator('dt', { hasText: 'Length' })).toBeVisible();
    await expect(card).toContainText('2 hidden farms when the day closes');
    await expect(card.locator('#btn-start-another')).toBeVisible();
    await shot(page, `${label}-start-card`);

    const result = await startAndFinish(page);
    await expect(page.locator('#goal-hud')).toHaveAttribute('data-goal', 'festival');
    expect(await page.locator('#goal-hud .gh-quota').count()).toBeGreaterThanOrEqual(2);
    await expect(result.locator('.rs-coins')).toContainText('% of the quotas filled');
    await expect(result.locator('.rs-final')).toHaveAttribute('data-state', 'provisional');
    await expect(result.locator('.rs-final')).toContainText('Provisional until the day closes');
    await expect(result.locator('.rs-final')).toContainText('2 hidden farms');
    await expect.poll(() => posts).toBe(1);
    await expect(result.locator('.rs-medal').first()).toContainText('Festival');
    await shot(page, `${label}-result-provisional`);
  });
}

test('goal HUD counts up during a festival day', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mock(page, info('festival'));
  await openCard(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('#goal-hud .gh-quota').first()).toBeVisible();
  await expect(page.locator('#goal-hud .gh-have').first()).toHaveText(/^0 \/ \d+/);
  await expect(page.locator('#tp-sunset')).toBeEnabled();
  await page.click('#tp-sunset');
  await expect(page.locator('.rs-card')).toBeVisible({ timeout: 30_000 });
  const have = await page.locator('#goal-hud .gh-have').allTextContents();
  expect(have.length).toBeGreaterThanOrEqual(2); // the bars were fed by the worker (value depends on the example program)
  await shot(page, 'desktop-goal-hud-end');
});

test('wealth brief shows the score and par in the HUD', async ({ page }) => {
  await mock(page, info('wealth'));
  await openCard(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('#goal-hud')).toHaveAttribute('data-goal', 'wealth');
  await expect(page.locator('#goal-hud .gh-par')).toContainText('Par 200 coins net worth');
  await expect(page.locator('#goal-hud .gh-quota')).toHaveCount(0);
});

test('after the close the result shows visible, hidden and final scores', async ({ page }) => {
  await mock(page, info('orders'), { ...entry, score: 300, finalScore: 900, finalParTick: 4100, provisional: false });
  await openCard(page);
  const result = await startAndFinish(page);
  await expect(result.locator('.rs-final')).toHaveAttribute('data-state', 'final', { timeout: 15_000 });
  await expect(result.locator('.rs-final')).toContainText('Final score 900 coins from orders');
  await expect(result.locator('.rs-final')).toContainText('Visible farm 300 coins from orders · 2 hidden farms 600 coins from orders');
  await shot(page, 'desktop-result-final');
});

test('Try another farm opens a practice farm that is never submitted', async ({ page }) => {
  await mock(page, info('orders'));
  await openCard(page);
  await page.click('#btn-start-another');
  await expect(page).toHaveURL(/practice=\d+/);
  await expect(page.locator('#start-card')).toBeVisible();
  await expect(page.locator('#start-card')).toContainText('Practice runs are never rated');
  await expect(page.locator('#start-card')).not.toContainText('hidden farms');
  await expect(page.locator('#mode-label')).toHaveText('Practice farm');
  await shot(page, 'desktop-practice-start');
  const result = await startAndFinish(page);
  await expect(result.locator('.rs-note')).toContainText('nothing was submitted');
  await expect(result.locator('.rs-final')).toBeHidden();
  await expect(result.locator('.rs-signin')).toBeHidden();
  await expect(result.locator('.rs-medal').nth(2)).toContainText('not rated');
  await expect(result.locator('.rs-another')).toHaveText('Another farm');
  expect(posts).toBe(0);
  await shot(page, 'desktop-practice-result');
  const url = page.url();
  await result.locator('.rs-another').click();
  await expect(page).not.toHaveURL(url);
  await expect(page).toHaveURL(/practice=\d+/);
});

test('brief day with the server unreachable: connect to play, and a random practice brief', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2099-02-03T12:00:00Z')); // after BRIEF_EPOCH
  await page.route('**/api/**', (route) => route.abort());
  await openCard(page);
  await expect(page.locator('#start-card .start-offline')).toContainText("Connect to play today's brief");
  await expect(page.locator('#start-card .start-notice')).not.toBeEmpty();
  await expect(page.locator('#btn-start-another')).toHaveText('Another practice farm');
  await shot(page, 'desktop-offline-start');
  const result = await startAndFinish(page);
  await expect(result.locator('.rs-note')).toContainText('nothing was submitted');
});
