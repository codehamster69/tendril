import { test, expect, type Page } from '@playwright/test';

const PACKET = {
  id: 'abcDEF12_-x', name: 'Barn runner', note: 'Walks to the barn.', tags: ['tiny'], origin: 'endless', plants: 2, plantsThisWeek: 1, parentId: null, createdAt: 1_700_000_000_000,
  author: { login: 'ann', displayName: 'ann', avatarUrl: null }, source: '# Barn runner\nrepeat forever:\n    go_to barn\n    sell carrot, all\n',
};

async function mockPackets(page: Page): Promise<{ plants: string[]; shared: unknown[] }> {
  const seen = { plants: [] as string[], shared: [] as unknown[] };
  await page.route('**/api/packets**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === 'POST' && path.endsWith('/plant')) { seen.plants.push(path); return route.fulfill({ json: { planted: true, plants: 3 } }); }
    if (req.method() === 'POST') { seen.shared.push(req.postDataJSON()); return route.fulfill({ status: 201, json: { id: 'zzzzzzzzzzz', parentId: seen.shared.length ? 'abcDEF12_-x' : null } }); }
    if (path === '/api/packets') return route.fulfill({ json: { sort: 'popular', tag: null, packets: [{ ...PACKET, source: undefined }] } });
    return route.fulfill({ json: PACKET });
  });
  await page.route('**/api/me', (route) => route.fulfill({ json: { profile: { id: 'u1', login: 'bob', displayName: 'bob', avatarUrl: null } } }));
  return seen;
}

test('an empty editor offers a popular packet; planting loads it and counts a plant', async ({ page }) => {
  const seen = await mockPackets(page);
  await page.goto('/?mode=sandbox');
  await expect(page.locator('#splash')).toHaveCount(0, { timeout: 60_000 });
  await page.evaluate(() => window.tendril!.editor.setSource(''));
  const offer = page.locator('#pk-empty');
  await expect(offer).toBeVisible();
  await offer.getByRole('button', { name: 'Start from a popular packet' }).click();
  const dialog = page.locator('.pk-dialog');
  await expect(dialog).toContainText('Barn runner');
  await expect(dialog).toContainText('by ann · 2 plants');
  await dialog.getByRole('button', { name: 'Plant this' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.tendril!.editor.getSource())).toBe(PACKET.source);
  await expect(offer).toBeHidden();
  expect(seen.plants).toEqual(['/api/packets/abcDEF12_-x/plant']);
});

test('planting over your own code asks first; keeping it changes nothing', async ({ page }) => {
  await mockPackets(page);
  await page.goto('/?mode=sandbox&plant=abcDEF12_-x');
  await expect(page.locator('#splash')).toHaveCount(0, { timeout: 60_000 });
  await page.evaluate(() => window.tendril!.editor.setSource('say 42\n'));
  await page.evaluate(() => window.dispatchEvent(new Event('tendril:open-packets')));
  await page.locator('.pk-dialog').getByRole('button', { name: 'Plant this' }).click();
  await expect(page.locator('.pk-dialog')).toContainText('will replace the code in your editor');
  await page.getByRole('button', { name: 'Keep my code' }).click();
  expect(await page.evaluate(() => window.tendril!.editor.getSource())).toBe('say 42\n');
});

test('planting is off on a daily, with the reason on the button', async ({ page }) => {
  await mockPackets(page);
  await page.goto('/?mode=daily');
  await expect(page.locator('#splash')).toHaveCount(0, { timeout: 60_000 });
  await page.evaluate(() => { document.getElementById('start-card')?.remove(); });
  await page.click('#btn-packets');
  const plant = page.locator('.pk-dialog').getByRole('button', { name: 'Plant this' });
  await expect(plant).toBeDisabled();
  await expect(page.locator('.pk-dialog')).toContainText('Planting is off while a daily or season is open');
});

test('Share sends the editor program as a remix of the planted packet', async ({ page }) => {
  const seen = await mockPackets(page);
  await page.goto('/?mode=sandbox');
  await expect(page.locator('#splash')).toHaveCount(0, { timeout: 60_000 });
  await page.evaluate(() => window.tendril!.editor.setSource(''));
  await page.click('#btn-packets');
  await page.locator('.pk-dialog').getByRole('button', { name: 'Plant this' }).click();
  await expect(page.locator('.pk-dialog')).toHaveCount(0);
  await page.evaluate(() => window.tendril!.editor.setSource(window.tendril!.editor.getSource() + 'say 1\n'));
  await page.click('#btn-share-packet');
  await page.fill('#pk-name', 'Barn runner, chatty');
  await page.check('.pk-tagpick input[value="tiny"]');
  await page.locator('.pk-form').getByRole('button', { name: 'Share packet' }).click();
  await expect(page.locator('.pk-link input')).toHaveValue(/\/packets\/zzzzzzzzzzz$/);
  expect(seen.shared).toEqual([{ name: 'Barn runner, chatty', note: '', tags: ['tiny'], source: `${PACKET.source}say 1\n`, parentId: 'abcDEF12_-x', origin: 'sandbox' }]);
});

test('Share refuses a program that does not compile', async ({ page }) => {
  await mockPackets(page);
  await page.goto('/?mode=sandbox');
  await expect(page.locator('#splash')).toHaveCount(0, { timeout: 60_000 });
  await page.evaluate(() => window.tendril!.editor.setSource('repeat forever\n  oops(\n'));
  await page.click('#btn-share-packet');
  await expect(page.locator('#toast-host')).toContainText('Fix this first');
  await expect(page.locator('.pk-dialog')).toHaveCount(0);
});
