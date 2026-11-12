import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, expect as playwrightExpect } from '@playwright/test';

const expect = playwrightExpect.configure({ timeout: 30_000 });
const clientDir = fileURLToPath(new URL('../', import.meta.url));
const mainPath = path.join(clientDir, 'electron', 'main.cjs');
const packagedExecutable = process.env.TENDRIL_ELECTRON_EXECUTABLE;
if (packagedExecutable) {
  assert.ok(path.isAbsolute(packagedExecutable), 'Packaged executable path must be absolute');
  await access(packagedExecutable);
} else {
  await access(path.join(clientDir, 'dist', 'index.html'));
}
// Keep all generated data inside this working copy and isolate each smoke run.
const releaseDir = path.join(clientDir, 'release');
await mkdir(releaseDir, { recursive: true });
const profile = await mkdtemp(path.join(releaseDir, 'electron-smoke-'));
const openLog = path.join(profile, 'open-external.log');
const env = { ...process.env, TENDRIL_ELECTRON_SMOKE: '1', TENDRIL_ELECTRON_SMOKE_USER_DATA: profile, TENDRIL_ELECTRON_SMOKE_OPEN_LOG: openLog };
delete env.TENDRIL_API_ORIGIN;
await writeFile(openLog, '');
delete env.VITE_DEV_URL;
delete env.ELECTRON_RUN_AS_NODE;

const rendererErrors = [];
const failedRequests = [];
const modelResponses = [];
const workers = new Set();
const watchedPages = new WeakSet();
function watchPage(page) {
  if (watchedPages.has(page)) return;
  watchedPages.add(page);
  page.on('pageerror', (error) => rendererErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') rendererErrors.push(message.text());
  });
  page.on('requestfailed', (request) => failedRequests.push(`${request.url()}: ${request.failure()?.errorText}`));
  page.on('response', (response) => {
    const { status, url } = { status: response.status(), url: response.url() };
    if (status >= 400) failedRequests.push(`${url}: HTTP ${status}`);
    if (/\.glb(\?|$)/.test(url) && status === 200) modelResponses.push(url);
  });
  page.on('worker', (worker) => workers.add(worker.url()));
}

