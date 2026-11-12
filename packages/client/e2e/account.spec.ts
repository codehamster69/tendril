import { test, expect, type Page } from '@playwright/test';
import { createWorld, deserialize, hashWorld, netWorth, replayChunk, serialize, BASE_RULES_VERSION } from '@tendril/sim/src/index.ts';

const KEY = 'tendril.unrankedNotice.dismissedUntil';
const profile = { id: 'u1', login: 'octo', displayName: 'Octo Cat', avatarUrl: null };
const WRAP = 'This farm is saved only on this computer and is not on the leaderboard. Sign in to join the leaderboard.';

let farmAgeMs = 1000;
function farm() {
  const world = createWorld({ id: 'farm-1', seed: 7 });
  return {
    id: 'farm-1', seed: 7, startedAtMs: Date.now() - farmAgeMs, tick: world.tick, checkpoint: serialize(world),
    checkpointHash: hashWorld(world), rulesVersion: BASE_RULES_VERSION, coins: world.coins, netWorth: netWorth(world),
  };
}

const chunks: { toTick: number }[] = [];
const server = { world: deserialize(farm().checkpoint) };

/** Every /api request is answered here; nothing reaches a network. */
async function mockApi(page: Page, signedIn: boolean): Promise<void> {
  chunks.length = 0;
  farmAgeMs = 1000;
  server.world = deserialize(farm().checkpoint);
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/me') return signedIn ? json(200, { profile }) : json(401, { error: 'Sign in first.' });
    if (path === '/api/farms/me') return signedIn ? json(200, farm()) : json(401, { error: 'Sign in first.' });
    if (path === '/api/farms/farm-1/chunks' && signedIn) {
      // The verifier: replay the chunk onto the server's checkpoint, as the real server does.
      const body = route.request().postDataJSON() as { fromTick: number; toTick: number; actions: never[] };
      const world = server.world;
      if (body.fromTick !== world.tick) return json(409, { error: 'Stale checkpoint' });
      replayChunk(world, body.actions, body.toTick);
      chunks.push(body);
      return json(200, { tick: world.tick, checkpointHash: hashWorld(world), netWorth: netWorth(world), rank: 1 });
    }
    return json(404, { error: 'not mocked' });
  });
  if (signedIn) await page.addInitScript(() => localStorage.setItem('tendril.signedin', '1'));
}

const notice = (page: Page) => page.locator('#unranked-notice');

