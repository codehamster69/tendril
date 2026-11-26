import * as THREE from 'three';
import type { AssetModel } from './asset-loader.ts';

/**
 * The ground of the farm: continuous soil beds with two furrow ridges per tile row, meadow, grass clumps and clods.
 * Every piece is one small geometry drawn as an instance per tile. Neighbouring tiles meet edge to edge at the same
 * height, so a run of tilled tiles reads as one bed and the grid is invisible (it only shows in the Grid lens).
 * The look follows the Blender target (renders/v2/farm-close.jpg): dark crests, deep troughs, small clods.
 */

/** Moisture is 0..1. Dry soil pales and warms, wet soil goes dark. These multiply the bed's vertex colours. */
const SOIL_DRY = new THREE.Color(1.55, 1.34, 1.1), SOIL_WET = new THREE.Color(0.52, 0.5, 0.52);
export function soilTint(moisture: number, out: THREE.Color): THREE.Color {
  const k = THREE.MathUtils.clamp(moisture, 0, 1);
  return out.copy(SOIL_DRY).lerp(SOIL_WET, k);
}

/** Small deterministic PRNG (the geometry is built once and must not change between sessions). */
function rng(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

const FURROW_BASE = 0.01, FURROW_RISE = 0.055;
/** Soil height at tile-local z in -0.5..0.5: two soft ridges per tile, troughs on the tile edges (cos profile). */
export function furrowHeight(z: number): number {
  const ridge = ((1 + Math.cos(Math.PI * 4 * (z + 0.25))) / 2) ** 0.7;
  return FURROW_BASE + FURROW_RISE * ridge;
}

/** One tile of soil bed: a 1 x 1 sheet with the furrow profile along z, plus a short skirt so run ends have no hole. */
export function soilBedGeometry(): THREE.BufferGeometry {
  const NX = 2, NZ = 24, skirt = -0.07;
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const lo = new THREE.Color(0x2a180f), hi = new THREE.Color(0x74503a), c = new THREE.Color();
  const colourAt = (h: number): THREE.Color => c.copy(lo).lerp(hi, THREE.MathUtils.clamp((h - FURROW_BASE) / FURROW_RISE, 0, 1));
  for (let iz = 0; iz <= NZ; iz++) {
    const z = -0.5 + iz / NZ, h = furrowHeight(z);
    colourAt(h);
    for (let ix = 0; ix <= NX; ix++) { pos.push(-0.5 + ix / NX, h, z); col.push(c.r, c.g, c.b); }
  }
  const row = NX + 1;
  for (let iz = 0; iz < NZ; iz++) for (let ix = 0; ix < NX; ix++) {
    const a = iz * row + ix, b = a + 1, d = a + row, e = d + 1;
    idx.push(a, d, b, b, d, e);
  }
  // Skirts: separate vertices so the top keeps its smooth normals.
  const dark = new THREE.Color(0x1c110b);
  const strip = (pts: [number, number, number][], flip: boolean): void => {
    const base = pos.length / 3;
    for (const [x, y, z] of pts) { pos.push(x, y, z, x, skirt, z); col.push(dark.r, dark.g, dark.b, dark.r, dark.g, dark.b); }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = base + i * 2, b = a + 1, d = a + 2, e = a + 3;
      if (flip) idx.push(a, d, b, b, d, e); else idx.push(a, b, d, b, e, d);
    }
  };
  const west: [number, number, number][] = [], east: [number, number, number][] = [];
  for (let iz = 0; iz <= NZ; iz++) { const z = -0.5 + iz / NZ, h = furrowHeight(z); west.push([-0.5, h, z]); east.push([0.5, h, z]); }
  strip(west, true); strip(east, false);
  strip([[-0.5, FURROW_BASE, -0.5], [0.5, FURROW_BASE, -0.5]], false);
  strip([[-0.5, FURROW_BASE, 0.5], [0.5, FURROW_BASE, 0.5]], true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Untilled owned tile: a flat slab, top at y 0, a hair wider than the tile so no seam shows. */
export function meadowGeometry(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(1.004, 0.12, 1.004).translate(0, -0.06, 0);
}

function merged(parts: { g: THREE.BufferGeometry; colors?: boolean }[]): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], col: number[] = [];
  for (const { g } of parts) {
    const n = g.index ? g.toNonIndexed() : g;
    n.computeVertexNormals();
    pos.push(...(n.attributes.position.array as ArrayLike<number> as number[]));
    nor.push(...(n.attributes.normal.array as ArrayLike<number> as number[]));
    const cc = g.attributes.color;
    if (cc) col.push(...(cc.array as ArrayLike<number> as number[])); else for (let i = 0; i < n.attributes.position.count; i++) col.push(1, 1, 1);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return out;
}

/** A clump of curved blades, base dark to tip light (vertex colours). Each blade is three triangles: base, bend, tip. */
export function bladeClumpGeometry(seed = 3, blades = 8): THREE.BufferGeometry {
  const r = rng(seed);
  const G0 = new THREE.Color(0x46702c), G1 = new THREE.Color(0x6e9a40), G2 = new THREE.Color(0xa3b85a);
  const pos: number[] = [], col: number[] = [];
  const push = (p: THREE.Vector3, c: THREE.Color): void => { pos.push(p.x, p.y, p.z); col.push(c.r, c.g, c.b); };
  for (let i = 0; i < blades; i++) {
    const a = r() * Math.PI * 2, d = 0.02 + r() * 0.09, h = 0.13 + r() * 0.13, w = 0.022 + r() * 0.012, lean = 0.03 + r() * 0.06;
    const yaw = r() * Math.PI * 2, ax = Math.cos(yaw), az = Math.sin(yaw);
    const ox = Math.cos(a) * d, oz = Math.sin(a) * d, sx = -az, sz = ax; // blade width runs along (sx, sz)
    const at = (u: number, side: number, y: number, bend: number): THREE.Vector3 => new THREE.Vector3(ox + sx * side * u + ax * bend, y, oz + sz * side * u + az * bend);
    const b0 = at(w, -1, 0, 0), b1 = at(w, 1, 0, 0), m0 = at(w * 0.7, -1, h * 0.55, lean * 0.4), m1 = at(w * 0.7, 1, h * 0.55, lean * 0.4), tip = at(0, 0, h, lean);
    const tint = new THREE.Color().copy(G1).lerp(G2, r() * 0.4);
    for (const [p, q, s, c1, c2, c3] of [[b0, b1, m0, G0, G0, tint], [b1, m1, m0, G0, tint, tint], [m0, m1, tip, tint, tint, G2]] as [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Color, THREE.Color, THREE.Color][]) {
      push(p, c1); push(q, c2); push(s, c3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

/** A pinch of clods: three small rough lumps lying on the crest of a furrow. */
export function clodGeometry(seed = 11): THREE.BufferGeometry {
  const r = rng(seed);
  const parts = [];
  for (let i = 0; i < 4; i++) {
    const g = new THREE.IcosahedronGeometry(0.014 + r() * 0.02, 0).scale(1, 0.7, 1);
    const z = (i % 2 ? 0.25 : -0.25) + (r() - 0.5) * 0.1;
    g.translate((r() - 0.5) * 0.8, furrowHeight(z) + 0.004, z);
    parts.push({ g });
  }
  return merged(parts);
}

const GLSL_NOISE = `
float gh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float gn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(gh(i), gh(i + vec2(1.0, 0.0)), f.x), mix(gh(i + vec2(0.0, 1.0)), gh(i + vec2(1.0, 1.0)), f.x), f.y); }`;

/**
 * Colour noise keyed on world position (so it runs unbroken across tiles): value noise darkens and lightens the surface,
 * and for meadow a slow second noise tips the green toward straw in patches. `lift` nudges soil height the same way.
 */
export function patchGround(m: THREE.MeshStandardMaterial, o: { scale: number; amp: number; lift?: number; straw?: boolean; key: string }): THREE.MeshStandardMaterial {
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vGW;\n${GLSL_NOISE}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vGW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xz;
${o.lift ? `transformed.y += (gn(vGW * 3.1) - 0.5) * ${o.lift.toFixed(4)};` : ''}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vGW;\n${GLSL_NOISE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{ float n = gn(vGW * ${o.scale.toFixed(3)}) * 0.65 + gn(vGW * ${(o.scale * 3.3).toFixed(3)}) * 0.35;
  diffuseColor.rgb *= ${(1 - o.amp).toFixed(3)} + ${(2 * o.amp).toFixed(3)} * n;
  ${o.straw ? 'float s = smoothstep(0.58, 0.78, gn(vGW * 0.33 + 7.0)); diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.28, 1.12, 0.62), s * 0.8);' : ''} }`);
  };
  m.customProgramCacheKey = () => o.key;
  return m;
}

export interface GroundModels { soil: AssetModel; meadow: AssetModel; blades: AssetModel; clods: AssetModel; dispose(): void }

export function groundModels(): GroundModels {
  const soilGeo = soilBedGeometry(), meadowGeo = meadowGeometry(), bladeGeo = bladeClumpGeometry(), clodGeo = clodGeometry();
  const soilMat = patchGround(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96 }), { scale: 2.4, amp: 0.16, lift: 0.014, key: 'ground-soil' });
  const meadowMat = patchGround(new THREE.MeshStandardMaterial({ color: 0x5f8d3e, roughness: 0.98 }), { scale: 1.1, amp: 0.14, straw: true, key: 'ground-meadow' });
  const bladeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide });
  const clodMat = new THREE.MeshStandardMaterial({ vertexColors: true, color: 0x3b2518, roughness: 1, flatShading: true });
  const geos = [soilGeo, meadowGeo, bladeGeo, clodGeo], mats = [soilMat, meadowMat, bladeMat, clodMat];
  const one = (geometry: THREE.BufferGeometry, material: THREE.Material): AssetModel => ({ parts: [{ geometry, material }] });
  return {
    soil: one(soilGeo, soilMat), meadow: one(meadowGeo, meadowMat), blades: one(bladeGeo, bladeMat), clods: one(clodGeo, clodMat),
    dispose: () => { for (const g of geos) g.dispose(); for (const m of mats) m.dispose(); },
  };
}
