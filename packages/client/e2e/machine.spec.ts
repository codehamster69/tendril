import { test, expect, type Page } from '@playwright/test';
import { ready } from './game.ts';
import { dailyNumber, dailySeed, DAILY_PAR, BASE_RULES_VERSION } from '@tendril/sim/src/index.ts';

const date = new Date().toISOString().slice(0, 10);
const challenge = {
  id: `d-${date}`, kind: 'daily', number: dailyNumber(date), seed: dailySeed(date), ticks: 3000, par: DAILY_PAR,
  opensAt: Date.now() - 3_600_000, closesAt: Date.now() + 3_600_000, rulesVersion: BASE_RULES_VERSION, players: 41, best: 400,
};
const model = { rank: 1, login: 'tendril-models', value: 100, authorKind: 'model', model: 'gemini-3.5-flash' };

async function mock(page: Page, board: (() => { status: number; body: unknown }) | null): Promise<void> {
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/me') return json(401, { error: 'Sign in first.' });
    if (path === `/api/challenges/${challenge.id}/board` && board) { const b = board(); return json(b.status, b.body); }
    if (path === `/api/challenges/${challenge.id}` && route.request().method() === 'GET') return json(200, challenge);
    return json(404, { error: 'not mocked' });
  });
}

test.beforeEach(async ({ context }) => { await context.grantPermissions(['clipboard-read', 'clipboard-write']); });

test('the start card names the machine score, the result compares with it and the share text carries it', async ({ page }) => {
  await mock(page, () => ({ status: 200, body: { entries: [model] } }));
  await page.goto('/?mode=daily');
  await expect(page.locator('#splash')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.locator('#start-card .start-machine')).toHaveText('Gemini 3.5 Flash scored 100 coins net worth on the visible farm. Beat it.');
  await page.keyboard.press('Escape');
  await expect(page.locator('#tp-sunset')).toBeEnabled();
  await page.click('#tp-sunset');
  await expect(page.locator('.rs-layer')).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('x');
  await expect(page.locator('.rs-machine')).toHaveText(/^(Beat Gemini( by (less than 1|\d+)%)?|Gemini won by \d+%|Tied with Gemini)/);
  await page.locator('.rs-card .rs-share').click();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toMatch(/\n🤖 (Beat Gemini|Gemini won|Tied with Gemini)/);
});

test('a failing board read never blocks the start', async ({ page }) => {
  await mock(page, () => ({ status: 500, body: { error: 'down' } }));
  await page.goto('/?mode=daily');
  await ready(page);
  await expect(page.locator('#start-card .start-machine')).toHaveCount(0);
  await expect(page.locator('#tp-sunset')).toBeEnabled();
});
