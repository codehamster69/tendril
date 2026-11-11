import { test, expect, type Page } from '@playwright/test';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import type * as THREE from 'three';
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { FarmView, FarmOverlay } from '../src/farm-view';
import type { Snapshot } from '../src/sim-types';

// In-memory renderer harness: exercises the actual production module without requiring
// C to expose private renderer internals or changing any application/configuration file.
declare global {
  interface Window {
    __view: FarmView;
    __snapshot: Snapshot;
    __tiles: { x: number; y: number; scan: Snapshot['tiles'][number] }[];
    __finishParse: () => void;
    __parseReady: boolean;
    __disposedMaterials: number;
  }
}
type ViewInspection = {
  batches: Map<string, { meshes: THREE.InstancedMesh[]; model: { parts: { geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[] }[] } }>;
  overlayMesh: THREE.InstancedMesh;
  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
  loader: { gltf: GLTFLoader };
};
let rendererModule = '';
const cropNames = ['carrot', 'wheat', 'clover', 'pumpkin'];
const modelNames = ['tile_grass', 'tile_soil', 'tile_path', 'tile_terrace_wall', 'bot_tender', 'prop_barn', 'prop_tree', 'prop_rocks',
  ...cropNames.flatMap((name) => [0, 1, 2, 3].map((stage) => `crop_${name}_s${stage}`))];

function fixture(): Snapshot {
  const tiles: Snapshot['tiles'] = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const index = y * 8 + x;
    tiles.push({ x, y, tilled: y > 0 ? 1 : 0, crop: index >= 8 && index < 24 ? Math.floor((index - 8) / 4) + 1 : 0,
      stage: index >= 8 && index < 24 ? (index - 8) % 4 : 0,
      moisture: x === 1 ? 0 : x === 2 ? 50 : x === 3 ? 100 : 40,
      nitrogen: x === 1 ? 0 : x === 2 ? 50 : x === 3 ? 100 : 70,
      fatigue: x === 1 ? 0 : x === 2 ? 50 : x === 3 ? 100 : 10,
      building: 0, honey: 0 });
  }
  const items = () => new Array(9).fill(0);
  return { tick: 0, coins: 200, netWorth: 200, weather: 'clear', unlocks: 0, capacity: 20,
    plots: [{ px: 0, py: 0 }], tiles,
    bots: [{ x: 3, y: 4, busyUntil: 0, load: 0, items: items(), op: null },
      { x: 5, y: 2, busyUntil: 0, load: 0, items: items(), op: null }],
    stock: new Array(8).fill(0), orders: [], plotCost: 100, botCost: 100 };
}

// A valid binary glTF, two differently coloured primitives and a translated Y-up node.
// Not a mocked GLTFLoader result: parsing, material merging and GPU instancing are real.
function modelGlb(): Buffer {
  const vertices = new Float32Array([-0.2, 0, 0, 0.2, 0, 0, 0, 0.6, 0]);
  const binary = Buffer.from(vertices.buffer);
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0,
    scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, translation: [0, 0.05, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }, { attributes: { POSITION: 0 }, material: 1 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.29, 0.565, 0.851, 1], metallicFactor: 0, roughnessFactor: 0.85 } },
      { pbrMetallicRoughness: { baseColorFactor: [0.875, 0.902, 0.933, 1], metallicFactor: 0, roughnessFactor: 0.85 } }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-0.2, 0, 0], max: [0.2, 0.6, 0] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: binary.length }], buffers: [{ byteLength: binary.length }] }));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(padded);
  const output = Buffer.alloc(12 + 8 + padded.length + 8 + binary.length);
  output.writeUInt32LE(0x46546c67, 0); output.writeUInt32LE(2, 4); output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(padded.length, 12); output.writeUInt32LE(0x4e4f534a, 16); padded.copy(output, 20);
  const offset = 20 + padded.length;
  output.writeUInt32LE(binary.length, offset); output.writeUInt32LE(0x004e4942, offset + 4); binary.copy(output, offset + 8);
  return output;
}