test('live mode, signed out: notice with sign-in and dismiss, dismissal survives reload', async ({ page }, testInfo) => {
  await mockApi(page, false);
  await page.goto('/?mode=live');
  await expect(notice(page)).toBeVisible();
  await expect(notice(page)).toHaveAttribute('role', 'status');
  await expect(notice(page)).toContainText(WRAP);
  await expect(notice(page).getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(notice(page).getByRole('button', { name: 'Dismiss this notice' })).toBeVisible();
  // It sits above the workbench and never overlaps the canvas.
  const bar = (await notice(page).boundingBox())!, canvas = (await page.locator('#farm-canvas').boundingBox())!;
  expect(bar.y + bar.height).toBeLessThanOrEqual(canvas.y);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.screenshot({ path: 'e2e/notice.png' });
  await page.screenshot({ path: testInfo.outputPath('notice.png') });
  await notice(page).getByRole('button', { name: 'Dismiss this notice' }).click();
  await expect(notice(page)).toBeHidden();
  const until = Number(await page.evaluate((k) => localStorage.getItem(k), KEY));
  expect(until).toBeGreaterThan(Date.now() + 6.9 * 86_400_000);
  await page.reload();
  await expect(page.locator('#status')).toHaveAttribute('data-state', /./);
  await expect(notice(page)).toBeHidden();
});

test('the notice Sign in button opens the same flow as the account button', async ({ page }) => {
  await mockApi(page, false);
  await page.goto('/?mode=live');
  const navigation = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/auth/github');
  await page.route('**/api/auth/github**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: 'ok' }));
  await notice(page).getByRole('button', { name: 'Sign in' }).click();
  await navigation;
});

test('sandbox, campaign and daily modes show no notice', async ({ page }) => {
  await mockApi(page, false);
  for (const mode of ['sandbox', 'campaign', 'daily']) {
    await page.goto(`/?mode=${mode}`);
    await expect(page.locator('#mode-label')).not.toHaveText('Endless farm');
    await expect(page.locator('#btn-account')).toBeVisible();
    await expect(notice(page)).toBeHidden();
  }
});

test('signed in on the local farm: wording changes and links to the Endless farm', async ({ page }) => {
  await mockApi(page, true);
  await page.goto('/?mode=live&ranked=0');
  await expect(page.locator('#mode-label')).toContainText('Local');
  await expect(page.locator('#btn-account')).toHaveText('octo');
  await expect(notice(page)).toContainText("You're signed in, but this is your local farm. Open your Endless farm to compete.");
  await expect(notice(page).getByRole('link')).toHaveAttribute('href', '?mode=live&ranked=1');
  await expect(notice(page).getByRole('button', { name: 'Sign in' })).toHaveCount(0);
});

test('signed in on the Endless farm: no notice', async ({ page }) => {
  await mockApi(page, true);
  await page.goto('/?mode=live&ranked=1');
  await expect(page.locator('#btn-account')).toHaveText('octo');
  await expect(page.locator('#mode-label')).toContainText('Endless');
  await expect(notice(page)).toBeHidden();
});

test('signed in: the live farm is the Endless farm by default', async ({ page }) => {
  await mockApi(page, true);
  await page.goto('/?mode=live');
  await expect(page.locator('#btn-account')).toHaveText('octo');
  await expect(page.locator('#mode-label')).toContainText('Endless');
  await expect(notice(page)).toBeHidden();
});

test('a stale sign-in falls back to the local farm quietly', async ({ page }) => {
  await mockApi(page, false);
  await page.addInitScript(() => localStorage.setItem('tendril.signedin', '1'));
  await page.goto('/?mode=live');
  await expect(page.locator('#mode-label')).toContainText('Local');
  await expect(page.getByText('Could not connect Endless farm')).toHaveCount(0);
});

test('Sync now verifies the Endless farm without pausing it', async ({ page }) => {
  await mockApi(page, true);
  await page.goto('/?mode=live');
  await expect(page.locator('#mode-label')).toContainText('Endless');
  await expect.poll(() => page.evaluate(() => window.tendril?.sim.latest()?.tick ?? 0)).toBeGreaterThan(5);
  const before = chunks.length;
  await page.locator('#btn-account').click();
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByText('Farm verified').first()).toBeVisible();
  await expect.poll(() => chunks.length).toBeGreaterThan(before);
  await expect.poll(() => page.evaluate(() => window.tendril?.sim.accepted?.farm.tick ?? 0)).toBe(chunks.at(-1)!.toTick);
});

test('auto-sync reaches the leaderboard by itself and shows the rank', async ({ page }) => {
  await mockApi(page, true);
  await page.goto('/?mode=live');
  await expect(page.locator('#mode-note')).toContainText('On the leaderboard · rank 1', { timeout: 15_000 });
  expect(chunks.length).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.tendril?.sim.accepted?.farm.tick ?? 0)).toBe(server.world.tick);
});

test('a farm far behind catches up with chunks sent back to back', async ({ page }) => {
  test.slow(); // Replays 45,000 ticks in the browser; shared CPUs make that several times slower.
  await mockApi(page, true);
  farmAgeMs = 4_500_000; // 45,000 ticks: three chunks of at most 20,000.
  await page.goto('/?mode=live');
  await expect(page.locator('#mode-note')).toContainText('On the leaderboard', { timeout: 60_000 });
  await expect.poll(() => server.world.tick, { timeout: 60_000 }).toBeGreaterThan(44_000);
  expect(chunks.length).toBeGreaterThanOrEqual(3);
});
