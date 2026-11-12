import { test, expect, type Page } from '@playwright/test';
import { challengeSetup, createWorld, netWorth, replayChunk, SETUP_LEGACY } from '@tendril/sim/src/index.ts';
import type { LogEntry } from '@tendril/sim/src/index.ts';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SMALL: LogEntry[] = [[0, 0, 0, 1], [2, 0, 1], [5, 0, 2, 1], [7, 0, 3], [9, 0, 3], [300, 0, 4], [303, 0, 0, 3], [305, 0, 5], [306, 0, 8, 1, 4]];
const IDLE: LogEntry[] = [];
const SEED = 4242, TICKS = 3000;

// The mocked entries carry no setupVersion, so the page replays them as legacy challenges.
function worth(actions: LogEntry[]): number {
  const w = createWorld({ id: 'x', seed: SEED }, challengeSetup('daily', SEED, SETUP_LEGACY).setup);
  replayChunk(w, actions, TICKS);
  return netWorth(w);
}
const entry = (id: string, login: string, actions: LogEntry[], sealed = false) => ({
  id, player: { login, displayName: login }, netWorth: worth(actions), sealed,
  challenge: { id: 'd-2026-12-01', kind: 'daily', number: 1, seed: SEED, ticks: TICKS, closesAt: '2026-12-02T00:00:00Z' },
});

async function mock(page: Page, sealedIds: string[] = []): Promise<void> {
  const logs: Record<string, LogEntry[]> = { runa: SMALL, runb: IDLE, locked: SMALL };
  await page.route('**/api/entries/**', async (route) => {
    const url = new URL(route.request().url());
    const [, , , id, tail] = url.pathname.split('/');
    const actions = logs[id!];
    if (!actions) return route.fulfill({ status: 404, json: { error: 'not found' } });
    const sealed = sealedIds.includes(id!);
    if (tail === 'replay') return sealed ? route.fulfill({ status: 403, json: { error: 'sealed' } }) : route.fulfill({ json: { seed: SEED, ticks: TICKS, rulesVersion: 3, actions } });
    return route.fulfill({ json: entry(id!, id!, actions, sealed) });
  });
}

test('replay shows the verified final net worth and scrubs', async ({ page }) => {
  await mock(page);
  await page.goto('/replay.html?e=runa');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready');
  const expected = worth(SMALL);
  await expect(page.locator('body')).toHaveAttribute('data-final-a', String(expected));
  await expect(page.locator('body')).toHaveAttribute('data-verified-a', 'true');
  await page.locator('#scrub').fill('3000');
  await expect(page.getByTestId('worth-a')).toHaveAttribute('data-value', String(expected));
  await page.locator('#scrub').fill('100');
  await expect(page.locator('#clock')).toHaveText('tick 100 / 3000');
  await page.locator('#scrub').fill('3000');
  await expect(page.getByTestId('worth-a')).toHaveAttribute('data-value', String(expected));
  await page.locator('#btn-play').click();
  await expect(page.locator('#btn-play')).toHaveText('Pause');
});

test('race view shows two farms on one clock', async ({ page }) => {
  await mock(page);
  await page.goto('/replay.html?e=runa&vs=runb&embed=1');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('canvas:visible')).toHaveCount(2);
  await page.locator('#scrub').fill('3000');
  await expect(page.getByTestId('worth-a')).toHaveAttribute('data-value', String(worth(SMALL)));
  await expect(page.getByTestId('worth-b')).toHaveAttribute('data-value', String(worth(IDLE)));
  await expect(page.locator('header.bar')).toBeHidden();
});

test('export clip records a playable 8-12 second video', async ({ page }) => {
  test.setTimeout(60_000);
  await mock(page);
  await page.goto('/replay.html?e=runa');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready');
  const download = page.waitForEvent('download');
  await page.locator('#btn-clip').click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.(webm|mp4)$/);
  const path = await file.path();
  const bytes = readFileSync(path!);
  expect(bytes.length).toBeGreaterThan(10_000);
  const dataUrl = `data:${file.suggestedFilename().endsWith('mp4') ? 'video/mp4' : 'video/webm'};base64,${bytes.toString('base64')}`;
  const duration = await page.evaluate(async (src) => {
    const v = document.createElement('video');
    v.muted = true;
    v.src = src;
    await new Promise<void>((res, rej) => { v.onloadedmetadata = () => res(); v.onerror = () => rej(new Error('not playable')); });
    // MediaRecorder files carry no duration: seeking far forces the browser to compute it.
    if (!Number.isFinite(v.duration)) {
      v.currentTime = 1e6;
      await new Promise<void>((res) => { v.ontimeupdate = () => { if (Number.isFinite(v.duration)) res(); }; });
    }
    // A frame from the middle must show the farm (many distinct colours), not a blank WebGL buffer.
    const dur = v.duration;
    v.currentTime = dur / 2;
    await new Promise<void>((res) => { v.onseeked = () => res(); });
    await v.play();
    await new Promise((r) => setTimeout(r, 400));
    v.pause();
    const c = document.createElement('canvas');
    c.width = 160; c.height = 90;
    const g = c.getContext('2d')!;
    g.drawImage(v, 0, 0, 160, 90);
    const px = g.getImageData(0, 0, 160, 60).data;
    const colours = new Set<number>();
    for (let i = 0; i < px.length; i += 4) colours.add((px[i]! >> 4) << 8 | (px[i + 1]! >> 4) << 4 | (px[i + 2]! >> 4));
    (window as unknown as { __colours: number }).__colours = colours.size;
    (window as unknown as { __png: string }).__png = c.toDataURL();
    return dur;
  }, dataUrl);
  if (process.env.CLIP_DEBUG) writeFileSync(process.env.CLIP_DEBUG, Buffer.from((await page.evaluate(() => (window as unknown as { __png: string }).__png)).split(',')[1]!, 'base64'));
  expect(await page.evaluate(() => (window as unknown as { __colours: number }).__colours)).toBeGreaterThan(5);
  expect(duration).toBeGreaterThanOrEqual(8);
  expect(duration).toBeLessThanOrEqual(12);
  await expect(page.locator('#clip-status')).toHaveText('Clip saved.');
});

test('sealed and missing runs show clear states', async ({ page }) => {
  await mock(page, ['locked']);
  await page.goto('/replay.html?e=locked');
  await expect(page.locator('#sealed')).toBeVisible();
  await expect(page.locator('#sealed')).toContainText('Sealed until the challenge closes');
  await page.goto('/replay.html?e=nope');
  await expect(page.locator('#error')).toContainText('does not exist');
});

test('replay bundle has no Monaco or language package', () => {
  const dir = fileURLToPath(new URL(`../${process.env.PW_OUT ?? 'dist'}/`, import.meta.url));
  const html = readFileSync(dir + 'replay.html', 'utf8');
  const entryJs = /src="[^"]*\/(assets\/[^"]+\.js)"/.exec(html)![1]!;
  const seen = new Set<string>();
  const walk = (file: string): string => {
    if (seen.has(file)) return '';
    seen.add(file);
    const code = readFileSync(dir + file, 'utf8');
    let all = code;
    for (const m of code.matchAll(/from"\.\/([^"]+\.js)"|import\("\.\/([^"]+\.js)"\)/g)) all += walk('assets/' + (m[1] ?? m[2]));
    return all;
  };
  const code = walk(entryJs);
  expect(code).not.toMatch(/monaco/i);
  expect(code).not.toMatch(/KEYWORDS|monarchTokens|LANGUAGE_VERSION/);
  expect(readdirSync(dir).length).toBeGreaterThan(0);
});
