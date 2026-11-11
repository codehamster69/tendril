import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = path.join(root, 'assets/export');
const expected = [
  ...['grass', 'soil', 'wet', 'path', 'terrace_wall'].map((name) => `tile_${name}`),
  ...['fence', 'crate', 'tree', 'rocks', 'signpost'].map((name) => `prop_${name}`),
  ...['carrot', 'wheat', 'clover', 'pumpkin', 'berry'].flatMap((crop) => [0, 1, 2, 3].map((stage) => `crop_${crop}_s${stage}`)),
  'bot_tender', ...[1, 2, 3].map((version) => `bot_tender_v${version}`),
  ...['barn', 'market', 'water_tank', 'beehive', 'compost'].map((name) => `prop_${name}`),
  ...[0, 1, 2, 3].map((stage) => `crop_apple_s${stage}`),
  'item_honey', 'item_compost', 'tile_water',
  ...['greenhouse', 'windmill', 'silo', 'well', 'scarecrow', 'pond', 'flowers', 'bush', 'lamp', 'cart', 'hay']
    .map((name) => `prop_${name}`),
];
const files = await readdir(dir);
const budgets = { tile: 300, crop: 300, bot: 1500, building: 3000, prop: 1500 };
let total = 0;
for (const name of expected) {
  assert(files.includes(`${name}.glb`), `Missing ${name}.glb`);
  const meta = JSON.parse(await readFile(path.join(dir, `${name}.json`), 'utf8'));
  assert.equal(meta.name, name);
  assert.equal(meta.budget, budgets[meta.group], `${name} budget`);
  assert(Number.isSafeInteger(meta.tris) && meta.tris > 0 && meta.tris <= meta.budget, `${name} triangle count`);
  const glb = await readFile(path.join(dir, `${name}.glb`));
  assert.equal(glb.readUInt32LE(0), 0x46546c67, `${name} GLB magic`);
  assert.equal(glb.readUInt32LE(4), 2);
  assert.equal(glb.readUInt32LE(8), glb.length);
  const jsonLength = glb.readUInt32LE(12);
  assert.equal(glb.readUInt32LE(16), 0x4e4f534a);
  const model = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8'));
  let triangles = 0;
  for (const mesh of model.meshes) {
    for (const primitive of mesh.primitives) {
      assert.equal(primitive.mode ?? 4, 4, `${name} non-triangle mesh`);
      const accessor = model.accessors[primitive.indices ?? primitive.attributes.POSITION];
      triangles += accessor.count / 3;
    }
  }
  assert.equal(triangles, meta.tris, `${name} GLB/sidecar triangle parity`);
  assert(!model.animations?.length && !model.skins?.length, `${name} unexpected rig`);
  const png = await readFile(path.join(root, 'assets/thumbs', `${name}.png`));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 256);
  assert.equal(png.readUInt32BE(20), 256);
  total += triangles;
  console.log(`${name}: ${triangles}/${meta.budget}`);
}
assert.equal(files.filter((file) => file.endsWith('.glb')).length, expected.length, 'Unexpected extra models');
console.log(`Validated ${expected.length} GLBs, sidecars and thumbnails; ${total} triangles`);
