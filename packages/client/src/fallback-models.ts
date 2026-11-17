import * as THREE from 'three';
import type { AssetModel, AssetPart } from './asset-loader';

/** Crop ids 1..6 (rules v3) and item ids 1..8. Index equals the simulation id. */
export const CROPS = ['', 'carrot', 'wheat', 'clover', 'pumpkin', 'berry', 'apple'];
export const ITEM_NAMES = [...CROPS, 'honey', 'compost'];
export const BUILDING_MODELS = ['', 'prop_beehive', 'prop_compost', 'prop_silo'];
export const CROP_COLORS = [0, 0xf08a24, 0xe6c34a, 0x8fbf6a, 0xd2601a, 0x8a3a8f, 0xc83a32];
const ITEM_COLORS = [0, ...CROP_COLORS.slice(1), 0xe8a92a, 0x6b4a2b];

export const matte = (color: number): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({ color, roughness: 0.9, flatShading: true });
const glow = (color: number): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.9, roughness: 0.4 });
export const part = (geometry: THREE.BufferGeometry, color: number): AssetPart => ({ geometry, material: matte(color) });

type Spec = { p?: [number, number, number]; r?: [number, number, number]; s?: [number, number, number] };
const at = (g: THREE.BufferGeometry, t: Spec = {}): THREE.BufferGeometry => {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(...(t.p ?? [0, 0, 0])), new THREE.Quaternion().setFromEuler(new THREE.Euler(...(t.r ?? [0, 0, 0]))), new THREE.Vector3(...(t.s ?? [1, 1, 1])));
  return g.applyMatrix4(m);
};
/** Cone or frustum standing on y = 0. */
const cone = (rt: number, rb: number, h: number, seg: number): THREE.BufferGeometry => new THREE.CylinderGeometry(rt, rb, h, seg).translate(0, h / 2, 0);
const STAGE_SIZE = [0.34, 0.58, 0.82, 1];

/** Island palette: grass 4e9a63, soil 6b4636, path d1b98a, stone 58666b, tendril 4fd1b0, lantern ffc65a. */
function tileParts(name: string): AssetPart[] {
  const top = name === 'tile_soil' ? 0x6b4636 : name === 'tile_wet' ? 0x4a2f26 : name === 'tile_path' ? 0xd1b98a : name === 'tile_water' ? 0x3aa6b0 : 0x4e9a63;
  const rim = name === 'tile_water' ? 0x72828a : top;
  // Flat 0.94 top, dark soil body: the renderer leaves the 0.06 gap between tiles.
  const parts = [part(new THREE.BoxGeometry(0.94, 0.3, 0.94).translate(0, -0.15, 0), name === 'tile_grass' || name === 'tile_path' ? 0x6b4636 : top)];
  parts.push(part(new THREE.PlaneGeometry(0.88, 0.88).rotateX(-Math.PI / 2).translate(0, 0.002, 0), name === 'tile_water' ? rim : top));
  if (name === 'tile_water') parts.push(part(new THREE.PlaneGeometry(0.62, 0.62).rotateX(-Math.PI / 2).translate(0, 0.004, 0), top));
  return parts;
}

