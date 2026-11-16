import { test, expect, type Page } from '@playwright/test';
import { dailyNumber, dailySeed, DAILY_PAR, BASE_RULES_VERSION } from '@tendril/sim/src/index.ts';

const date = new Date().toISOString().slice(0, 10);
const challenge = {
  id: `d-${date}`, kind: 'daily', number: dailyNumber(date), seed: dailySeed(date), ticks: 3000, par: DAILY_PAR,
  opensAt: Date.now() - 3_600_000, closesAt: Date.now() + 3_600_000, rulesVersion: BASE_RULES_VERSION, players: 41, best: 400,
};
const profile = { id: 'u1', login: 'octo', displayName: 'Octo Cat', avatarUrl: null };
const entry = { entryId: 'k3f9Zq1AbCdE', netWorth: 512, parTick: 1140, tokens: 88, mosaic: 'B' + '1'.repeat(63), ranks: { wealth: 4, speed: 9, brevity: 7 }, percentile: 97, improved: true, total: 120 };
const submitted: unknown[] = [];

async function mock(page: Page, signedIn: boolean): Promise<void> {
  submitted.length = 0;
  if (signedIn) await page.addInitScript(() => localStorage.setItem('tendril.signedin', '1'));
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/me') return signedIn ? json(200, { profile }) : json(401, { error: 'Sign in first.' });
    if (path === `/api/challenges/${challenge.id}` && route.request().method() === 'GET') return json(200, challenge);
    if (path === `/api/challenges/${challenge.id}/entries` && signedIn) { submitted.push(route.request().postDataJSON()); return json(200, entry); }
    if (path === '/api/ratings/me/latest') return json(200, { latest: null });
    return json(404, { error: 'not mocked' });
  });
}

test.beforeEach(async ({ context }) => { await context.grantPermissions(['clipboard-read', 'clipboard-write']); });

test('a run to sunset ends on the result card; any key skips the orbit; Enter tries again', async ({ page }) => {
  await mock(page, false);
  await page.goto('/?mode=daily');
  await expect(page.locator('#tp-sunset')).toBeEnabled();
  await page.click('#tp-sunset');
  await expect(page.locator('.rs-layer')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.rs-card')).toHaveCount(0); // orbiting
  await page.keyboard.press('x');
  const card = page.locator('.rs-card');
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('role', 'dialog');
  await expect(page.locator('#arena-result')).toHaveCount(0); // the old result panel is gone
  await expect(card.locator('.rs-medal')).toHaveCount(3);
  await expect(card.locator('.rs-medal.stamped')).toHaveCount(3, { timeout: 5000 });
  await expect(card.locator('.rs-signin')).toBeVisible();
  expect(submitted).toHaveLength(0);
  await card.locator('.rs-share').click();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text.split('\n')[0]).toMatch(/^Tendril .* · [\d,]+ coins/);
  await page.keyboard.press('Escape');
  await expect(page.locator('.rs-reopen')).toBeVisible();
  await page.click('.rs-reopen');
  await expect(card).toBeVisible();
  await page.locator('.rs-card .rs-try').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.rs-layer')).toHaveCount(0);
  await expect(page.locator('#hud-tick')).toHaveText('0');
});

test('signed in: the run is submitted, ranks and the replay link appear', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mock(page, true);
  await page.goto('/?mode=daily');
  await expect(page.locator('#tp-sunset')).toBeEnabled();
  await page.click('#tp-sunset');
  const card = page.locator('.rs-card');
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.locator('.rs-rank')).toContainText('4th of 120');
  await expect(card.locator('.rs-rank')).toContainText('top 4%');
  await expect(card.locator('.rs-medal').nth(2)).toContainText('88 tokens');
  await expect(card.locator('.rs-replay')).toHaveAttribute('href', 'replay.html?e=k3f9Zq1AbCdE');
  expect(submitted).toHaveLength(1);
});

test('a run below par gets the gentle card with a hint and Try again first', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mock(page, false);
  await page.goto('/?mode=daily');
  await expect(page.locator('#tp-sunset')).toBeEnabled();
  await page.evaluate(() => window.tendril!.editor.setSource('')); // an empty program never reaches par
  await page.click('#tp-sunset');
  const card = page.locator('.rs-card');
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toHaveAttribute('data-missed', 'true');
  await expect(card.locator('.rs-hint')).toBeVisible();
  await expect(card.locator('.rs-buttons .hk-button').first()).toHaveClass(/rs-try/);
});
