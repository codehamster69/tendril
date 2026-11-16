import { expect, type Page } from '@playwright/test';

/**
 * Shared steps for specs written before the game-stage redesign.
 * The redesign keeps the old controls in the DOM as hidden "engine" buttons; the stage transport (#tp-play, #tp-step,
 * #tp-sunset) and the menu drive them. Specs that test engine behaviour may press the hidden buttons with `press`.
 */

/** Wait for the splash to leave, then close the start-of-day card (Escape: the day does not start). */
export async function ready(page: Page): Promise<void> {
  await expect(page.locator('#splash')).toHaveCount(0, { timeout: 60_000 });
  const card = page.locator('#start-card');
  if (await card.count()) {
    await page.waitForTimeout(50);
    if (await card.isVisible()) { await page.keyboard.press('Escape'); await expect(card).toBeHidden(); }
  }
}

/** Click a control even if the redesign hides it, once it is enabled (a disabled button ignores clicks, like a real one). */
export async function press(page: Page, selector: string): Promise<void> {
  const loc = page.locator(selector);
  await expect(loc).toBeEnabled();
  await loc.evaluate((el: HTMLElement) => el.click());
}

/** Open the menu and pick an entry by its data-entry id. */
export async function menu(page: Page, entry: string): Promise<void> {
  await page.click('#btn-menu');
  await page.click(`#menu-overlay [data-entry="${entry}"]`);
}
