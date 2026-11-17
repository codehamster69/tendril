// Recolour the models that are not redrawn (tree, rocks, fence, crate, signpost, water tank, terrace wall) to the
// island palette by rewriting their baseColorFactor in place. Idempotent: colours are absolute per material name.
import { readFile, writeFile } from 'node:fs/promises';
import { linear } from './lib.mjs';

const BY_NAME = {
  wood: 0x8a5a3a, wood_dark: 0x5e3d27, leaf: 0x5fb85a, leaf_dark: 0x3f8f5a, leaf_light: 0x7ccd86,
  stone: 0x58666b, stone_dark: 0x444f53, grass: 0x4e9a63, grass_dark: 0x3f8452, path: 0xd1b98a,
  metal: 0x8d9aa0, water: 0x3aa6b0, accent: 0xffc65a, white: 0xf2ecdc, bot_dark: 0x2e3848, bot_light: 0xdfe6ee,
};
export const KEPT = ['prop_tree', 'prop_rocks', 'prop_fence', 'prop_crate', 'prop_signpost', 'prop_water_tank', 'tile_terrace_wall'];

export async function tintExistingProps(dir) {
  for (const name of KEPT) {
    const file = `${dir}/${name}.glb`;
    const buf = await readFile(file);
    const len = buf.readUInt32LE(12);
    const json = JSON.parse(buf.subarray(20, 20 + len).toString('utf8'));
    let changed = false;
    for (const m of json.materials ?? []) {
      const c = BY_NAME[m.name];
      if (c === undefined) continue;
      m.pbrMetallicRoughness.baseColorFactor = [...linear(c), 1];
      changed = true;
    }
    if (!changed) continue;
    let text = Buffer.from(JSON.stringify(json));
    text = Buffer.concat([text, Buffer.alloc((4 - text.length % 4) % 4, 0x20)]);
    const rest = buf.subarray(20 + len); // BIN chunk header and data are unchanged
    const head = Buffer.from(buf.subarray(0, 20));
    head.writeUInt32LE(text.length, 12);
    const out = Buffer.concat([head, text, rest]);
    out.writeUInt32LE(out.length, 8);
    await writeFile(file, out);
    console.log(`tinted ${name}`);
  }
}
