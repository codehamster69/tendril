import { test, expect, type Page } from '@playwright/test';
import { dailyNumber, dailySeed, DAILY_PAR, RULES_VERSION } from '@tendril/sim/src/index.ts';

const date = new Date().toISOString().slice(0, 10);
const challenge = {
  id: `d-${date}`, kind: 'daily', number: dailyNumber(date), seed: dailySeed(date), ticks: 3000, par: DAILY_PAR,
  opensAt: Date.now() - 3_600_000, closesAt: Date.now() + 3_600_000, rulesVersion: RULES_VERSION, players: 41, best: 400,
};
const label = challenge.number > 0 ? `#${challenge.number}` : challenge.id; // before launch day the number is <= 0
const profile = { id: 'u1', login: 'octo', displayName: 'Octo Cat', avatarUrl: null };
const entry = { entryId: 'k3f9Zq1AbCdE', netWorth: 512, parTick: 1140, tokens: null, mosaic: 'B' + '1'.repeat(63), ranks: { wealth: 4, speed: 9, brevity: null }, percentile: 97, improved: true, total: 120 };
const submitted: { actions: unknown[]; rulesVersion: number; source?: string; sourcePublic?: boolean }[] = [];
type Respond = (body: (typeof submitted)[number]) => { status: number; body: unknown };

async function mock(page: Page, signedIn: boolean, respond: Respond = () => ({ status: 200, body: entry })): Promise<void> {
  submitted.length = 0;
  if (signedIn) await page.addInitScript(() => localStorage.setItem('tendril.signedin', '1'));
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/me') return signedIn ? json(200, { profile }) : json(401, { error: 'Sign in first.' });
    if (path === `/api/challenges/${challenge.id}` && route.request().method() === 'GET') return json(200, challenge);
    if (path === `/api/challenges/${challenge.id}/entries` && signedIn) {
      const body = route.request().postDataJSON() as (typeof submitted)[number];
      submitted.push(body);
      const answer = respond(body);
      return json(answer.status, answer.body);
    }
    return json(404, { error: 'not mocked' });
  });
}

test.beforeEach(async ({ context }) => { await context.grantPermissions(['clipboard-read', 'clipboard-write']); });

test('signed out: run to end shows the result and copies the share text', async ({ page }) => {
  await mock(page, false);
  await page.goto('/?mode=daily');
  await expect(page.locator('#arena-head')).toContainText(challenge.number > 0 ? `Daily farm ${label}` : 'Practice farm');
  await expect(page.locator('#arena-stats')).toContainText('Time left');
  await expect(page.locator('#arena-beat')).toHaveText('400 coins');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'paused');
  const started = Date.now();
  await page.click('#btn-run-end');
  await expect(page.locator('#arena-result')).toBeVisible({ timeout: 15_000 });
  expect(Date.now() - started).toBeLessThan(5000); // 3,000 ticks without drawing each one
  await expect(page.locator('#hud-tick')).toHaveText('3000');
  await expect(page.locator('#arena-facts')).toContainText('net worth');
  await expect(page.locator('#btn-arena-signin')).toBeVisible();
  expect(submitted).toHaveLength(0);
  await page.click('#btn-copy-result');
  const text = await page.evaluate(() => navigator.clipboard.readText());
  const lines = text.split('\n');
  expect(lines[0]).toMatch(new RegExp(`^Tendril ${label} · [\\d,]+ coins$`));
  expect(lines[1]).toMatch(/^Par (at tick [\d,]+|not reached)$/);
  expect(lines.slice(2, 10)).toHaveLength(8);
  for (const row of lines.slice(2, 10)) expect([...row]).toHaveLength(8);
  expect(lines[10]).toBe('tendril.hokora.xyz');
});

test('signed in: the finished run is submitted and the rank shown', async ({ page }) => {
  await mock(page, true);
  await page.goto('/?mode=challenge&id=' + challenge.id);
  await page.click('#btn-run-end');
  await expect(page.locator('#arena-facts')).toContainText('top 4% (rank 4 of 120)', { timeout: 15_000 });
  expect(submitted).toHaveLength(1);
  expect(submitted[0]!.rulesVersion).toBe(RULES_VERSION);
  expect(Array.isArray(submitted[0]!.actions)).toBe(true);
  await page.click('#btn-copy-result');
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text.split('\n')[0]).toMatch(/· top 4%$/);
  expect(text.endsWith('tendril.hokora.xyz/r/k3f9Zq1AbCdE')).toBe(true);
});

test('signed in: the program goes with the run, the tick box publishes it, and tokens join the share text', async ({ page }) => {
  await mock(page, true, (body) => ({ status: 200, body: { ...entry, tokens: 112, ranks: { ...entry.ranks, brevity: 3 }, source: body.source } }));
  await page.goto('/?mode=daily');
  await expect(page.locator('#publish-source')).not.toBeChecked();
  await page.check('#publish-source');
  await page.click('#btn-run-end');
  await expect(page.locator('#arena-note')).toContainText('Your program is 112 tokens (Brevity rank 3)', { timeout: 15_000 });
  expect(submitted).toHaveLength(1);
  expect(typeof submitted[0]!.source).toBe('string');
  expect(submitted[0]!.sourcePublic).toBe(true);
  await page.click('#btn-copy-result');
  const lines = (await page.evaluate(() => navigator.clipboard.readText())).split('\n');
  expect(lines[1]).toMatch(/^Par (at tick [\d,]+|not reached) · 112 tokens$/);
  expect(lines).toHaveLength(11);
});

test('signed in: a program the server cannot match does not cost the score', async ({ page }) => {
  await mock(page, true, (body) => (body.source !== undefined ? { status: 422, body: { error: 'Source does not produce this run' } } : { status: 200, body: entry }));
  await page.goto('/?mode=daily');
  await page.click('#btn-run-end');
  await expect(page.locator('#arena-facts')).toContainText('top 4% (rank 4 of 120)', { timeout: 15_000 });
  await expect(page.locator('#arena-note')).toContainText('does not match this run');
  expect(submitted.map((b) => b.source !== undefined)).toEqual([true, false]);
  expect(submitted[1]!.sourcePublic).toBeUndefined();
});

test('the Season tab opens this week\'s season, runs 6,000 ticks and highlights its tab', async ({ page }) => {
  const season = { ...challenge, id: 's-2026-W49', kind: 'season', number: 1, seed: 4242, ticks: 6000 };
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/challenges/week') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(season) });
    return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Sign in first.' }) });
  });
  await page.goto('/');
  await page.click('#mode-tabs a[data-mode="season"]');
  await expect(page.locator('#arena-head')).toContainText('Weekly season #1');
  await expect(page.locator('#mode-label')).toHaveText('Weekly season');
  await expect(page.locator('#mode-tabs a[aria-current="page"]')).toHaveText('Season');
  await expect(page.locator('#mode-tabs a[data-mode="live"]')).toHaveText('Endless');
  const started = Date.now();
  await page.click('#btn-run-end');
  await expect(page.locator('#arena-result')).toBeVisible({ timeout: 30_000 });
  expect(Date.now() - started).toBeLessThan(30_000); // well under a minute
  await expect(page.locator('#hud-tick')).toHaveText('6000');
});