let application;
let page;
try {
  // macOS uses native ANGLE/Metal; SwiftShader is for headless CI hosts only.
  // Neither path disables the renderer or GPU process sandbox.
  const graphicsArgs = process.platform === 'darwin' ? []
    : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  application = await _electron.launch({
    executablePath: packagedExecutable,
    args: packagedExecutable ? graphicsArgs : [mainPath, ...graphicsArgs],
    chromiumSandbox: true,
    artifactsDir: profile,
    cwd: clientDir,
    env,
    timeout: 60_000,
  });
  application.context().on('page', watchPage);
  for (const page of application.context().pages()) watchPage(page);
  page = await application.firstWindow();
  watchPage(page);
  page.setDefaultTimeout(30_000);
  await page.waitForLoadState('domcontentloaded');
  assert.match(page.url(), /^app:\/\/tendril\//, 'Smoke must exercise the production app:// entry');
  assert.equal(new URL(page.url()).searchParams.get('mode'), 'sandbox');
  await expect(page.locator('#farm-canvas')).toBeVisible();
  await expect(page.locator('#editor .monaco-editor')).toBeVisible();
  await expect(page.locator('#btn-run')).toBeEnabled();
  await page.waitForFunction(() => {
    const canvas = document.getElementById('farm-canvas');
    return canvas instanceof HTMLCanvasElement && canvas.width > 0 && canvas.height > 0;
  });

  const preferences = await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.nodeIntegrationInWorker, false);
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.webSecurity, true);
  assert.equal(await application.evaluate(({ app }) => app.commandLine.hasSwitch('no-sandbox')), false,
    'Automation must not disable Chromium sandboxing');
  assert.equal(await application.evaluate(({ app }) => app.isPackaged), Boolean(packagedExecutable));
  assert.deepEqual(await page.evaluate(() => [typeof window.require, typeof window.process]),
    ['undefined', 'undefined'], 'Renderer must not have Node access');
  assert.equal(await page.evaluate(() => 'tendril' in window), false,
    'Packaged app entry must not expose the localhost-only E2E bridge');

  // The preload bridge exposes exactly one function; the main process allow-lists what it opens.
  assert.equal(await page.evaluate(() => typeof window.tendrilDesktop?.openExternal), 'function');
  assert.deepEqual(await page.evaluate(() => Object.keys(window.tendrilDesktop)), ['openExternal']);
  const nonce = 'ab'.repeat(24);
  const allowed = `https://tendril.hokora.xyz/api/auth/github?desktop=${nonce}`;
  await page.evaluate((urls) => { for (const url of urls) window.tendrilDesktop.openExternal(url); }, [
    'https://example.com', 'http://tendril.hokora.xyz/api/auth/github?desktop=' + nonce,
    'https://tendril.hokora.xyz.evil.com/api/auth/github?desktop=' + nonce, 'file:///etc/passwd', 'javascript:alert(1)',
    'https://tendril.hokora.xyz/api/me', allowed,
  ]);
  // IPC is asynchronous: poll until the one legitimate call is recorded, then check nothing else was.
  await expect.poll(async () => (await readFile(openLog, 'utf8')).trim()).toBe(allowed);
  await page.evaluate(() => window.tendrilDesktop.openExternal('https://example.com'));
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
  assert.equal((await readFile(openLog, 'utf8')).trim(), allowed, 'Only the allowed sign-in URL may be opened');

  // Use real DOM/editor controls, never a mock or a privileged renderer bridge.
  const marker = 'TENDRIL_ELECTRON_SPROUT_SMOKE';
  // No indentation: Monaco would auto-indent typed blocks, and this proves the interpreter without it.
  const source = `say "${marker}"\nwait 5\nsay "second line"`;
  await page.locator('#editor .view-lines').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.insertText(source);
  await expect(page.locator('#editor .view-lines')).toContainText(marker);
  const tick = async () => {
    const text = (await page.locator('#hud-tick').innerText()).replace(/,/g, '').trim();
    assert.match(text, /^\d+$/, 'HUD must show a concrete initialized tick');
    return Number(text);
  };
  const before = await tick();
  await page.locator('#btn-run').click();
  await expect(page.locator('#console')).toContainText(marker, { timeout: 30_000 });
  await expect.poll(tick, { timeout: 30_000 }).toBeGreaterThan(before);
  await page.locator('#btn-pause').click();
  // Wait for the durable pause, not merely the click or an in-flight tick.
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'paused');
  const step = page.locator('#btn-step');
  await expect(step).toBeVisible();
  await expect(step).toBeEnabled();
  const pausedTick = await tick();
  await step.click();
  await expect.poll(tick, { timeout: 30_000 }).toBe(pausedTick + 100);
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'paused');
  await expect(page.locator('#save-status')).toHaveText(`Saved locally · tick ${pausedTick + 100}`);
  await expect(page.locator('#console .err')).toHaveCount(0);
  const canvasImage = await page.locator('#farm-canvas').screenshot();
  const colours = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const distinct = new Set();
    for (let i = 0; i < pixels.length; i += 4) distinct.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]);
    return distinct.size;
  }, canvasImage.toString('base64'));
  assert.ok(colours > 20, `Farm canvas must render more than a blank background (colours: ${colours})`);
  for (const worker of page.workers()) workers.add(worker.url());
  assert.ok([...workers].some((url) => /sim-worker/.test(url)), 'Real simulation Web Worker must be running');

  // Exercise the installed guards without opening a browser or following an
  // external link. A completed DOM event proves the handler ran (no sleeps).
  const entry = page.url();
  assert.equal(await page.evaluate(() => window.open('https://example.com') === null), true);
  await page.evaluate(() => {
    const anchor = document.createElement('a');
    anchor.href = 'https://example.com';
    anchor.textContent = 'Blocked navigation probe';
    anchor.id = 'electron-smoke-navigation-probe';
    document.body.appendChild(anchor);
  });
  await page.locator('#electron-smoke-navigation-probe').click({ noWaitAfter: true });
  assert.equal(page.url(), entry, 'External navigation must stay on the local entry');
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  assert.ok(modelResponses.length > 0 && modelResponses.every((url) => url.startsWith('app://tendril/')), 'Models (.glb) must load over app://');
  assert.deepEqual(rendererErrors, [], 'Renderer errors must be empty');
  assert.deepEqual(failedRequests, [], 'No worker, wasm, model or renderer requests may fail');
  console.log(`Electron smoke passed: sandboxed app:// entry, canvas/editor, real Sprout worker, tick ${before} -> ${await tick()}, ${modelResponses.length} .glb loaded, navigation blocked.`);
} catch (error) {
  console.error('Electron smoke diagnostics:', {
    rendererErrors,
    failedRequests,
    workers: [...workers],
    status: page && !page.isClosed() ? await page.locator('#status').allTextContents().catch(() => []) : [],
  });
  throw error;
} finally {
  try {
    if (application) await application.close();
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}
