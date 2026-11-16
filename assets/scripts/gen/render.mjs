// Render 256 px thumbnails (assets/thumbs/<name>.png, transparent) and a contact sheet of every exported GLB with
// three's GLTFLoader in headless Chromium. Needs the pre-installed Chromium (set CHROMIUM, default /opt/pw-browsers/chromium)
// and the repo's playwright + three packages. Usage: node assets/scripts/gen/render.mjs [sheet.png] [--only a,b]
import http from 'node:http';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(path.join(root, 'packages/client/package.json'));
const { chromium } = require('@playwright/test');
const threeDir = path.resolve(path.dirname(require.resolve('three')), '..');
const argv = process.argv.slice(2);
const sheetPath = argv.find((a) => a.endsWith('.png'));
const only = argv.includes('--only') ? new Set(argv[argv.indexOf('--only') + 1].split(',')) : null;
const names = (await readdir(path.join(root, 'assets/export'))).filter((f) => f.endsWith('.glb')).map((f) => f.slice(0, -4)).sort();

const html = `<!doctype html><meta charset=utf-8><body style="margin:0;background:#0f2a2e">
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
const names = ${JSON.stringify(names)}, only = ${JSON.stringify(only ? [...only] : null)};
const S = 256, canvas = document.createElement('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
renderer.setSize(S, S, false); renderer.setPixelRatio(1); renderer.setClearColor(0x000000, 0);
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xdff4ff, 0x4a3a2e, 1.7));
const sun = new THREE.DirectionalLight(0xfff0d0, 2.6); sun.position.set(-2, 4, 3); scene.add(sun);
const loader = new GLTFLoader(), shots = {};
for (const name of names) {
  if (only && !only.includes(name)) continue;
  const gltf = await loader.loadAsync('/assets/export/' + name + '.glb');
  scene.add(gltf.scene);
  const box = new THREE.Box3().setFromObject(gltf.scene), c = box.getCenter(new THREE.Vector3()), r = box.getBoundingSphere(new THREE.Sphere()).radius;
  const cam = new THREE.PerspectiveCamera(30, 1, 0.01, 50);
  const dir = new THREE.Vector3(0.9, 0.85, 1.2).normalize();
  cam.position.copy(c).addScaledVector(dir, r * 3.1); cam.lookAt(c);
  renderer.render(scene, cam);
  shots[name] = canvas.toDataURL('image/png');
  scene.remove(gltf.scene);
}
window.__shots = shots;
const keys = Object.keys(shots), cols = 10, cw = 176, ch = 196, rows = Math.ceil(keys.length / cols);
const sheet = document.createElement('canvas'); sheet.width = cols * cw; sheet.height = rows * ch;
const g = sheet.getContext('2d'); const bg = g.createLinearGradient(0, 0, 0, sheet.height);
bg.addColorStop(0, '#16424a'); bg.addColorStop(1, '#0b2226'); g.fillStyle = bg; g.fillRect(0, 0, sheet.width, sheet.height);
await Promise.all(keys.map((k, i) => new Promise((res) => { const im = new Image(); im.onload = () => {
  const x = (i % cols) * cw, y = Math.floor(i / cols) * ch;
  g.drawImage(im, x + 4, y + 4, 168, 168); g.fillStyle = '#9fd8c8'; g.font = '12px monospace'; g.textAlign = 'center'; g.fillText(k, x + cw / 2, y + ch - 10); res(); }; im.src = shots[k]; })));
window.__sheet = sheet.toDataURL('image/png'); window.__done = true;
</script>`;

const type = { '.js': 'text/javascript', '.glb': 'model/gltf-binary', '.html': 'text/html' };
const server = http.createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
    const file = url.startsWith('/three/') ? path.join(threeDir, url.slice(7)) : path.join(root, url);
    res.setHeader('content-type', type[path.extname(file)] ?? 'application/octet-stream');
    res.end(await readFile(file));
  } catch { res.statusCode = 404; res.end(); }
}).listen(0);
const port = server.address().port;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('console', m.text()); });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction('window.__done', null, { timeout: 120000 });
  const shots = await page.evaluate('window.__shots');
  const sheet = await page.evaluate('window.__sheet');
  const png = (d) => Buffer.from(d.split(',')[1], 'base64');
  await mkdir(path.join(root, 'assets/thumbs'), { recursive: true });
  for (const [name, data] of Object.entries(shots)) await writeFile(path.join(root, 'assets/thumbs', `${name}.png`), png(data));
  if (sheetPath) { await mkdir(path.dirname(path.resolve(sheetPath)), { recursive: true }); await writeFile(path.resolve(sheetPath), png(sheet)); }
  console.log(`Rendered ${Object.keys(shots).length} thumbnails${sheetPath ? ` and ${sheetPath}` : ''}`);
} finally { await browser.close(); server.close(); }
