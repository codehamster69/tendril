// Integration screenshots of the redesigned farm view: node brain/notes/farm-redesign-shots/shoot.mjs <baseURL>
// Needs a running `vite preview` of the built client and PW_CHROMIUM=<chromium binary> (see brain/notes/I.md).
import { createRequire } from 'node:module';
const require = createRequire('/home/user/tendril/packages/client/package.json');
const { chromium } = require('@playwright/test');
import { readFileSync } from 'node:fs';
const base = process.argv[2] ?? 'http://localhost:4310';
const out = new URL('.', import.meta.url).pathname;
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

// 1. live farm after 30 s of a running expander program
await page.goto(`${base}/?mode=sandbox`);
await page.waitForSelector('#farm-canvas[data-scene-ready="true"]');
const src = readFileSync('/home/user/tendril/packages/lang/examples/expander.sprout', 'utf8');
await page.evaluate((s) => window.tendril.editor.setSource(s), src);
await page.selectOption('#speed', '8');
await page.click('#btn-run');
await page.waitForTimeout(30_000);
await page.screenshot({ path: `${out}live-30s.png` });
console.log('live plots', await page.evaluate(() => window.tendril.loop.snapshot().plots.length));

// 2. a 64-plot farm (8 x 8 plots of 8 x 8 tiles = 4096 tiles), pushed straight into the view
await page.goto(`${base}/?mode=sandbox`);
await page.waitForSelector('#farm-canvas[data-scene-ready="true"]');
const stats = await page.evaluate(() => {
  const s = JSON.parse(JSON.stringify(window.tendril.loop.snapshot()));
  const tiles = [], plots = [];
  for (let py = 0; py < 8; py++) for (let px = 0; px < 8; px++) {
    plots.push({ px, py });
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const tx = px * 8 + x, ty = py * 8 + y, h = (tx * 7 + ty * 13) % 11;
      tiles.push({ x: tx, y: ty, tilled: y > 0 ? 1 : 0, crop: y > 0 && h < 8 ? 1 + (h % 4) : 0, stage: (tx + ty) % 4, moisture: 30 + (h * 6), nitrogen: 60, fatigue: 10, building: 0, honey: 0 });
    }
  }
  s.tiles = tiles; s.plots = plots;
  s.bots = [{ x: 9, y: 9, busyUntil: 0, load: 0, items: new Array(9).fill(0), op: null }, { x: 30, y: 22, busyUntil: 0, load: 0, items: new Array(9).fill(0), op: null }, { x: 50, y: 40, busyUntil: 0, load: 0, items: new Array(9).fill(0), op: null }];
  window.tendril.view.update(s);
  return tiles.length;
});
console.log('large farm tiles', stats);
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}large-farm-fit.png` });
await page.evaluate(() => window.tendril.view.focusFarm());
// zoom in on the middle of the farm for the close LOD
await page.evaluate(() => window.tendril.view.jumpTo(28, 28));
const box = await page.locator('#farm-canvas').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, -400); await page.waitForTimeout(150); }
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}large-farm-close.png` });
console.log('lod', await page.locator('#farm-canvas').getAttribute('data-lod'));
console.log('errors', JSON.stringify(errors));
await browser.close();
