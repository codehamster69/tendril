import { test, expect, type Page } from '@playwright/test';
import { ready } from './game';

const KEY = 'tendril.workbench.layout';
/** The tab titles of each panel group, in DOM order, e.g. ["Farm", "Console+Debugger", ...]. */
const groups = (page: Page): Promise<string[]> => page.evaluate(() => [...document.querySelectorAll('.dv-groupview')].map((g) => [...g.querySelectorAll('.wb-tab-title')].map((t) => t.textContent).join('+')));
const box = async (page: Page, sel: string): Promise<{ x: number; y: number; width: number; height: number }> => (await page.locator(sel).boundingBox())!;

/** Drag a tab by its name to a point inside another panel's body (a native drag, as a person would). */
async function dragTab(page: Page, panel: string, to: { x: number; y: number }): Promise<void> {
  const tab = await box(page, `.wb-tab[data-panel="${panel}"]`);
  await page.mouse.move(tab.x + 20, tab.y + tab.height / 2);
  await page.mouse.down();
  await page.mouse.move(tab.x + 40, tab.y - 20, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.waitForTimeout(150);
}

test.beforeEach(async ({ page }) => {
  if ((page.viewportSize()?.width ?? 1280) >= 760) await page.setViewportSize({ width: 1280, height: 800 });
});

test('the default layout is Farm first, and the canvas fills its panel', async ({ page }) => {
  await page.goto('/?mode=sandbox');
  await ready(page);
  expect(await groups(page)).toEqual(['Farm', 'Console+Debugger', 'Code+Settings', 'Orders+Reference+Bots+Inspector+Market+Map']);
  // Farm and Code cannot be closed; everything else has a close button.
  await expect(page.locator('.wb-tab[data-panel="farm"] .wb-tab-close')).toHaveCount(0);
  await expect(page.locator('.wb-tab[data-panel="code"] .wb-tab-close')).toHaveCount(0);
  await expect(page.locator('.wb-tab[data-panel="bots"] .wb-tab-close')).toHaveCount(1);
  const [panel, canvas] = [await box(page, '.wb-body[data-panel="farm"]'), await box(page, '#farm-canvas')];
  expect(Math.abs(canvas.width - panel.width)).toBeLessThan(3);
  expect(Math.abs(canvas.height - panel.height)).toBeLessThan(3);
  // No overlapping windows: the code panel starts where the farm panel ends.
  expect(Math.abs((await box(page, '#side')).x - (panel.x + panel.width))).toBeLessThan(3);
});

test('dragging a tab to a panel edge splits it, the farm canvas follows, and a reload keeps the layout', async ({ page }) => {
  await page.goto('/?mode=sandbox');
  await ready(page);
  const before = await box(page, '#farm-canvas');
  const farm = await box(page, '.wb-body[data-panel="farm"]');
  await dragTab(page, 'console', { x: farm.x + farm.width - 20, y: farm.y + farm.height / 2 });
  // The drop preview is a dashed carrot outline with no fill.
  const preview = await page.evaluate(() => { const a = document.querySelector('.dv-drop-target-anchor, .dv-drop-target-selection'); if (!a) return null; const c = getComputedStyle(a); return { style: c.borderTopStyle, fill: c.backgroundColor }; });
  expect(preview).toEqual({ style: 'dashed', fill: 'rgba(0, 0, 0, 0)' });
  await page.mouse.up();
  await expect.poll(() => groups(page)).toEqual(['Farm', 'Console', 'Debugger', 'Code+Settings', 'Orders+Reference+Bots+Inspector+Market+Map']);
  await expect.poll(async () => (await box(page, '#farm-canvas')).width).toBeLessThan(before.width - 100);
  await expect.poll(async () => Math.abs((await box(page, '#farm-canvas')).width - (await box(page, '.wb-body[data-panel="farm"]')).width)).toBeLessThan(3);

  // The layout is saved (versioned) and restored on reload.
  await expect.poll(() => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{}').v, KEY)).toBe(1);
  await page.reload();
  await ready(page);
  expect(await groups(page)).toEqual(['Farm', 'Console', 'Debugger', 'Code+Settings', 'Orders+Reference+Bots+Inspector+Market+Map']);
});

test('dragging a tab to the middle of a panel stacks it as a tab', async ({ page }) => {
  await page.goto('/?mode=sandbox');
  await ready(page);
  const code = await box(page, '.wb-body[data-panel="code"]');
  await dragTab(page, 'console', { x: code.x + code.width / 2, y: code.y + code.height / 2 });
  await page.mouse.up();
  await expect.poll(() => groups(page)).toEqual(['Farm', 'Debugger', 'Code+Settings+Console', 'Orders+Reference+Bots+Inspector+Market+Map']);
});

test('presets, reset, and bad saved data', async ({ page }) => {
  await page.goto('/?mode=sandbox');
  await ready(page);
  await page.click('#btn-layout');
  await page.click('#menu-layout >> text=Code first');
  await expect.poll(() => groups(page)).toEqual(['Code+Settings', 'Farm', 'Console+Orders+Reference+Debugger']);
  await page.click('#btn-layout');
  await page.click('#menu-layout >> text=Debugging');
  await expect.poll(() => groups(page)).toEqual(['Code', 'Console', 'Farm', 'Debugger+Inspector', 'Bots']);
  await page.click('#btn-layout');
  await page.click('#menu-layout >> text=Wide screen');
  await expect.poll(() => groups(page)).toEqual(['Reference+Orders', 'Farm', 'Code', 'Console+Debugger']);
  await page.click('#btn-layout');
  await page.click('#menu-layout >> text=Reset layout');
  await expect.poll(() => groups(page)).toEqual(['Farm', 'Console+Debugger', 'Code+Settings', 'Orders+Reference+Bots+Inspector+Market+Map']);
  // Garbage in storage falls back to the default instead of breaking the screen.
  for (const bad of ['{nope', JSON.stringify({ v: 9, layout: {}, panels: ['farm', 'code'] }), JSON.stringify({ v: 1, layout: { grid: 'x' }, panels: ['farm', 'code'] })]) {
    await page.evaluate(([k, v]) => localStorage.setItem(k!, v!), [KEY, bad]);
    await page.reload();
    await ready(page);
    expect(await groups(page)).toEqual(['Farm', 'Console+Debugger', 'Code+Settings', 'Orders+Reference+Bots+Inspector+Market+Map']);
    await expect(page.locator('#farm-canvas')).toBeVisible();
  }
});

test('Panels reopens closed panels; Ctrl+1..9 focus; Ctrl+W closes; double-click a tab maximises', async ({ page }) => {
  await page.goto('/?mode=sandbox');
  await ready(page);
  await page.locator('.wb-tab[data-panel="bots"] .wb-tab-close').click();
  await expect(page.locator('.wb-tab[data-panel="bots"]')).toHaveCount(0);
  await page.click('#btn-panels');
  await expect(page.locator('#menu-panels [role="menuitemcheckbox"]')).toHaveCount(11);
  await expect(page.locator('#menu-panels [role="menuitemcheckbox"][aria-checked="false"]')).toHaveCount(1);
  await page.click('#menu-panels >> text=Bots');
  await expect(page.locator('.wb-tab[data-panel="bots"]')).toHaveCount(1);
  await expect(page.locator('#bots-panel')).toBeVisible();
  // Ctrl+2 focuses the code panel's editor; Ctrl+3 the console.
  await page.keyboard.press('Control+2');
  await expect(page.locator('#editor .cm-content')).toBeFocused();
  await page.keyboard.press('Control+3');
  await expect(page.locator('#console')).toBeFocused();
  // Ctrl+W closes the focused panel (Console here); Farm and Code ignore it.
  await page.keyboard.press('Control+w');
  await expect(page.locator('.wb-tab[data-panel="console"]')).toHaveCount(0);
  await page.keyboard.press('Control+1');
  await page.keyboard.press('Control+w');
  await expect(page.locator('.wb-tab[data-panel="farm"]')).toHaveCount(1);
  // Double-click maximises the group, and again restores it.
  const code = await box(page, '.wb-body[data-panel="code"]');
  await page.locator('.wb-tab[data-panel="code"]').dblclick();
  await expect.poll(async () => (await box(page, '.wb-body[data-panel="code"]')).width).toBeGreaterThan(code.width + 200);
  await page.locator('.wb-tab[data-panel="code"]').dblclick();
  await expect.poll(async () => Math.abs((await box(page, '.wb-body[data-panel="code"]')).width - code.width)).toBeLessThan(3);
});

test('every feature stays reachable: orders, bots, inspector, map, market, settings, reference', async ({ page }) => {
  await page.goto('/?mode=sandbox');
  await ready(page);
  for (const [id, probe] of [['orders', '#deck-goals .achievement'], ['bots', '#bots-panel'], ['inspector', '#inspector-panel'], ['map', '#farm-minimap-canvas'], ['market', '.wb-market'], ['reference', '#api-reference .api-entry'], ['settings', '#settings-panel']] as const) {
    await page.locator(`.wb-tab[data-panel="${id}"]`).click();
    await expect(page.locator(probe).first(), id).toBeVisible();
  }
  // The menu still opens them.
  await page.click('#btn-menu');
  await page.click('#menu-overlay [data-entry="debugger"]');
  await expect(page.locator('#debugger')).toBeVisible();
});

test('a hidden farm tab stops drawing; showing it again resumes', async ({ page }) => {
  await page.goto('/?mode=sandbox');
  await ready(page);
  const events = await page.evaluate(() => { const seen: boolean[] = []; window.addEventListener('tendril:farm-visible', (e) => seen.push((e as CustomEvent<boolean>).detail)); (window as unknown as { seen: boolean[] }).seen = seen; return seen.length; });
  expect(events).toBe(0);
  // Stack the farm onto the code panel: the farm tab is then hidden behind Code.
  const code = await box(page, '.wb-body[data-panel="code"]');
  await dragTab(page, 'farm', { x: code.x + code.width / 2, y: code.y + code.height / 2 });
  await page.mouse.up();
  await expect.poll(() => groups(page)).toEqual(['Console+Debugger', 'Code+Settings+Farm', 'Orders+Reference+Bots+Inspector+Market+Map']);
  await page.locator('.wb-tab[data-panel="code"]').click(); // Code in front: the farm tab is hidden
  await expect.poll(() => page.evaluate(() => (window as unknown as { seen: boolean[] }).seen.at(-1))).toBe(false);
  await page.locator('.wb-tab[data-panel="farm"]').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { seen: boolean[] }).seen.at(-1))).toBe(true);
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('no docking: farm on top, one panel below, a bottom tab row, a draggable divider', async ({ page }) => {
    await page.goto('/?mode=sandbox');
    await ready(page);
    await expect(page.locator('#wb-phone')).toBeVisible();
    await expect(page.locator('#dock-root')).toBeHidden();
    await expect(page.locator('#btn-layout')).toBeHidden();
    const farm = await box(page, '.wb-phone-farm');
    const phone = await box(page, '#wb-phone');
    // The code panel no longer covers most of the screen: the farm keeps about 40%.
    expect(farm.height / phone.height).toBeGreaterThan(0.3);
    expect(farm.height / phone.height).toBeLessThan(0.5);
    const canvas = await box(page, '#farm-canvas');
    expect(Math.abs(canvas.height - farm.height)).toBeLessThan(3);
    await expect(page.locator('#side')).toBeVisible();
    await expect(page.locator('.wb-phone-tab[aria-selected="true"]')).toHaveText('Code');
    // Switching tabs swaps the panel below the farm; the tab is remembered across a reload.
    await page.click('.wb-phone-tab[data-panel="console"]');
    await expect(page.locator('#console')).toBeVisible();
    await expect(page.locator('#side')).toBeHidden();
    await page.reload();
    await ready(page);
    await expect(page.locator('.wb-phone-tab[aria-selected="true"]')).toHaveText('Console');
    // The divider gives the panel more room.
    await page.locator('.wb-phone-divider').focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowUp');
    await expect.poll(async () => (await box(page, '.wb-phone-farm')).height).toBeLessThan(farm.height - 40);
    // Everything fits the screen width.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
