import { test, expect, type Page } from '@playwright/test';
import { challengeSetup, createWorld, netWorth, replayChunk } from '@tendril/sim/src/index.ts';
import type { LogEntry } from '@tendril/sim/src/index.ts';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SMALL: LogEntry[] = [[0, 0, 0, 1], [2, 0, 1], [5, 0, 2, 1], [7, 0, 3], [9, 0, 3], [300, 0, 4], [303, 0, 0, 3], [305, 0, 5], [306, 0, 8, 1, 4]];
const IDLE: LogEntry[] = [];
const SEED = 4242, TICKS = 3000;

function worth(actions: LogEntry[]): number {
  const w = createWorld({ id: 'x', seed: SEED }, challengeSetup('daily', SEED).setup);
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
