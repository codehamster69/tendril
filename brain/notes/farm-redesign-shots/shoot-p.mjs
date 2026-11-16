// P screenshots: node brain/notes/farm-redesign-shots/shoot-p.mjs <baseURL>   (PW_CHROMIUM=<chromium>, vite preview running)
import { createRequire } from 'node:module';
const require = createRequire('/home/user/tendril/packages/client/package.json');
const { chromium } = require('@playwright/test');
const base = process.argv[2] ?? 'http://localhost:4310';
const out = new URL('.', import.meta.url).pathname;
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
async function open(w, h, name, full = false) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?mode=sandbox`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForSelector('#farm-canvas[data-scene-ready="true"]');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}${name}`, fullPage: full });
  const ov = await page.evaluate(() => ({ sx: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, stage: document.getElementById('farm-stage').getBoundingClientRect().height }));
  console.log(name, JSON.stringify(ov));
  return page;
}
if (!process.env.ONLY_LARGE) {
await open(1400, 900, 'p-wide.png');
await open(900, 800, 'p-mid.png');
await open(390, 844, 'p-phone.png', true);
}
const page = await open(1400, 900, 'p-large-farm.png');
await page.evaluate(() => {
  const s = JSON.parse(JSON.stringify(window.tendril.loop.snapshot()));
  const tiles = [], plots = [];
  for (let py = 0; py < 8; py++) for (let px = 0; px < 8; px++) {
    plots.push({ px, py });
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const tx = px * 8 + x, ty = py * 8 + y, h = (tx * 7 + ty * 13) % 11;
      tiles.push({ x: tx, y: ty, tilled: y > 0 ? 1 : 0, crop: y > 0 && h < 8 ? 1 + (h % 4) : 0, stage: (tx + ty) % 4, moisture: 30 + h * 6, nitrogen: 60, fatigue: 10, building: 0, honey: 0 });
    }
  }
  s.tiles = tiles; s.plots = plots;
  s.bots = [{ x: 9, y: 9, busyUntil: 0, load: 0, items: new Array(9).fill(0), op: null }, { x: 30, y: 22, busyUntil: 0, load: 0, items: new Array(9).fill(0), op: null }];
  window.tendril.view.update(s);
  window.tendril.view.jumpTo(28, 28);
});
const box = await page.locator('#farm-canvas').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -400); await page.waitForTimeout(150); }
await page.waitForTimeout(600);
await page.evaluate(() => document.querySelector('#farm-stage').dispatchEvent(new Event('x')));
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}p-large-farm.png` });
// market open state + light popover
await page.evaluate(() => window.tendril.view.setMarket({ prices: [0, 300, 450, 100, 1200, 400, 500, 800, 0], multipliers: [1000, 1500, 1500, 1000, 2000, 1000, 500, 1000, 1000], shares: null }));
await page.click('.fh-light > summary');
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}p-market-light.png` });
console.log('errors', JSON.stringify(errors));
await browser.close();