/** Crop clusters after the mockup: flat shaded, standing on y = 0, stage drives size. */
function cropParts(crop: number, stage: number): AssetPart[] {
  const g = STAGE_SIZE[stage];
  const out: AssetPart[] = [];
  const add = (geo: THREE.BufferGeometry, color: number, t?: Spec) => out.push(part(at(geo, t), color));
  if (crop === 1) { // carrot
    const n = [2, 3, 5, 5][stage];
    for (let k = 0; k < n; k++) { const a = k * 1.26; add(cone(0, 0.07, 0.5 * g, 5), 0x5fb85a, { p: [Math.cos(a) * 0.06 * g, 0.02, Math.sin(a) * 0.06 * g], r: [Math.sin(a) * 0.35, 0, -Math.cos(a) * 0.35] }); }
    if (stage >= 2) add(cone(0.11 * g, 0.05 * g, 0.12 * g, 6), 0xf28a2e, { p: [0, -0.01, 0] });
  } else if (crop === 2) { // wheat
    const n = [3, 5, 8, 8][stage];
    for (let k = 0; k < n; k++) {
      const a = k * 2.4, r = (0.06 + 0.17 * ((k * 37 % 10) / 10)) * (0.5 + g / 2), x = Math.cos(a) * r, z = Math.sin(a) * r;
      add(cone(0.011, 0.014, 0.6 * g, 4), stage === 3 ? 0xb7aa55 : 0x7cc05a, { p: [x, 0, z], r: [Math.sin(a) * 0.1, 0, -Math.cos(a) * 0.1] });
      if (stage >= 2) add(cone(0.03, 0.04, 0.16, 5), 0xe8c65a, { p: [x, 0.6 * g - 0.02, z] });
    }
  } else if (crop === 3) { // clover
    for (let k = 0; k < [2, 3, 4, 4][stage]; k++) add(new THREE.SphereGeometry(0.2 * g, 6, 4), 0x5fb872, { p: [Math.cos(k * 1.6) * 0.15 * g, 0.07 * g + 0.02, Math.sin(k * 1.6) * 0.15 * g], s: [1, 0.4, 1] });
    for (let k = 0; k < [0, 0, 2, 4][stage]; k++) add(new THREE.SphereGeometry(0.06, 5, 4), 0xe48ac0, { p: [Math.cos(k * 1.6 + 0.5) * 0.13, 0.2 * g + 0.04, Math.sin(k * 1.6 + 0.5) * 0.13] });
  } else if (crop === 4) { // pumpkin
    if (stage < 2) {
      add(new THREE.SphereGeometry(0.14 * (0.5 + stage * 0.4), 5, 4), 0x5fa84a, { p: [0.08, 0.05, 0], s: [1, 0.25, 0.8] });
      if (stage === 1) add(new THREE.SphereGeometry(0.09, 6, 4), 0x6fae4a, { p: [0, 0.07, 0] });
    } else {
      const R = stage === 2 ? 0.2 : 0.3;
      for (let k = 0; k < (stage === 2 ? 2 : 3); k++) add(new THREE.SphereGeometry(R, 8, 6), stage === 2 ? 0xc8841f : 0xe0651f, { p: [0, R * 0.75, 0], s: [0.62, 0.75, 1], r: [0, k * 1.05, 0] });
      add(new THREE.BoxGeometry(0.06, 0.1, 0.06), 0x4b7d3a, { p: [0, R * 1.5 + 0.02, 0] });
      add(new THREE.SphereGeometry(0.14, 5, 4), 0x5fa84a, { p: [0.3, 0.06, 0.1], s: [1, 0.25, 0.8] });
    }
  } else if (crop === 5) { // berry
    const R = [0.1, 0.19, 0.26, 0.3][stage];
    add(new THREE.IcosahedronGeometry(R, 0), 0x3f8f5a, { p: [0, R * 0.85 + 0.02, 0], s: [1, 0.85, 1] });
    for (let k = 0; k < [0, 0, 3, 7][stage]; k++) add(new THREE.SphereGeometry(0.07, 5, 4), stage === 3 ? 0x8b49c7 : 0xb0c97a, { p: [Math.cos(k * 2.3) * 0.25, 0.2 + 0.16 * ((k * 3) % 4) / 3, Math.sin(k * 2.3) * 0.25] });
  } else { // apple sapling to fruiting tree
    const trunk = [0.22, 0.4, 0.52, 0.58][stage], R = [0.09, 0.18, 0.28, 0.35][stage];
    add(cone(0.015 + stage * 0.012, 0.03 + stage * 0.013, trunk, 5), 0x5e3d27);
    add(new THREE.IcosahedronGeometry(R, 0), 0x4e9a63, { p: [0, trunk + R * 0.7, 0] });
    if (stage === 3) for (let k = 0; k < 6; k++) add(new THREE.SphereGeometry(0.05, 5, 4), 0xc83a32, { p: [Math.cos(k * 1.05) * R * 0.88, trunk + R * (0.3 + (k % 3) * 0.35), Math.sin(k * 1.05) * R * 0.88] });
  }
  return out;
}

