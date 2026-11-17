import { test, expect } from '@playwright/test';

type Box = { left: number; top: number; right: number; bottom: number };
const overlaps = (a: Box, b: Box): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

// The dial used to sit behind the top-left chips and over the camera tool row at common laptop sizes.
for (const [width, height] of [[1280, 720], [1024, 700], [1920, 1080]] as const) {
  test(`the day dial is clear of the chips and the tool row at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/?mode=sandbox');
    await expect(page.locator('#farm-canvas')).toHaveAttribute('data-scene-ready', 'true');
    await expect(page.locator('#day-dial')).toBeVisible();
    await expect.poll(async () => {
      const r = await page.evaluate(() => {
        const box = (sel: string): { left: number; top: number; right: number; bottom: number } | null => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom }; };
        return { dial: box('#day-dial'), hud: box('#game-hud'), tools: box('#stage-tools'), side: box('#side'), style: (document.querySelector('#day-dial') as HTMLElement | null)?.style.cssText };
      });
      if (!r.dial || !r.hud || !r.tools) return 'missing';
      if (overlaps(r.dial, r.hud)) return 'over the chips';
      if (r.tools.top < r.dial.bottom) return 'over the tool row';
      // The boxes go in the message so a failure on a slow runner says where everything was.
      if (r.side && r.side.right - r.side.left > 0 && r.dial.right > r.side.left) return `under the slate ${JSON.stringify(r)}`;
      if (r.dial.left < 0) return 'off screen';
      return 'clear';
    }).toBe('clear');
  });
}
