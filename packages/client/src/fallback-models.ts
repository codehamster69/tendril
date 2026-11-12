import * as THREE from 'three';
import type { AssetModel, AssetPart } from './asset-loader';

/** Crop ids 1..6 (rules v3) and item ids 1..8. Index equals the simulation id. */
export const CROPS = ['', 'carrot', 'wheat', 'clover', 'pumpkin', 'berry', 'apple'];
export const ITEM_NAMES = [...CROPS, 'honey', 'compost'];
export const BUILDING_MODELS = ['', 'prop_beehive', 'prop_compost'];
export const CROP_COLORS = [0, 0xf08a24, 0xe6c34a, 0x8fbf6a, 0xd2601a, 0x8a3a8f, 0xc83a32];
const ITEM_COLORS = [0, ...CROP_COLORS.slice(1), 0xe8a92a, 0x6b4a2b];

export const matte = (color: number): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
export const part = (geometry: THREE.BufferGeometry, color: number): AssetPart => ({ geometry, material: matte(color) });

/** Quiet placeholder geometry for every model name the renderer may ask for before (or without) the exported GLB. */
export function fallbackModel(name: string): AssetModel {
  let parts: AssetPart[];
  if (name.startsWith('tile_') && name !== 'tile_terrace_wall') {
    const color = name === 'tile_soil' ? 0x7a5230 : name === 'tile_wet' ? 0x59402d : name === 'tile_path' ? 0xc5ae82 : 0x5a9e4b;
    parts = [part(new THREE.BoxGeometry(0.98, 0.2, 0.98).translate(0, -0.1, 0), color)];
  } else if (name.startsWith('crop_')) {
    const crop = CROPS.findIndex((id) => id && name.startsWith(`crop_${id}_`));
    const stage = Number(name.slice(-1));
    const size = 0.22 + stage * 0.22;
    const geometry = crop === 4 ? new THREE.IcosahedronGeometry(0.36 * size, 1)
      : crop === 3 ? new THREE.IcosahedronGeometry(0.3 * size, 0)
      : crop === 5 ? new THREE.IcosahedronGeometry(0.42 * size, 0).scale(1, 0.8, 1)
      : crop === 6 ? new THREE.SphereGeometry(0.4 * size, 8, 6)
      : new THREE.ConeGeometry(0.24 * size, 0.75 * size, 5);
    geometry.computeBoundingBox();
    geometry.translate(0, -geometry.boundingBox!.min.y, 0);
    parts = [part(geometry, CROP_COLORS[crop] ?? 0x8fbf6a)];
    if (crop >= 5 && stage > 0) parts.push(part(new THREE.CylinderGeometry(0.04, 0.05, 0.3 * size, 5).translate(0, -0.02, 0), 0x664428));
  } else if (name === 'prop_beehive') {
    parts = [part(new THREE.BoxGeometry(0.46, 0.4, 0.46).translate(0, 0.2, 0), 0xe0b040),
      part(new THREE.BoxGeometry(0.52, 0.08, 0.52).translate(0, 0.44, 0), 0x9a6a2a),
      part(new THREE.BoxGeometry(0.12, 0.06, 0.02).translate(0, 0.12, 0.235), 0x3a2a14)];
  } else if (name === 'prop_compost') {
    parts = [part(new THREE.BoxGeometry(0.6, 0.42, 0.6).translate(0, 0.21, 0), 0x6b4a2b),
      part(new THREE.BoxGeometry(0.5, 0.06, 0.5).translate(0, 0.45, 0), 0x3f5a2a)];
  } else if (name.startsWith('item_')) {
    const id = ITEM_NAMES.indexOf(name.slice(5));
    parts = [part(new THREE.BoxGeometry(0.16, 0.16, 0.16).translate(0, 0.08, 0), ITEM_COLORS[id] ?? 0xcccccc)];
  } else if (name === 'bot_tender') {
    // A tiny enamel helper with a cream face and paired dark eyes while the GLB loads.
    parts = [
      part(new THREE.BoxGeometry(0.4, 0.3, 0.36).translate(0, 0.3, 0), 0x4a90d9),
      part(new THREE.IcosahedronGeometry(0.23, 1).translate(0, 0.58, 0), 0xdfe6ee),
      part(new THREE.BoxGeometry(0.05, 0.07, 0.025).translate(-0.08, 0.6, 0.21), 0x2e3848),
      part(new THREE.BoxGeometry(0.05, 0.07, 0.025).translate(0.08, 0.6, 0.21), 0x2e3848),
      part(new THREE.CylinderGeometry(0.025, 0.025, 0.12, 5).translate(0, 0.84, 0), 0xf8cb3c),
    ];
  } else if (name === 'prop_barn') {
    parts = [part(new THREE.BoxGeometry(0.84, 0.64, 0.84).translate(0, 0.32, 0), 0xb0302a),
      part(new THREE.CylinderGeometry(0.64, 0.64, 0.92, 3).rotateY(Math.PI / 2).rotateX(Math.PI / 2).translate(0, 0.8, 0), 0x6e1a16),
      part(new THREE.BoxGeometry(0.28, 0.42, 0.025).translate(0, 0.21, 0.43), 0x664428)];
  } else if (name === 'prop_tree') {
    parts = [part(new THREE.CylinderGeometry(0.1, 0.15, 0.8, 5).translate(0, 0.4, 0), 0x664428),
      part(new THREE.IcosahedronGeometry(0.7, 0).scale(1, 1.25, 1).translate(0, 1.25, 0), 0x3e7a33)];
  } else if (name === 'prop_rocks') {
    parts = [part(new THREE.IcosahedronGeometry(0.4, 0).scale(1.2, 0.6, 0.8).translate(0, 0.18, 0), 0x8f8d87)];
  } else {
    parts = [part(new THREE.BoxGeometry(0.98, 0.2, 1).translate(0, -0.1, 0), 0x77766c)];
  }
  return { parts };
}
