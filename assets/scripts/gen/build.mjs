// Tendril "living island" asset generator.
//
//   node assets/scripts/gen/build.mjs [--only name1,name2]    
//   node assets/scripts/gen/render.mjs                          (thumbnails + contact sheet, needs Chromium)
//   pnpm assets:check && pnpm assets:copy                       (validate, then copy into packages/client/public/models)
//
// Pure Node, no Blender and no dependencies: lib.mjs builds flat-shaded low-poly meshes and writes binary glTF 2.0
// (one node, one mesh, vertex colours plus a white matte material and an emissive "glow" material), and models.mjs
// holds the shapes in the island palette (grass 4e9a63, soil 6b4636, path d1b98a, stone 58666b, tendril 4fd1b0,
// lantern ffc65a). Output goes to assets/export/<name>.glb with the same <name>.json sidecar as before:
// { name, group, tris, budget, size: [x, depth, height] } and must stay within the budgets in scripts/validate-assets.mjs.
//
// Conventions kept from the Blender scripts: glTF Y up, 1 unit = 1 tile, origin on the tile centre at ground level,
// tiles fill y in [-0.3, 0] (flat top 0.94 wide with a 0.03 chamfer, the 0.06 gap between tiles is left to the
// renderer), everything else stands on y = 0; the drone is centred on its hull (hover height is added by the renderer).
// Props that are not redrawn here (tree, rocks, fence, crate, signpost, water tank, terrace wall) are only recoloured
// to the island palette by tint.mjs, which this script runs last.
//
// Art license: CC BY-NC-SA 4.0 (LICENSE-ART.md). Original shapes, written for this project.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { save } from './lib.mjs';
import * as M from './models.mjs';
import { tintExistingProps } from './tint.mjs';

const dir = path.join(fileURLToPath(new URL('../../', import.meta.url)), 'export');
const argv = process.argv.slice(2);
const only = argv.includes('--only') ? new Set(argv[argv.indexOf('--only') + 1].split(',')) : null;

export function all() {
  const out = [];
  for (const n of ['grass', 'soil', 'wet', 'path', 'water']) out.push(M.tile(`tile_${n}`));
  for (const k of ['carrot', 'wheat', 'clover', 'pumpkin', 'berry', 'apple']) for (let s = 0; s < 4; s++) out.push(M.crop(k, s));
  out.push(M.drone('bot_tender', 0));
  for (const v of [1, 2, 3]) out.push(M.drone(`bot_tender_v${v}`, v));
  out.push(M.barn(), M.stall(), M.beehive(), M.compost(), M.item('item_honey'), M.item('item_compost'));
  for (const n of ['greenhouse', 'windmill', 'silo', 'well', 'scarecrow', 'pond', 'flowers', 'bush', 'lamp', 'cart', 'hay']) out.push(M.prop(`prop_${n}`));
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let total = 0, count = 0;
  for (const model of all()) {
    if (only && !only.has(model.name)) continue;
    const meta = await save(model, dir);
    total += meta.tris; count++;
    console.log(`${meta.name}: ${meta.tris}/${meta.budget} ${meta.size.join('x')}`);
  }
  if (!only) await tintExistingProps(dir);
  console.log(`Built ${count} models, ${total} triangles`);
}
