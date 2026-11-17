import { test, expect, type Page } from '@playwright/test';
import { ready } from './game.ts';

// The farm camera, Home button, price lens and minimap in the real app (sandbox, paused farm).

const target = (page: Page) => page.locator('#farm-canvas').evaluate((c) => JSON.parse(c.dataset.cameraTarget!) as number[]);
const pose = (page: Page) => page.locator('#farm-canvas').evaluate((c) => c.dataset.cameraPosition!);

/** Wait until the camera pose stops changing (easing and momentum are done). */
async function settled(page: Page): Promise<void> {
  // Software-rendered frames can be slow, so require three equal readings in a row, not one.
  let last = '', same = 0;
  await expect.poll(async () => { const now = await pose(page); same = now === last ? same + 1 : 0; last = now; return same; }, { intervals: [350], timeout: 20_000 }).toBeGreaterThanOrEqual(3);
}

async function open(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/?mode=sandbox');
  await ready(page);
  await expect(page.locator('#farm-canvas')).toHaveAttribute('data-scene-ready', 'true');
  await settled(page);
}

const ground = (page: Page, nx: number, ny: number) => page.evaluate(([x, y]) => window.tendril!.view.groundAt(x!, y!), [nx, ny]);

test('wheel zoom keeps the ground point under the cursor', async ({ page }) => {
  test.setTimeout(90_000); // software-rendered frames are slow
  await open(page);
  const box = (await page.locator('#farm-canvas').boundingBox())!;
  const ndc: [number, number] = [-0.35, -0.15]; // left of the code slate, whose grip sits over the right side;
  const px = box.x + (ndc[0] + 1) / 2 * box.width, py = box.y + (1 - ndc[1]) / 2 * box.height;
  const before = (await ground(page, ...ndc))!;
  expect(before).not.toBeNull();
  await page.mouse.move(px, py);
  const d0 = (await page.evaluate(() => JSON.parse(document.getElementById('farm-canvas')!.dataset.cameraPosition!) as number[]));
  await page.mouse.wheel(0, -500);
  await settled(page);
  const closer = await page.evaluate(() => JSON.parse(document.getElementById('farm-canvas')!.dataset.cameraPosition!) as number[]);
  expect(closer).not.toEqual(d0); // the camera really moved in
  // Poll: on a loaded software-GL machine a slow frame can pause the easing, so the settle check alone may read early.
  const drift = async () => { const g = (await ground(page, ...ndc))!; return Math.hypot(g.x - before.x, g.z - before.z); };
  await expect.poll(drift, { timeout: 15_000 }).toBeLessThan(0.05);
  await page.mouse.wheel(0, 300);
  await settled(page);
  await expect.poll(drift, { timeout: 15_000 }).toBeLessThan(0.05);
});

test('Home reframes the farm after the camera was moved', async ({ page }) => {
  test.setTimeout(90_000); // software-rendered frames are slow
  await open(page);
  const home = await target(page);
  const box = (await page.locator('#farm-canvas').boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height * 0.6;
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx - 220, cy - 60, { steps: 10 }); await page.mouse.up();
  await settled(page);
  const moved = await target(page);
  expect(Math.hypot(moved[0]! - home[0]!, moved[2]! - home[2]!)).toBeGreaterThan(0.5); // left-drag pans
  await page.locator('#btn-focus-farm').click();
  await settled(page);
  await expect.poll(async () => { const t = await target(page); return Math.hypot(t[0]! - home[0]!, t[2]! - home[2]!); }, { timeout: 15_000 }).toBeLessThan(0.05);
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 100, cy + 40, { steps: 6 }); await page.mouse.up();
  await settled(page);
  await page.locator('#farm-canvas').focus();
  await page.keyboard.press('Home');
  await expect.poll(async () => { const t = await target(page); return Math.hypot(t[0]! - home[0]!, t[2]! - home[2]!); }, { timeout: 15_000 }).toBeLessThan(0.05);
});

test('price lens is disabled without a market and enabled once one exists', async ({ page }) => {
  test.setTimeout(90_000); // software-rendered frames are slow
  await open(page);
  const price = page.locator('#soil-overlay option[value="price"]');
  await expect(price).toBeDisabled();
  await expect(price).toHaveAttribute('title', /market/i);
  // Choosing it anyway (script) falls back to the natural view.
  await page.evaluate(() => window.tendril!.view.setLens('price'));
  await expect(page.locator('#farm-canvas')).toHaveAttribute('data-overlay', 'none');
  expect(await page.evaluate(() => window.tendril!.view.priceAvailable())).toBe(false);
  await page.evaluate(() => window.tendril!.view.setMarket({ prices: [0, 300, 450, 100, 1200, 400, 500, 800, 0], multipliers: [1000, 1500, 1500, 1000, 2000, 1000, 500, 1000, 1000], shares: null }));
  await expect(price).toBeEnabled();
  await page.locator('#soil-overlay').selectOption('price');
  await expect(page.locator('#farm-canvas')).toHaveAttribute('data-overlay', 'price');
  await page.locator('#soil-overlay').selectOption('none');
});

test('clicking the minimap moves the camera', async ({ page }) => {
  test.setTimeout(90_000); // software-rendered frames are slow
  await open(page);
  // The minimap is a corner widget only on big farms (island-hud.ts); the sandbox starts small, so mark it large.
  await page.evaluate(() => document.body.classList.add('farm-large'));
  const map = page.locator('#farm-minimap-canvas');
  await expect(map).toBeVisible();
  await page.waitForTimeout(400); // the minimap draws at 8 Hz; its frame must exist before the click maps to the world
  const before = await target(page);
  const box = (await map.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.18, box.y + box.height * 0.2);
  await settled(page);
  const after = await target(page);
  expect(Math.hypot(after[0]! - before[0]!, after[2]! - before[2]!)).toBeGreaterThan(0.3);
});
