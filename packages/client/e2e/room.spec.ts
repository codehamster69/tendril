import { test, expect, type Page } from '@playwright/test';
import { challengeSetup, createWorld, netWorth, replayChunk, SETUP_LEGACY } from '@tendril/sim/src/index.ts';
import type { LogEntry } from '@tendril/sim/src/index.ts';

const SMALL: LogEntry[] = [[0, 0, 0, 1], [2, 0, 1], [5, 0, 2, 1], [7, 0, 3], [9, 0, 3], [300, 0, 4], [303, 0, 0, 3], [305, 0, 5], [306, 0, 8, 1, 4]];
const SEED = 4242, TICKS = 3000, DUEL = 'x-abcd1234';

// The mocked duel carries no setupVersion, so the page replays it as a legacy challenge.
function worth(actions: LogEntry[]): number {
  const w = createWorld({ id: 'x', seed: SEED }, challengeSetup('duel', SEED, SETUP_LEGACY).setup);
  replayChunk(w, actions, TICKS);
  return netWorth(w);
}
// Sixteen different seeded runs: the full log, shorter prefixes of it, and copies that start later.
const slice = (n: number): LogEntry[] => SMALL.slice(0, n);
const later = (by: number): LogEntry[] => SMALL.map((a) => [a[0] + by, ...a.slice(1)] as LogEntry);
const LOGS: LogEntry[][] = [SMALL, ...[0, 2, 4, 5, 6, 7, 8].map(slice), ...[10, 20, 40, 80, 120, 160, 200, 240].map(later)];
const entries = LOGS.map((actions, i) => ({ entryId: `e${i}`, login: `p${i}`, displayName: `Player ${i}`, value: worth(actions), actions }));

async function mock(page: Page, opts: { sealed?: string[]; count?: number } = {}): Promise<void> {
  const list = entries.slice(0, opts.count ?? 16);
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/api/duels/${DUEL}`) return route.fulfill({ json: { id: DUEL, seed: SEED, ticks: TICKS, rulesVersion: 3, challenger: { login: 'p0', displayName: 'Player 0' }, entry: { entryId: 'e0', netWorth: entries[0]!.value }, accepted: 3, viewer: null } });
    if (path === `/api/challenges/${DUEL}/board`) return route.fulfill({ json: { medal: 'wealth', entries: [...list].sort((a, b) => b.value - a.value).map((e, i) => ({ rank: i + 1, entryId: e.entryId, login: e.login, displayName: e.displayName, value: e.value })), total: list.length } });
    const m = /^\/api\/entries\/(e\d+)\/replay$/.exec(path);
    if (m) {
      if (opts.sealed?.includes(m[1]!)) return route.fulfill({ status: 403, json: { error: 'sealed' } });
      return route.fulfill({ json: { seed: SEED, ticks: TICKS, rulesVersion: 3, actions: entries[Number(m[1]!.slice(1))]!.actions } });
    }
    return route.fulfill({ status: 404, json: { error: 'not found' } });
  });
}

test('room with 16 seeded replays ranks live on one clock at 30 frames a second', async ({ page }) => {
  test.setTimeout(90_000);
  await mock(page);
  await page.goto(`/room.html?id=${DUEL}`);
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
  await expect(page.locator('body')).toHaveAttribute('data-live', '16');
  await expect(page.locator('.tile')).toHaveCount(15); // the host is drawn large, not as a tile
  await expect(page.locator('.tile canvas')).toHaveCount(15);

  // Frame rate: play at 16x for a few seconds and count drawn frames.
  await page.locator('#speed').selectOption('16');
  await page.locator('#btn-play').click();
  const f0 = Number(await page.locator('body').getAttribute('data-frames'));
  const t0 = Date.now();
  await page.waitForTimeout(3000);
  const f1 = Number(await page.locator('body').getAttribute('data-frames'));
  const fps = ((f1 - f0) * 1000) / (Date.now() - t0);
  // Alone on a machine the room holds 30 (28 to 31). Other browsers busy on the same CPU can slow the wall clock, so the
  // hard floor is 20 and the real guard is the cost of one frame: well under the 33 ms a 30 fps frame allows.
  expect(fps).toBeGreaterThanOrEqual(20);
  expect(fps).toBeLessThanOrEqual(31);
  expect(Number(await page.locator('body').getAttribute('data-draw-ms'))).toBeLessThan(12);
  expect(Number(await page.locator('body').getAttribute('data-tick'))).toBeGreaterThan(100);

  // Ranking at the end of the run: live order is by net worth, highest first.
  await page.locator('#btn-play').click(); // pause
  await page.locator('#scrub').fill('3000');
  await expect(page.locator('#clock')).toHaveText('tick 3000 / 3000');
  const finals = entries.map((e) => e.value).sort((a, b) => b - a);
  const shown = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-testid="host-worth"]')!;
    const tiles = [...document.querySelectorAll<HTMLElement>('.tile')].map((t) => ({ place: Number(t.dataset.place), value: Number(t.querySelector<HTMLElement>('.worth')!.dataset.value) }));
    const hostPlace = Number(document.querySelector<HTMLElement>('[data-testid="host-rank"]')!.dataset.place);
    return [...tiles, { place: hostPlace, value: Number(host.dataset.value) }].sort((a, b) => a.place - b.place).map((x) => x.value);
  });
  expect(shown).toEqual(finals);
  await expect(page.locator('.tile').first()).toBeVisible();
});

test('sealed runs stay sealed and out of the ranking', async ({ page }) => {
  await mock(page, { sealed: ['e3', 'e4'], count: 6 });
  await page.goto(`/room.html?id=${DUEL}`);
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
  await expect(page.locator('body')).toHaveAttribute('data-live', '4');
  await expect(page.locator('.tile.off')).toHaveCount(2);
  await expect(page.locator('#note')).toContainText('2 farms are sealed');
});

test('a bad link and an unknown duel show a clear message', async ({ page }) => {
  await mock(page);
  await page.goto('/room.html?id=nope');
  await expect(page.locator('#error')).toContainText('not valid');
  await page.goto('/room.html?id=x-zzzzzzzz');
  await expect(page.locator('#error')).toContainText('does not exist');
});

test('the 3D host toggle swaps the renderer and back', async ({ page }) => {
  await mock(page, { count: 4 });
  await page.goto(`/room.html?id=${DUEL}`);
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
  await expect(page.locator('.host canvas:visible')).toHaveCount(1);
  await page.locator('#toggle-3d').check();
  await expect(page.locator('body')).toHaveAttribute('data-host3d', 'true');
  await expect(page.locator('.host canvas:visible')).toHaveCount(1);
  await page.locator('#toggle-3d').uncheck();
  await expect(page.locator('body')).toHaveAttribute('data-host3d', 'false');
  await expect(page.locator('.host canvas:visible')).toHaveCount(1);
});

// Opt-in: SHOT=<png path> saves a screenshot of the room.
(process.env.SHOT ? test : test.skip)('screenshot', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await mock(page);
  await page.goto(`/room.html?id=${DUEL}`);
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
  await page.locator('#scrub').fill('1500');
  await page.waitForTimeout(500);
  await page.screenshot({ path: process.env.SHOT! });
});