async function harness(page: Page): Promise<void> {
  await page.route('**/__view/renderer.js', (route) => route.fulfill({ contentType: 'text/javascript', body: rendererModule }));
  await page.route('**/__view/sandbox?mode=sandbox', (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
    <html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Renderer sandbox</title></head>
    <body style="margin:0"><canvas id="farm-canvas" style="display:block;width:900px;height:650px"></canvas>
    <script type="module">import { FarmView } from './renderer.js';
    window.__snapshot = ${JSON.stringify(fixture())}; window.__tiles = [];
    const canvas = document.getElementById('farm-canvas');
    canvas.addEventListener('tendril:tile', event => window.__tiles.push(event.detail));
    window.__view = new FarmView(canvas); window.__view.update(window.__snapshot);</script></body></html>` }));
  await page.goto('/__view/sandbox?mode=sandbox');
  await expect(page.locator('#farm-canvas')).toHaveAttribute('data-scene-ready', 'true');
}

async function colors(page: Page, attribute: string): Promise<string[]> {
  return page.locator('#farm-canvas').evaluate((canvas, name) =>
    (JSON.parse(canvas.getAttribute(name)!) as { color: string }[]).map((entry) => entry.color), attribute);
}

async function projectedTile(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(({ x, y }) => {
    const view = window.__view as unknown as ViewInspection;
    // Reuse a vector supplied by the actual Three scene, avoiding a separate Three bundle.
    const vector = view.camera.position.clone().set(x, 0, y).project(view.camera);
    const rect = document.getElementById('farm-canvas')!.getBoundingClientRect();
    return { x: rect.left + (vector.x + 1) * rect.width / 2, y: rect.top + (1 - vector.y) * rect.height / 2 };
  }, { x, y });
}

test.beforeAll(async () => {
  const result = await build({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), base: './', logLevel: 'silent',
    build: { write: false, minify: false, lib: { entry: fileURLToPath(new URL('../src/farm-view.ts', import.meta.url)), formats: ['es'], name: 'FarmRenderer' } } });
  const outputs = Array.isArray(result) ? result : [result];
  for (const output of outputs) if ('output' in output) for (const chunk of output.output) {
    if (chunk.type === 'chunk' && chunk.isEntry) rendererModule = chunk.code;
  }
  expect(rendererModule).toContain('FarmView');
});

test('initial app scene is a deterministic paused sandbox, not a blank canvas', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  // Expected absence, without browser-generated 404 diagnostics obscuring JS errors.
  await page.route('**/models/manifest.json', (route) => route.fulfill({ status: 204 }));
  await page.goto('/?mode=sandbox');
  const canvas = page.locator('#farm-canvas');
  await expect(canvas).toHaveAttribute('data-scene-ready', 'true');
  await expect(canvas).toHaveAttribute('data-rendered-tiles', '64');
  await expect(canvas).toHaveAttribute('data-models-loaded', '0');
  await expect(canvas).toHaveAttribute('data-models-status', 'fallback');
  await expect(page.locator('#hud-tick')).toHaveText('0');
  expect(await page.evaluate(() => window.tendril?.loop.snapshot()?.plots)).toEqual([{ px: 0, py: 0 }]);
  const image = await canvas.screenshot();
  const count = await page.evaluate(async (base64) => {
    const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const values = new Set<number>();
    for (let i = 0; i < pixels.length; i += 4) values.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]);
    return values.size;
  }, image.toString('base64'));
  expect(count).toBeGreaterThan(50);
  expect(errors).toEqual([]);
});

test('missing manifest is quiet; overlays use the full percentage range and actual instance colors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  // Exercise Vite's actual missing-public-file behavior (HTML SPA fallback).
  await page.route('**/__view/models/manifest.json', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }));
  await harness(page);
  const canvas = page.locator('#farm-canvas');
  await expect(canvas).toHaveAttribute('data-models-status', 'fallback');
  await expect(canvas).toHaveAttribute('data-models-errors', '');
  const terrain = await colors(page, 'data-tile-colors');
  expect(new Set(terrain.slice(1, 4)).size).toBe(3); // 0, 50, 100 must not all clamp to 1.
  const screenshots: string[] = [];
  const endpoints = { moisture: ['e0bb79', '287caf'], nitrogen: ['e0c898', '468653'], fatigue: ['8fc3a4', 'bf6650'] };
  for (const overlay of ['moisture', 'nitrogen', 'fatigue'] as const) {
    await page.evaluate((overlay: FarmOverlay) => window.__view.setOverlay(overlay), overlay);
    await expect(canvas).toHaveAttribute('data-overlay', overlay);
    const rendered = await colors(page, 'data-overlay-colors');
    expect(rendered[1]).toBe(endpoints[overlay][0]); expect(rendered[3]).toBe(endpoints[overlay][1]);
    expect(new Set(rendered.slice(1, 4)).size).toBe(3);
    const actual = await page.evaluate(() => {
      const mesh = (window.__view as unknown as ViewInspection).overlayMesh;
      const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
      const color = material.color.clone();
      return [1, 2, 3].map((index) => { mesh.getColorAt(index, color); return color.getHexString(); });
    });
    expect(actual).toEqual(rendered.slice(1, 4));
    screenshots.push((await canvas.screenshot()).toString('base64'));
  }
  expect(new Set(screenshots).size).toBe(3);
  await page.evaluate(() => window.__view.setOverlay('none'));
  expect(await colors(page, 'data-overlay-colors')).toEqual([]);
  expect(await page.evaluate(() => (window.__view as unknown as ViewInspection).overlayMesh.visible)).toBe(false);
  expect(errors).toEqual([]);
});

test('GLBs replace placeholders with combined palette-aware instancing and sixteen crop stages', async ({ page }) => {
  const glb = modelGlb();
  await page.route('**/__view/models/manifest.json', (route) => route.fulfill({ json: { version: 1,
    assets: Object.fromEntries(modelNames.map((name) => [name, { file: `${name}.glb`, group: 'crop', tris: 2, size: [0.4, 0, 0.6] }])) } }));
  await page.route('**/__view/models/*.glb', (route) => route.fulfill({ contentType: 'model/gltf-binary', body: glb }));
  await harness(page);
  const canvas = page.locator('#farm-canvas');
  await expect(canvas).toHaveAttribute('data-models-status', 'ready');
  await expect(canvas).toHaveAttribute('data-models-loaded', String(modelNames.length));
  const inspection = await page.evaluate(() => {
    const view = window.__view as unknown as ViewInspection;
    const bot = view.batches.get('bot_tender')!;
    const source = bot.model.parts[0];
    const materials = Array.isArray(source.material) ? source.material : [source.material];
    return { botMeshes: bot.meshes.length, botCount: bot.meshes[0].count, groups: source.geometry.groups.map((group) => group.materialIndex),
      colors: materials.map((material) => (material as THREE.MeshStandardMaterial).color.toArray()),
      bottom: source.geometry.boundingBox!.min.y, top: source.geometry.boundingBox!.max.y,
      stages: [...view.batches].filter(([name]) => name.startsWith('crop_')).map(([name, batch]) => [name, batch.meshes[0].count]),
      terrainMeshes: view.batches.get('tile_grass')!.meshes.length };
  });
  expect(inspection.botMeshes).toBe(1); expect(inspection.botCount).toBe(2); expect(inspection.terrainMeshes).toBe(1);
  expect(inspection.groups).toEqual([0, 1]);
  expect(inspection.colors[0][0]).toBeCloseTo(0.29); expect(inspection.colors[1][0]).toBeCloseTo(0.875);
  expect(inspection.bottom).toBeCloseTo(0.05); expect(inspection.top).toBeCloseTo(0.65); // No second Z-up rotation/recentering.
  expect(inspection.stages).toHaveLength(16);
  expect(inspection.stages.every(([, count]) => count === 1)).toBe(true);
});

test('expansion and same-count negative relocation do not pan; explicit focus and tile scan work', async ({ page }) => {
  await page.route('**/__view/models/manifest.json', (route) => route.fulfill({ status: 204 }));
  await harness(page);
  const canvas = page.locator('#farm-canvas');
  const initialTarget = await canvas.getAttribute('data-camera-target');
  await page.evaluate(() => {
    const extra = window.__snapshot.tiles.map((tile) => ({ ...tile, x: tile.x - 8 }));
    window.__snapshot.tiles.push(...extra); window.__snapshot.plots.push({ px: -1, py: 0 });
    window.__view.update(window.__snapshot);
  });
  expect(await canvas.getAttribute('data-camera-target')).toBe(initialTarget);
  await expect(canvas).toHaveAttribute('data-rendered-tiles', '128');
  await page.evaluate(() => window.__view.focusFarm());
  const farmTarget = JSON.parse((await canvas.getAttribute('data-camera-target'))!) as number[];
  [-0.5, 0, 3.5].forEach((value, index) => expect(farmTarget[index]).toBeCloseTo(value, 8));
  const point = await projectedTile(page, -5, 3);
  await page.mouse.click(point.x, point.y);
  const expectedScan = { ...fixture().tiles.find((tile) => tile.x === 3 && tile.y === 3)!, x: -5 };
  expect(await page.evaluate(() => window.__tiles.at(-1))).toEqual({ x: -5, y: 3, scan: expectedScan });
  const stable = await canvas.getAttribute('data-camera-target');
  await page.evaluate(() => {
    window.__snapshot.tiles = window.__snapshot.tiles.map((tile) => ({ ...tile, x: tile.x - 8 }));
    window.__view.update(window.__snapshot);
  });
  expect(await canvas.getAttribute('data-camera-target')).toBe(stable);
  const translated = await page.evaluate(() => {
    const batch = (window.__view as unknown as ViewInspection).batches.get('tile_grass')!;
    return batch.meshes[0].instanceMatrix.array[12];
  });
  expect(translated).toBe(-8);
  await page.evaluate(() => window.__view.selectBot(1));
  await expect(canvas).toHaveAttribute('data-selected-bot', '1');
  const botTarget = JSON.parse((await canvas.getAttribute('data-camera-target'))!) as number[];
  [5, 0, 2].forEach((value, index) => expect(botTarget[index]).toBeCloseTo(value, 8));
  const before = await page.evaluate(() => window.__tiles.length);
  const outside = await projectedTile(page, 7, 3);
  await page.mouse.click(outside.x, outside.y);
  expect(await page.evaluate(() => window.__tiles.length)).toBe(before);
});

test('malformed manifest and GLB errors surface status, while an absent named file keeps its fallback', async ({ page }) => {
  await page.route('**/__view/models/manifest.json', (route) => route.fulfill({ contentType: 'application/json', body: '{ broken' }));
  await harness(page);
  const canvas = page.locator('#farm-canvas');
  await expect(canvas).toHaveAttribute('data-models-status', 'error');
  await expect(canvas).toHaveAttribute('data-models-errors', /manifest is invalid/);
  await page.unroute('**/__view/models/manifest.json');
  await page.route('**/__view/models/manifest.json', (route) => route.fulfill({ json: { version: 1,
    assets: { bot_tender: { file: 'bot_tender.glb' }, prop_barn: { file: 'prop_barn.glb' }, tile_grass: { file: 'tile_grass.glb' } } } }));
  await page.route('**/__view/models/bot_tender.glb', (route) => route.fulfill({ contentType: 'model/gltf-binary', body: modelGlb() }));
  await page.route('**/__view/models/prop_barn.glb', (route) => route.fulfill({ status: 204 }));
  await page.route('**/__view/models/tile_grass.glb', (route) => route.fulfill({ contentType: 'model/gltf-binary', body: 'not glTF' }));
  await page.reload();
  await expect(canvas).toHaveAttribute('data-models-status', 'partial');
  await expect(canvas).toHaveAttribute('data-models-loaded', '1');
  await expect(canvas).toHaveAttribute('data-models-errors', /tile_grass:/);
  expect(await page.evaluate(() => (window.__view as unknown as ViewInspection).batches.get('prop_barn')!.meshes[0].count)).toBe(1);
});

test('a GLTF parse finishing after disposal frees its materials without resurrecting the view', async ({ page }) => {
  let deliver!: () => void;
  const pending = new Promise<void>((resolve) => { deliver = resolve; });
  await page.route('**/__view/models/manifest.json', (route) => route.fulfill({ json: { version: 1,
    assets: { bot_tender: { file: 'bot_tender.glb' } } } }));
  await page.route('**/__view/models/bot_tender.glb', async (route) => {
    await pending;
    await route.fulfill({ contentType: 'model/gltf-binary', body: modelGlb() });
  });
  await harness(page);
  await page.evaluate(() => {
    window.__parseReady = false; window.__disposedMaterials = 0;
    const loader = (window.__view as unknown as ViewInspection).loader.gltf;
    const parse = loader.parseAsync.bind(loader);
    loader.parseAsync = async (buffer, path) => {
      const gltf = await parse(buffer, path);
      const materials = new Set<THREE.Material>();
      gltf.scene.traverse((object) => {
        if ('isMesh' in object && object.isMesh) {
          const source = (object as THREE.Mesh).material;
          for (const material of Array.isArray(source) ? source : [source]) materials.add(material);
        }
      });
      materials.forEach((material) => material.addEventListener('dispose', () => { window.__disposedMaterials++; }));
      await new Promise<void>((resolve) => { window.__finishParse = resolve; window.__parseReady = true; });
      return gltf;
    };
  });
  deliver();
  await expect.poll(() => page.evaluate(() => window.__parseReady)).toBe(true);
  await page.evaluate(() => { window.__view.dispose(); window.__finishParse(); });
  await expect.poll(() => page.evaluate(() => window.__disposedMaterials)).toBe(2);
  await expect(page.locator('#farm-canvas')).toHaveAttribute('data-models-status', 'disposed');
  await expect(page.locator('#farm-canvas')).toHaveAttribute('data-models-loaded', '0');
});

if (process.env.V_ASSETS === '1') test('exported art loads all 39 real GLBs and keeps the farm readable', async ({ page }, testInfo) => {
  const assetRoot = new URL('../../../assets/export/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', assetRoot), 'utf8')) as { version: number; assets: Record<string, { file: string }> };
  expect(Object.keys(manifest.assets)).toHaveLength(39);
  await page.route('**/__view/models/manifest.json', (route) => route.fulfill({ json: manifest }));
  await page.route('**/__view/models/*.glb', async (route) => {
    const file = new URL(route.request().url()).pathname.split('/').at(-1)!;
    await route.fulfill({ contentType: 'model/gltf-binary', body: await readFile(new URL(file, assetRoot)) });
  });
  await harness(page);
  const canvas = page.locator('#farm-canvas');
  await expect(canvas).toHaveAttribute('data-models-status', 'ready');
  await expect(canvas).toHaveAttribute('data-models-loaded', '39');
  await expect(canvas).toHaveAttribute('data-models-errors', '');
  const stats = await page.evaluate(() => {
    const view = window.__view as unknown as ViewInspection;
    const bot = view.batches.get('bot_tender')!;
    return { botHeight: bot.model.parts[0].geometry.boundingBox!.max.y,
      botParts: bot.meshes.length, tileParts: view.batches.get('tile_grass')!.meshes.length,
      cropParts: [...view.batches].filter(([name]) => name.startsWith('crop_')).map(([, batch]) => batch.meshes.length) };
  });
  expect(stats.botHeight).toBeGreaterThan(0.6); expect(stats.botHeight).toBeLessThan(0.8);
  expect(stats.botParts).toBe(1); expect(stats.tileParts).toBe(1);
  expect(stats.cropParts.every((count) => count === 1)).toBe(true);
  await canvas.screenshot({ path: testInfo.outputPath('renderer-art.png') });
  // With the coordinator's assets:copy complete, also verify the real application
  // bootstrap and BASE_URL paths, rather than only the isolated renderer harness.
  await page.goto('/?mode=sandbox');
  await expect(canvas).toHaveAttribute('data-scene-ready', 'true');
  await expect(canvas).toHaveAttribute('data-models-status', 'ready');
  await expect(canvas).toHaveAttribute('data-models-loaded', '39');
  await expect(canvas).toHaveAttribute('data-models-errors', '');
  await canvas.screenshot({ path: testInfo.outputPath('renderer-app.png') });
});

test('disposal during a pending asset request stays disposed and releases instances', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/__view/models/manifest.json', async (route) => {
    await pending;
    await route.fulfill({ json: { version: 1, assets: { bot_tender: { file: 'bot_tender.glb' } } } }).catch(() => {});
  });
  await harness(page);
  await page.evaluate(() => { window.__view.dispose(); window.__view.dispose(); window.__view.update(window.__snapshot); });
  release();
  const canvas = page.locator('#farm-canvas');
  await expect(canvas).toHaveAttribute('data-models-status', 'disposed');
  await expect(canvas).toHaveAttribute('data-models-loaded', '0');
  expect(await page.evaluate(() => (window.__view as unknown as ViewInspection).batches.size)).toBe(0);
  expect(await page.evaluate(() => (window.__view as unknown as ViewInspection).scene.children.length)).toBe(0);
});
