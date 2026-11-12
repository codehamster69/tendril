// Copies Blender output into public/art/ for the build. Renders (512px, assets/renders) win over
// thumbnails (256px, assets/thumbs). Missing folders are fine: pages fall back to drawn shapes.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const assets = join(site, '..', '..', 'assets');
const out = join(site, 'public', 'art');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

let n = 0;
for (const dir of ['thumbs', 'renders']) {
  const from = join(assets, dir);
  if (!existsSync(from)) continue;
  for (const f of readdirSync(from, { recursive: true })) {
    if (!String(f).endsWith('.png')) continue;
    mkdirSync(dirname(join(out, String(f))), { recursive: true });
    cpSync(join(from, String(f)), join(out, String(f)));
    n++;
  }
}
console.log(`copy-renders: ${n} images into public/art`);
