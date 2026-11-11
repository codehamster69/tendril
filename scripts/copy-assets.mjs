import { mkdir, readdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'assets/export');
const target = path.join(root, 'packages/client/public/models');
const files = await readdir(source);
const assets = {};
await mkdir(target, { recursive: true });
for (const file of files.sort()) {
  if (!file.endsWith('.json') || file === 'manifest.json') continue;
  const meta = JSON.parse(await readFile(path.join(source, file), 'utf8'));
  const glb = `${meta.name}.glb`;
  if (!files.includes(glb)) throw new Error(`Missing model: ${glb}`);
  if (meta.tris > meta.budget) throw new Error(`Triangle budget exceeded: ${meta.name}`);
  assets[meta.name] = { file: glb, group: meta.group, tris: meta.tris, size: meta.size };
  await copyFile(path.join(source, glb), path.join(target, glb));
}
const manifest = JSON.stringify({ version: 1, assets }, null, 2);
await writeFile(path.join(source, 'manifest.json'), manifest);
await writeFile(path.join(target, 'manifest.json'), manifest);
console.log(`Copied ${Object.keys(assets).length} models`);