/** Quiet placeholder geometry for every model name the renderer may ask for before (or without) the exported GLB. */
export function fallbackModel(name: string): AssetModel {
  let parts: AssetPart[];
  if (name.startsWith('tile_') && name !== 'tile_terrace_wall') {
    parts = tileParts(name);
  } else if (name.startsWith('crop_')) {
    const crop = CROPS.findIndex((id) => id && name.startsWith(`crop_${id}_`));
    parts = cropParts(crop, Math.min(3, Math.max(0, Number(name.slice(-1)))));
  } else if (name === 'prop_beehive') {
    parts = [part(new THREE.BoxGeometry(0.42, 0.04, 0.42).translate(0, 0.02, 0), 0x8a5a3a)];
    [[0.2, 0.19], [0.17, 0.14], [0.12, 0.08]].forEach(([rb, rt], k) => parts.push(part(cone(rt, rb, 0.15, 8).translate(0, 0.04 + k * 0.15, 0), k % 2 ? 0xd49a2a : 0xe0b040)));
    parts.push(part(new THREE.BoxGeometry(0.07, 0.035, 0.02).translate(0, 0.1, 0.19), 0x3a2a14));
  } else if (name === 'prop_silo') {
    // Round wooden silo with a conical roof: about one tile wide, taller than the hive.
    parts = [part(new THREE.CylinderGeometry(0.34, 0.34, 0.78, 14).translate(0, 0.39, 0), 0xb07a4a),
      part(new THREE.CylinderGeometry(0.36, 0.36, 0.05, 14).translate(0, 0.025, 0), 0x58666b),
      part(new THREE.CylinderGeometry(0.2, 0.2, 0.012, 12).translate(0, 0.78, 0.0), 0x3a2a14),
      part(cone(0.02, 0.38, 0.3, 14).translate(0, 0.78, 0), 0x7a5a38),
      part(new THREE.BoxGeometry(0.1, 0.22, 0.012).translate(0, 0.16, 0.345), 0x6a3a2e)];
  } else if (name === 'prop_compost') {
    parts = [part(new THREE.IcosahedronGeometry(0.26, 0).scale(1.05, 0.6, 1.05).translate(0, 0.18, 0), 0x4a3a22)];
    for (const [x, z] of [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]]) parts.push(part(new THREE.BoxGeometry(0.05, 0.4, 0.05).translate(x, 0.2, z), 0x5e3d27));
    for (const y of [0.08, 0.2, 0.32]) parts.push(part(new THREE.BoxGeometry(0.6, 0.07, 0.025).translate(0, y, 0.3), 0x8a5a3a));
  } else if (name.startsWith('item_')) {
    const id = ITEM_NAMES.indexOf(name.slice(5));
    parts = id === 7 ? [part(new THREE.IcosahedronGeometry(0.1, 0).translate(0, 0.09, 0), 0x6b4a2b)]
      : [part(new THREE.CylinderGeometry(0.065, 0.075, 0.14, 8).translate(0, 0.07, 0), ITEM_COLORS[id] ?? 0xe8a92a)];
  } else if (name === 'bot_tender' || /^bot_tender_v\d$/.test(name)) {
    // Lantern drone, centred on its hull: cream hull, amber core, three leaf blades.
    parts = [part(new THREE.SphereGeometry(0.17, 12, 8).scale(1, 0.85, 1), 0xf2ecdc),
      { geometry: new THREE.SphereGeometry(0.075, 10, 8).translate(0, -0.1, 0), material: glow(0xffc65a) },
      part(new THREE.CylinderGeometry(0.178, 0.178, 0.03, 12, 1, true).translate(0, -0.015, 0), 0x4fd1b0),
      part(cone(0.03, 0.02, 0.07, 6).translate(0, 0.14, 0), 0x58666b)];
    for (let k = 0; k < 3; k++) { const a = k * Math.PI * 2 / 3; parts.push(part(at(new THREE.SphereGeometry(1, 8, 4), { p: [Math.cos(a) * 0.2, 0.2, Math.sin(a) * 0.2], s: [0.24, 0.012, 0.07], r: [0, -a, 0] }), 0x6fcf86)); }
  } else if (name === 'prop_barn') {
    parts = [part(new THREE.BoxGeometry(0.72, 0.05, 0.78).translate(0, 0.025, 0), 0x58666b),
      part(new THREE.BoxGeometry(0.62, 0.36, 0.7).translate(0, 0.23, 0), 0x8a4b3a),
      part(new THREE.CylinderGeometry(0.4, 0.4, 0.84, 3).rotateX(Math.PI / 2).rotateY(Math.PI / 2).scale(1, 0.75, 1).translate(0, 0.52, 0), 0xcfa64e),
      part(new THREE.BoxGeometry(0.26, 0.27, 0.012).translate(0, 0.185, 0.355), 0x6a3a2e),
      { geometry: new THREE.BoxGeometry(0.1, 0.1, 0.012).translate(0, 0.5, 0.36), material: glow(0xffc65a) }];
  } else if (name === 'prop_market') {
    parts = [part(new THREE.BoxGeometry(0.7, 0.28, 0.28).translate(0, 0.14, 0.12), 0x8a5a3a),
      part(new THREE.BoxGeometry(0.8, 0.04, 0.56).rotateX(0.22).translate(0, 0.64, 0.1), 0x4fd1b0),
      part(new THREE.BoxGeometry(0.6, 0.26, 0.03).translate(0, 0.82, -0.14), 0x1b3a3f),
      part(new THREE.BoxGeometry(0.04, 0.96, 0.04).translate(-0.35, 0.48, -0.12), 0x5e3d27),
      part(new THREE.BoxGeometry(0.04, 0.96, 0.04).translate(0.35, 0.48, -0.12), 0x5e3d27),
      part(new THREE.BoxGeometry(0.04, 0.62, 0.04).translate(-0.35, 0.31, 0.32), 0x5e3d27),
      part(new THREE.BoxGeometry(0.04, 0.62, 0.04).translate(0.35, 0.31, 0.32), 0x5e3d27)];
  } else if (name === 'prop_tree') {
    parts = [part(cone(0.1, 0.15, 0.8, 5), 0x5e3d27),
      part(new THREE.IcosahedronGeometry(0.7, 0).scale(1, 1.25, 1).translate(0, 1.25, 0), 0x3f8f5a)];
  } else if (name === 'prop_rocks') {
    parts = [part(new THREE.IcosahedronGeometry(0.4, 0).scale(1.2, 0.6, 0.8).translate(0, 0.18, 0), 0x58666b)];
  } else {
    parts = [part(new THREE.BoxGeometry(0.94, 0.3, 0.94).translate(0, -0.15, 0), 0x58666b)];
  }
  return { parts };
}
