// Model definitions for the island art pass. Each builder returns a Model (see lib.mjs for the conventions).
import { Model, xf, box, cyl, sphere, icosa, prism, floor, quad, rng, mix } from './lib.mjs';

export const P = {
  grass: 0x4e9a63, grassLight: 0x63ae76, grassDark: 0x3f8452, soil: 0x6b4636, soilDark: 0x4a2f26, soilLight: 0x7e5642,
  path: 0xd1b98a, pathLight: 0xdcc79c, pathDark: 0xbfa575, stone: 0x58666b, stoneLight: 0x72828a, stoneDark: 0x444f53,
  tendril: 0x4fd1b0, lantern: 0xffc65a, wood: 0x8a5a3a, woodDark: 0x5e3d27, woodLight: 0xa87a4f,
  barn: 0x8a4b3a, barnDark: 0x6a3a2e, thatch: 0xcfa64e, cream: 0xf2ecdc, leaf: 0x5fb85a, leafDark: 0x3f8f5a,
  leafLight: 0x7ccd86, water: 0x3aa6b0, deepTeal: 0x1b3a3f, honey: 0xe0b040,
};
const HALF = Math.PI / 2;
const ring = (n, fn) => { for (let k = 0; k < n; k++) fn(k, k / n * Math.PI * 2); };

// ---------------------------------------------------------------- tiles (flat top 0.94 wide with a chamfer, 0.3 deep)
const TILE_TOP = 0.43, TILE_EDGE = 0.47, TILE_DEPTH = 0.3, CHAMFER = 0.03;
function tileBody(m, top, edge, side) {
  m.add(floor(TILE_TOP * 2, TILE_TOP * 2), top);
  for (let k = 0; k < 4; k++) {
    const t = { r: [0, k * HALF, 0] };
    m.add(quad([-TILE_TOP, -CHAMFER, TILE_EDGE], [TILE_TOP, -CHAMFER, TILE_EDGE], [TILE_TOP, 0, TILE_TOP], [-TILE_TOP, 0, TILE_TOP]), edge, t);
    m.add(quad([-TILE_EDGE, -TILE_DEPTH, TILE_EDGE], [TILE_EDGE, -TILE_DEPTH, TILE_EDGE], [TILE_EDGE, -CHAMFER, TILE_EDGE], [-TILE_EDGE, -CHAMFER, TILE_EDGE]), side, t);
  }
}
// Four corner bevel wedges would add triangles for little gain; the edge strips overlap at the corners instead.

const decals = (m, seed, n, spec) => {
  const r = rng(seed);
  for (let k = 0; k < n; k++) {
    const s = spec(r, k);
    m.add(floor(s.w, s.d, 0.003 + k * 0.0004), s.c, { p: [s.x, 0, s.z], r: [0, s.a ?? r() * 6, 0] });
  }
};
const scatter = (r, span = 0.34) => [(r() - 0.5) * 2 * span, (r() - 0.5) * 2 * span];

export function tile(name) {
  const m = new Model(name, 'tile');
  if (name === 'tile_grass') {
    tileBody(m, P.grass, P.grassLight, P.soil);
    decals(m, 3, 6, (r) => { const [x, z] = scatter(r); return { x, z, w: 0.1 + r() * 0.08, d: 0.07 + r() * 0.05, c: r() < 0.5 ? P.grassDark : P.grassLight }; });
  } else if (name === 'tile_soil') {
    tileBody(m, P.soil, P.soilLight, P.soilDark);
    decals(m, 5, 7, (r) => { const [x, z] = scatter(r); return { x, z, w: 0.07 + r() * 0.07, d: 0.05 + r() * 0.04, c: r() < 0.5 ? P.soilDark : P.soilLight }; });
  } else if (name === 'tile_wet') {
    tileBody(m, P.soilDark, 0x5a3a2e, 0x3a241c);
    decals(m, 9, 4, (r) => { const [x, z] = scatter(r, 0.3); return { x, z, w: 0.12 + r() * 0.08, d: 0.07 + r() * 0.05, c: mix(P.soilDark, P.water, 0.28) }; });
  } else if (name === 'tile_path') {
    tileBody(m, P.path, P.pathLight, P.pathDark);
    for (const [x, z, w, d, c] of [[-0.2, -0.2, 0.3, 0.26, P.pathLight], [0.2, -0.17, 0.28, 0.3, P.pathDark], [-0.18, 0.2, 0.26, 0.28, P.pathDark], [0.2, 0.2, 0.3, 0.26, P.pathLight]]) {
      m.add(floor(w, d, 0.004), c, { p: [x, 0, z] });
    }
  } else if (name === 'tile_water') {
    // Stone-rimmed basin: ring at ground level, water surface sunk a little.
    const o = TILE_TOP, i = 0.31, low = -0.07;
    m.add(quad([-o, 0, o], [o, 0, o], [o, 0, i], [-o, 0, i]), P.stoneLight);
    m.add(quad([-o, 0, -i], [o, 0, -i], [o, 0, -o], [-o, 0, -o]), P.stoneLight);
    m.add(quad([-o, 0, i], [-i, 0, i], [-i, 0, -i], [-o, 0, -i]), P.stoneLight);
    m.add(quad([i, 0, i], [o, 0, i], [o, 0, -i], [i, 0, -i]), P.stoneLight);
    for (let k = 0; k < 4; k++) {
      const t = { r: [0, k * HALF, 0] };
      m.add(quad([i, low, i], [-i, low, i], [-i, 0, i], [i, 0, i]), P.stone, t);
      m.add(quad([-TILE_TOP, -CHAMFER, TILE_EDGE], [TILE_TOP, -CHAMFER, TILE_EDGE], [TILE_TOP, 0, TILE_TOP], [-TILE_TOP, 0, TILE_TOP]), P.stoneLight, t);
      m.add(quad([-TILE_EDGE, -TILE_DEPTH, TILE_EDGE], [TILE_EDGE, -TILE_DEPTH, TILE_EDGE], [TILE_EDGE, -CHAMFER, TILE_EDGE], [-TILE_EDGE, -CHAMFER, TILE_EDGE]), P.soil, t);
    }
    m.add(floor(i * 2, i * 2, low), P.water);
    m.add(floor(0.14, 0.07, low + 0.002), mix(P.water, 0xffffff, 0.35), { p: [0.1, 0, -0.08], r: [0, 0.4, 0] });
  }
  return m;
}

// ---------------------------------------------------------------- crops (origin on the ground, stage 0 sprout .. 3 ripe)
const STAGE = [0.34, 0.58, 0.82, 1];
const tilt = (a, amount) => [Math.sin(a) * amount, 0, -Math.cos(a) * amount];

export function crop(kind, stage) {
  const m = new Model(`crop_${kind}_s${stage}`, 'crop');
  const g = STAGE[stage];
  if (kind === 'carrot') {
    const n = [2, 3, 5, 7][stage];
    for (let k = 0; k < n; k++) {
      const a = k * 1.26 + 0.3;
      m.add(cyl(0, 0.07, 0.5 * g * (1 - (k % 3) * 0.1), 5), k % 2 ? P.leaf : 0x6cc462, { p: [Math.cos(a) * 0.06 * g, 0.02, Math.sin(a) * 0.06 * g], r: tilt(a, 0.15 + 0.2 * g) });
    }
    if (stage >= 2) m.add(cyl(0.11 * g, 0.05 * g, 0.12 * g, 6, true), stage === 3 ? 0xf28a2e : 0xf2a65a, { p: [0, -0.01, 0] });
  } else if (kind === 'wheat') {
    const n = [3, 5, 8, 10][stage];
    const stalk = [P.leaf, 0x7cc05a, 0x9bb552, 0xb7aa55][stage];
    for (let k = 0; k < n; k++) {
      const a = k * 2.4, r = (0.06 + 0.17 * ((k * 37 % 10) / 10)) * (0.5 + g / 2), h = 0.6 * g;
      const spec = { p: [Math.cos(a) * r, 0, Math.sin(a) * r], r: [Math.sin(a) * 0.1, 0, -Math.cos(a) * 0.1] };
      m.add(cyl(0.011, 0.014, h, 4), stalk, spec);
      if (stage >= 2) {
        const tip = xf(spec)([0, h, 0]); // head sits on the tip of the tilted stalk
        m.add(cyl(0.03, 0.04, stage === 3 ? 0.18 : 0.12, 5, false, true), stage === 3 ? 0xe8c65a : 0xc9c060, { p: [tip[0], tip[1] - 0.02, tip[2]], r: spec.r });
      }
    }
  } else if (kind === 'clover') {
    const pads = [2, 3, 4, 4][stage];
    for (let k = 0; k < pads; k++) {
      m.add(sphere(0.2 * g, 6, 4), k % 2 ? 0x5fb872 : 0x6cc27c, { p: [Math.cos(k * 1.6) * 0.15 * g, 0.07 * g + 0.02, Math.sin(k * 1.6) * 0.15 * g], s: [1, 0.4, 1] });
    }
    const blooms = [0, 0, 2, 4][stage];
    for (let k = 0; k < blooms; k++) {
      m.add(sphere(stage === 3 ? 0.065 : 0.045, 5, 4), stage === 3 ? 0xe48ac0 : 0xf0c8de, { p: [Math.cos(k * 1.6 + 0.5) * 0.13, 0.2 * g + 0.04, Math.sin(k * 1.6 + 0.5) * 0.13] });
    }
  } else if (kind === 'pumpkin') {
    const leaf = (x, z, s, c) => m.add(sphere(0.14 * s, 5, 4), c, { p: [x, 0.05 * s + 0.01, z], s: [1, 0.25, 0.8], r: [0, 0.6, 0] });
    if (stage === 0) {
      leaf(0.06, 0, 0.5, P.leaf); leaf(-0.05, 0.03, 0.5, 0x6cc462);
      m.add(cyl(0.01, 0.015, 0.08, 4), P.leafDark);
    } else if (stage === 1) {
      leaf(0.12, 0.02, 0.9, 0x5fa84a); leaf(-0.1, 0.06, 0.7, P.leaf);
      m.add(sphere(0.09, 6, 4), 0x6fae4a, { p: [0, 0.07, 0], s: [1, 0.8, 1] });
    } else if (stage === 2) {
      leaf(0.25, 0.08, 1, 0x5fa84a);
      for (let k = 0; k < 2; k++) m.add(sphere(0.2, 7, 5), k ? 0xc8841f : 0xd2901f, { p: [0, 0.14, 0], s: [0.7, 0.72, 1], r: [0, k * 1.05, 0] });
      m.add(box(0.05, 0.08, 0.05), P.leafDark, { p: [0, 0.27, 0] });
    } else {
      for (let k = 0; k < 3; k++) m.add(sphere(0.3, 8, 6), k === 1 ? 0xd8661c : 0xe0651f, { p: [0, 0.23, 0], s: [0.62, 0.75, 1], r: [0, k * 1.05, 0] });
      m.add(box(0.06, 0.1, 0.06), 0x4b7d3a, { p: [0, 0.46, 0] });
      m.add(sphere(0.14, 5, 4), 0x5fa84a, { p: [0.3, 0.06, 0.1], s: [1, 0.25, 0.8] });
    }
  } else if (kind === 'berry') {
    const r = [0.1, 0.19, 0.26, 0.3][stage];
    m.add(icosa(r), P.leafDark, { p: [0, r * 0.85 + 0.02, 0], s: [1, 0.85, 1] });
    if (stage >= 2) m.add(icosa(r * 0.7), 0x4a9f64, { p: [r * 0.55, r * 0.7, -r * 0.3] });
    const fruit = [0, 0, 3, 7][stage];
    for (let k = 0; k < fruit; k++) {
      m.add(sphere(0.07, 5, 4), stage === 3 ? 0x8b49c7 : 0xb0c97a, { p: [Math.cos(k * 2.3) * 0.25, 0.2 + 0.16 * ((k * 3) % 4) / 3, Math.sin(k * 2.3) * 0.25] });
    }
  } else if (kind === 'apple') {
    const trunk = [0.22, 0.4, 0.52, 0.58][stage];
    m.add(cyl(0.015 + stage * 0.012, 0.03 + stage * 0.013, trunk, 5), P.woodDark);
    if (stage === 0) {
      m.add(sphere(0.07, 5, 3), P.leaf, { p: [0.05, 0.22, 0], s: [1, 0.5, 0.8], r: [0, 0, 0.4] });
      m.add(sphere(0.07, 5, 3), 0x6cc462, { p: [-0.05, 0.19, 0.02], s: [1, 0.5, 0.8], r: [0, 0, -0.4] });
    } else {
      const R = [0, 0.18, 0.28, 0.35][stage];
      m.add(icosa(R), 0x4e9a63, { p: [0, trunk + R * 0.7, 0], s: [1, 0.9, 1] });
      if (stage >= 2) m.add(icosa(R * 0.72), 0x5fb872, { p: [R * 0.7, trunk + R * 0.4, R * 0.2] });
      const blossoms = stage === 2 ? 4 : 0;
      for (let k = 0; k < blossoms; k++) m.add(sphere(0.035, 5, 3), k % 2 ? 0xf6d3e3 : 0xffffff, { p: [Math.cos(k * 1.7) * R * 0.85, trunk + R * (0.5 + (k % 2) * 0.4), Math.sin(k * 1.7) * R * 0.85] });
      if (stage === 3) for (let k = 0; k < 6; k++) m.add(sphere(0.05, 5, 4), 0xc83a32, { p: [Math.cos(k * 1.05 + 0.3) * R * 0.88, trunk + R * (0.3 + (k % 3) * 0.35), Math.sin(k * 1.05 + 0.3) * R * 0.88] });
    }
  }
  return m;
}

// ---------------------------------------------------------------- lantern drone (origin = hull centre, y up)
export function drone(name, tier) {
  const m = new Model(name, 'bot');
  m.add(sphere(0.17, 12, 8), P.cream, { s: [1, 0.85, 1] });
  m.add(cyl(0.178, 0.178, 0.03, 12), tier >= 3 ? P.lantern : P.tendril, { p: [0, -0.015, 0] });
  m.add(sphere(0.075, 10, 8), P.lantern, { p: [0, -0.1, 0] }, 'glow');
  // Lantern cage around the core, gold bars and a base ring.
  ring(4, (k, a) => m.add(box(0.014, 0.16, 0.014), P.honey, { p: [Math.sin(a + 0.78) * 0.1, -0.19, Math.cos(a + 0.78) * 0.1] }));
  m.add(cyl(0.1, 0.1, 0.014, 8), P.honey, { p: [0, -0.2, 0] });
  // Landing feet.
  ring(3, (k, a) => m.add(cyl(0, 0.014, 0.1, 4), P.woodDark, { p: [Math.sin(a) * 0.1, -0.1, Math.cos(a) * 0.1], r: [Math.cos(a) * 0.5, 0, -Math.sin(a) * 0.5], s: [1, -1, 1] }));
  // Rotor hub and leaf blades.
  m.add(cyl(0.02, 0.03, 0.07, 6, true), P.stone, { p: [0, 0.14, 0] });
  const blades = tier >= 3 ? 5 : 3;
  ring(blades, (k, a) => m.add(sphere(1, 8, 4), 0x6fcf86, { p: [Math.cos(a) * 0.2, 0.2, Math.sin(a) * 0.2], s: [0.24, 0.012, 0.07], r: [0, -a, 0] }));
  if (tier >= 1) { // satchel on a strap
    m.add(box(0.1, 0.075, 0.08), P.wood, { p: [0.13, -0.1, 0.04], r: [0, 0.2, 0] });
    m.add(box(0.11, 0.02, 0.09), P.woodDark, { p: [0.13, -0.055, 0.04], r: [0, 0.2, 0] });
  }
  if (tier >= 2) { // headlamp and side fins
    m.add(sphere(0.035, 6, 4), P.lantern, { p: [0, 0, 0.165] }, 'glow');
    ring(2, (k) => m.add(sphere(1, 6, 3), P.leaf, { p: [(k ? -1 : 1) * 0.2, 0.02, -0.04], s: [0.09, 0.015, 0.05], r: [0, k ? 0.5 : -0.5, k ? 0.3 : -0.3] }));
  }
  if (tier >= 3) { // leaf crown around the hub and a second lamp
    ring(6, (k, a) => m.add(cyl(0, 0.025, 0.07, 4), P.leafLight, { p: [Math.sin(a) * 0.05, 0.17, Math.cos(a) * 0.05], r: [Math.cos(a) * 0.6, 0, -Math.sin(a) * 0.6] }));
    m.add(sphere(0.04, 6, 4), P.tendril, { p: [0, 0.01, -0.17] }, 'glow');
  }
  return m;
}

// ---------------------------------------------------------------- buildings and props
export function barn() {
  const m = new Model('prop_barn', 'building');
  m.add(box(0.72, 0.05, 0.78), P.stone);
  m.add(box(0.62, 0.36, 0.7, 0.05), P.barn);
  for (let k = -2; k <= 2; k++) m.add(box(0.012, 0.36, 0.008, 0.05), P.barnDark, { p: [k * 0.12, 0, 0.352] });
  m.add(prism(0.62, 0.27, 0.7), P.barn, { p: [0, 0.41, 0] });
  // Roof: two slabs with an overhang, ridge board and a weathervane.
  const ang = 0.6435, len = 0.56;
  m.add(box(len, 0.03, 0.82), P.thatch, { p: [-0.2, 0.545, 0], r: [0, 0, ang] });
  m.add(box(len, 0.03, 0.82), P.thatch, { p: [0.2, 0.545, 0], r: [0, 0, -ang] });
  m.add(box(0.05, 0.03, 0.84), P.woodDark, { p: [0, 0.69, 0] });
  m.add(cyl(0.008, 0.01, 0.12, 4), P.stoneDark, { p: [0, 0.7, 0] });
  m.add(box(0.1, 0.03, 0.01), P.lantern, { p: [0.02, 0.8, 0] });
  // Doors with cream braces.
  m.add(box(0.26, 0.27, 0.012, 0.05), P.barnDark, { p: [0, 0, 0.355] });
  m.add(box(0.28, 0.02, 0.016, 0.05), P.cream, { p: [0, 0.27 + 0.0, 0.357] });
  for (const s of [-1, 1]) m.add(box(0.012, 0.31, 0.016), P.cream, { p: [0, 0.19, 0.362], r: [0, 0, s * 0.72] });
  // Loft window (lit) and a lantern by the door.
  m.add(box(0.13, 0.13, 0.012), P.cream, { p: [0, 0.5, 0.354] });
  m.add(box(0.1, 0.1, 0.012), P.lantern, { p: [0, 0.5, 0.36] }, 'glow');
  m.add(box(0.012, 0.07, 0.012), P.woodDark, { p: [0.19, 0.33, 0.37] });
  m.add(sphere(0.032, 6, 4), P.lantern, { p: [0.19, 0.28, 0.375] }, 'glow');
  // Tendril vine up one side.
  for (let k = 0; k < 6; k++) m.add(cyl(0, 0.03, 0.07, 4), k % 2 ? P.tendril : P.leaf, { p: [-0.312, 0.08 + k * 0.05, 0.3 - (k % 3) * 0.09], r: [0, 0, 1.2] });
  return m;
}

export function stall() {
  const m = new Model('prop_market', 'building');
  m.add(box(0.7, 0.28, 0.28, 0), P.wood, { p: [0, 0, 0.12] });
  m.add(box(0.76, 0.03, 0.34, 0.28), P.woodLight, { p: [0, 0, 0.12] });
  for (const x of [-0.35, 0.35]) {
    m.add(box(0.04, 0.96, 0.04), P.woodDark, { p: [x, 0, -0.12] });
    m.add(box(0.04, 0.62, 0.04), P.woodDark, { p: [x, 0, 0.32] });
  }
  // Striped awning.
  for (let k = 0; k < 6; k++) m.add(box(0.8 / 6, 0.025, 0.56), k % 2 ? P.cream : P.tendril, { p: [-0.4 + (k + 0.5) * 0.8 / 6, 0.64, 0.1], r: [0.22, 0, 0] });
  m.add(box(0.8, 0.04, 0.03), P.tendril, { p: [0, 0.57, 0.38] });
  // Sign board with a gold frame.
  m.add(box(0.6, 0.26, 0.03), P.deepTeal, { p: [0, 0.82, -0.14] });
  for (const [x, y, w, h] of [[0, 0.96, 0.64, 0.03], [0, 0.69, 0.64, 0.03], [-0.31, 0.825, 0.03, 0.26], [0.31, 0.825, 0.03, 0.26]]) m.add(box(w, h, 0.04), P.lantern, { p: [x, y - h / 2 + 0.0, -0.14] });
  m.add(box(0.36, 0.05, 0.034), P.lantern, { p: [-0.05, 0.84, -0.12] }, 'glow');
  // Produce: pumpkin, apples, carrots, wheat sheaf.
  m.add(sphere(0.07, 6, 4), 0xe0651f, { p: [-0.24, 0.35, 0.12], s: [1, 0.8, 1] });
  for (let k = 0; k < 4; k++) m.add(sphere(0.04, 5, 4), 0xc83a32, { p: [-0.05 + (k % 2) * 0.08, 0.34 + (k > 1 ? 0.05 : 0), 0.1 + (k > 1 ? 0.02 : 0)] });
  for (let k = 0; k < 3; k++) m.add(cyl(0, 0.025, 0.14, 5), 0xf28a2e, { p: [0.17 + k * 0.045, 0.32, 0.12], r: [0, 0, 1.45], s: [1, 1, 1] });
  m.add(cyl(0.03, 0.045, 0.12, 6, false, true), 0xe8c65a, { p: [0.25, 0.31, 0.2], r: [0.2, 0, 0] });
  // Stand-alone crate beside the stall.
  m.add(box(0.14, 0.12, 0.14), P.woodLight, { p: [0.45, 0, 0.12], r: [0, 0.4, 0] });
  m.add(sphere(0.045, 5, 4), 0xc83a32, { p: [0.45, 0.14, 0.12] });
  return m;
}

export function beehive() {
  const m = new Model('prop_beehive', 'prop');
  m.add(box(0.42, 0.04, 0.42), P.wood);
  const rings = [[0.2, 0.19, 0.1, P.honey], [0.19, 0.17, 0.1, 0xd49a2a], [0.17, 0.14, 0.09, P.honey], [0.14, 0.1, 0.08, 0xd49a2a], [0.1, 0.04, 0.07, P.honey]];
  let y = 0.04;
  for (const [rb, rt, h, c] of rings) { m.add(cyl(rt, rb, h, 8), c, { p: [0, y, 0] }); y += h; }
  m.add(sphere(0.035, 5, 4), P.woodDark, { p: [0, y + 0.02, 0] });
  m.add(box(0.07, 0.035, 0.02), P.woodDark, { p: [0, 0.1, 0.19] });
  ring(3, (k) => m.add(box(0.025, 0.02, 0.03), k === 1 ? P.lantern : 0x2b2118, { p: [0.15 - k * 0.14, 0.32 + k * 0.05, 0.18 - k * 0.1], r: [0, k, 0] }));
  m.add(cyl(0, 0.04, 0.09, 4), P.leaf, { p: [-0.23, 0.04, 0.12], r: [0, 0, 0.6] });
  m.add(cyl(0, 0.04, 0.07, 4), P.leafLight, { p: [-0.23, 0.04, 0.2], r: [0.5, 0, 0.3] });
  return m;
}

export function compost() {
  const m = new Model('prop_compost', 'prop');
  m.add(icosa(0.26), 0x4a3a22, { p: [0, 0.18, 0], s: [1.05, 0.6, 1.05] });
  m.add(icosa(0.08), 0x5a7a3a, { p: [0.12, 0.3, 0.05] });
  m.add(icosa(0.07), 0x8a6a30, { p: [-0.1, 0.3, -0.06] });
  for (const [x, z] of [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]]) m.add(box(0.05, 0.4, 0.05), P.woodDark, { p: [x, 0, z] });
  for (let k = 0; k < 3; k++) {
    const y = 0.04 + k * 0.12;
    m.add(box(0.6, 0.07, 0.025), P.wood, { p: [0, y, 0.3] });
    m.add(box(0.6, 0.07, 0.025), P.wood, { p: [0, y, -0.3] });
    m.add(box(0.025, 0.07, 0.6), P.woodLight, { p: [0.3, y, 0] });
    m.add(box(0.025, 0.07, 0.6), P.woodLight, { p: [-0.3, y, 0] });
  }
  m.add(cyl(0, 0.04, 0.08, 4), P.leaf, { p: [0.18, 0.4, 0.1], r: [0.5, 0, 0.5] });
  return m;
}

export function item(name) {
  const m = new Model(name, 'prop');
  if (name === 'item_honey') {
    m.add(cyl(0.065, 0.075, 0.14, 8, true), 0xe8a92a);
    m.add(cyl(0.07, 0.07, 0.03, 8, true), P.woodDark, { p: [0, 0.14, 0] });
    m.add(box(0.09, 0.06, 0.012), P.cream, { p: [0, 0.04, 0.074], r: [0, 0, 0] });
    m.add(sphere(0.03, 5, 4), P.lantern, { p: [0.05, 0.16, 0.03] }, 'glow');
  } else {
    m.add(icosa(0.1), 0x6b4a2b, { p: [0, 0.09, 0], s: [1, 1.1, 1] });
    m.add(cyl(0.035, 0.05, 0.03, 6, true), P.woodDark, { p: [0, 0.2, 0] });
    m.add(cyl(0, 0.03, 0.08, 4), P.leaf, { p: [0.02, 0.22, 0], r: [0, 0, -0.5] });
    m.add(sphere(0.04, 4, 3), 0x5a7a3a, { p: [0.08, 0.1, 0.07] });
  }
  return m;
}

// New decor/props named in the validator but missing from the old export.
export function prop(name) {
  const m = new Model(name, 'prop');
  switch (name) {
    case 'prop_greenhouse': {
      m.group = 'building';
      m.add(box(0.74, 0.1, 0.54), P.stone);
      for (const [x, z] of [[-0.35, -0.25], [0.35, -0.25], [-0.35, 0.25], [0.35, 0.25]]) m.add(box(0.04, 0.4, 0.04, 0.1), P.cream, { p: [x, 0, z] });
      for (const z of [-0.25, 0.25]) m.add(box(0.74, 0.03, 0.03, 0.46), P.cream, { p: [0, 0, z] });
      m.add(box(0.03, 0.03, 0.54, 0.84 - 0.2), P.cream, { p: [0, 0.02, 0] });
      const ang = Math.atan2(0.2, 0.37);
      for (const s of [-1, 1]) {
        m.add(box(0.42, 0.015, 0.54), 0xbfeee4, { p: [s * 0.185, 0.56, 0], r: [0, 0, -s * ang] });
        m.add(box(0.42, 0.02, 0.025), P.cream, { p: [s * 0.185, 0.56, 0.27], r: [0, 0, -s * ang] });
        m.add(box(0.42, 0.02, 0.025), P.cream, { p: [s * 0.185, 0.56, -0.27], r: [0, 0, -s * ang] });
        m.add(box(0.015, 0.34, 0.5, 0.12), 0xbfeee4, { p: [s * 0.355, 0, 0] });
      }
      m.add(box(0.7, 0.34, 0.015, 0.12), 0xa8e0d6, { p: [0, 0, -0.255] });
      m.add(prism(0.7, 0.2, 0.015), 0xa8e0d6, { p: [0, 0.46, -0.255] });
      for (let k = 0; k < 3; k++) { m.add(icosa(0.08), P.leaf, { p: [-0.2 + k * 0.2, 0.18, 0.05] }); m.add(sphere(0.03, 4, 3), k % 2 ? 0xe48ac0 : 0xc83a32, { p: [-0.2 + k * 0.2, 0.27, 0.08] }); }
      break;
    }
    case 'prop_windmill': {
      m.group = 'building';
      m.add(cyl(0.2, 0.3, 0.62, 8), P.cream);
      m.add(cyl(0.3, 0.32, 0.06, 8), P.stone);
      m.add(cyl(0, 0.25, 0.22, 8), P.thatch, { p: [0, 0.62, 0] });
      m.add(box(0.12, 0.2, 0.012, 0), P.barnDark, { p: [0, 0.0, 0.29] });
      m.add(box(0.08, 0.08, 0.012), P.lantern, { p: [0, 0.38, 0.235] }, 'glow');
      m.add(cyl(0.03, 0.03, 0.1, 6, true), P.woodDark, { p: [0, 0.6, 0.18], r: [HALF, 0, 0] });
      for (let k = 0; k < 4; k++) {
        const a = k * HALF + 0.4;
        m.add(box(0.05, 0.4, 0.015, 0.03), P.woodDark, { p: [0, 0.67, 0.31], r: [0, 0, a] });
        m.add(box(0.14, 0.28, 0.008, 0.1), k % 2 ? P.cream : P.tendril, { p: [0, 0.67, 0.32], r: [0, 0, a] });
      }
      break;
    }
    case 'prop_silo': {
      m.group = 'building';
      m.add(cyl(0.25, 0.26, 0.9, 10), 0xb9c4c2);
      for (const y of [0.2, 0.5, 0.78]) m.add(cyl(0.262, 0.262, 0.03, 10), P.stoneDark, { p: [0, y, 0] });
      m.add(sphere(0.25, 10, 4), P.stone, { p: [0, 0.9, 0], s: [1, 0.6, 1] });
      m.add(cyl(0.02, 0.02, 0.07, 5), P.woodDark, { p: [0, 1.0, 0] });
      m.add(box(0.12, 0.2, 0.02), P.barnDark, { p: [0, 0, 0.255] });
      m.add(box(0.05, 0.08, 0.012), P.lantern, { p: [0, 0.6, 0.246] }, 'glow');
      break;
    }
    case 'prop_well': {
      ring(8, (k, a) => m.add(box(0.16, 0.22, 0.11), k % 2 ? P.stone : P.stoneLight, { p: [Math.sin(a) * 0.2, 0, Math.cos(a) * 0.2], r: [0, a, 0] }));
      m.add(floor(0.28, 0.28, 0.14), P.water);
      for (const s of [-1, 1]) m.add(box(0.04, 0.5, 0.04), P.woodDark, { p: [s * 0.22, 0.12, 0] });
      m.add(prism(0.6, 0.16, 0.34), P.thatch, { p: [0, 0.6, 0], r: [0, HALF, 0] });
      m.add(cyl(0.012, 0.012, 0.44, 5), P.wood, { p: [0, 0.5, 0], r: [0, 0, HALF], s: [1, 1, 1] });
      m.add(cyl(0.04, 0.05, 0.06, 6, false, true), P.woodLight, { p: [0.06, 0.36, 0] });
      break;
    }
    case 'prop_scarecrow': {
      m.add(cyl(0.015, 0.02, 0.8, 5), P.woodDark);
      m.add(box(0.5, 0.025, 0.025), P.woodDark, { p: [0, 0.55, 0] });
      m.add(box(0.16, 0.24, 0.1), P.tendril, { p: [0, 0.3, 0] });
      m.add(sphere(0.07, 6, 4), 0xd8c08a, { p: [0, 0.74, 0] });
      m.add(cyl(0.14, 0.14, 0.012, 8, true), P.thatch, { p: [0, 0.8, 0] });
      m.add(cyl(0.05, 0.07, 0.09, 8, true), P.thatch, { p: [0, 0.81, 0] });
      for (const s of [-1, 1]) m.add(cyl(0, 0.03, 0.09, 4), 0xe8c65a, { p: [s * 0.26, 0.55, 0], r: [0, 0, -s * 1.57] });
      m.add(box(0.015, 0.015, 0.012), 0x2b2118, { p: [-0.025, 0.75, 0.065] });
      m.add(box(0.015, 0.015, 0.012), 0x2b2118, { p: [0.025, 0.75, 0.065] });
      break;
    }
    case 'prop_pond': {
      m.add(cyl(0.42, 0.44, 0.04, 12, true), P.water, { p: [0, 0.0, 0] });
      ring(9, (k, a) => m.add(icosa(0.07 + (k % 3) * 0.015), k % 2 ? P.stone : P.stoneLight, { p: [Math.sin(a) * 0.43, 0.04, Math.cos(a) * 0.43] }));
      for (const [x, z] of [[-0.12, 0.1], [0.14, -0.1]]) { m.add(cyl(0.07, 0.07, 0.012, 7, true), P.leaf, { p: [x, 0.04, z] }); m.add(sphere(0.025, 4, 3), 0xe48ac0, { p: [x + 0.02, 0.06, z] }); }
      for (let k = 0; k < 4; k++) m.add(cyl(0, 0.012, 0.22 + (k % 2) * 0.06, 4), P.leafDark, { p: [0.33 + k * 0.025, 0.02, -0.25 + k * 0.03], r: [0, 0, 0.1] });
      break;
    }
    case 'prop_flowers': {
      const cols = [0xe48ac0, 0xffd96a, 0xffffff, 0xf58fb0, 0x9fb8ff, 0xffa056, 0xf6d3e3];
      for (let k = 0; k < 7; k++) {
        const a = k * 2.4, r = 0.08 + (k % 3) * 0.08, h = 0.14 + (k % 4) * 0.04, x = Math.cos(a) * r, z = Math.sin(a) * r;
        m.add(cyl(0.006, 0.01, h, 4), P.leafDark, { p: [x, 0, z] });
        m.add(sphere(0.04, 5, 3), cols[k], { p: [x, h + 0.02, z] });
        m.add(sphere(0.012, 4, 3), P.lantern, { p: [x, h + 0.045, z] });
        m.add(cyl(0, 0.03, 0.08, 4), P.leaf, { p: [x, 0.02, z], r: [0, 0, 0.9 * (k % 2 ? 1 : -1)] });
      }
      break;
    }
    case 'prop_bush': {
      m.add(icosa(0.28), P.leafDark, { p: [0, 0.22, 0], s: [1.1, 0.8, 1] });
      m.add(icosa(0.2), P.grass, { p: [0.22, 0.17, 0.1] });
      m.add(icosa(0.18), 0x5fb872, { p: [-0.18, 0.2, -0.1] });
      for (let k = 0; k < 4; k++) m.add(sphere(0.03, 4, 3), 0xe48ac0, { p: [Math.cos(k * 1.7) * 0.25, 0.28 + (k % 2) * 0.05, Math.sin(k * 1.7) * 0.25] });
      break;
    }
    case 'prop_lamp': {
      m.add(cyl(0.07, 0.09, 0.06, 6, true), P.stone);
      m.add(cyl(0.015, 0.025, 0.62, 5), P.stoneDark, { p: [0, 0.06, 0] });
      m.add(box(0.1, 0.12, 0.1), P.lantern, { p: [0, 0.66, 0] }, 'glow');
      m.add(cyl(0, 0.09, 0.07, 4), P.woodDark, { p: [0, 0.78, 0], r: [0, 0.785, 0] });
      m.add(cyl(0.065, 0.065, 0.02, 4), P.woodDark, { p: [0, 0.64, 0], r: [0, 0.785, 0] });
      m.add(cyl(0, 0.03, 0.06, 4), P.tendril, { p: [0.03, 0.2, 0], r: [0, 0, -1.2] });
      break;
    }
    case 'prop_cart': {
      m.add(box(0.5, 0.05, 0.34, 0.18), P.wood);
      for (const z of [-0.18, 0.18]) m.add(box(0.5, 0.14, 0.025, 0.18), P.woodLight, { p: [0, 0, z] });
      for (const x of [-0.26, 0.26]) m.add(box(0.025, 0.14, 0.34, 0.18), P.woodLight, { p: [x, 0, 0] });
      for (const z of [-0.2, 0.2]) m.add(cyl(0.14, 0.14, 0.035, 10, true, true), P.woodDark, { p: [0, 0.14, z - 0.0175], r: [HALF, 0, 0] });
      m.add(box(0.5, 0.02, 0.02), P.stoneDark, { p: [0, 0.14, 0] });
      for (const z of [-0.1, 0.1]) m.add(box(0.4, 0.025, 0.025), P.woodDark, { p: [-0.42, 0.2, z], r: [0, 0, 0.2] });
      m.add(icosa(0.15), 0xe8c65a, { p: [0, 0.3, 0], s: [1.3, 0.7, 1] });
      m.add(sphere(0.07, 6, 4), 0xe0651f, { p: [0.12, 0.34, 0.05], s: [1, 0.8, 1] });
      break;
    }
    case 'prop_hay': {
      for (const [x, z, y, rot] of [[-0.18, 0.05, 0.17, 0.2], [0.2, 0.0, 0.17, -0.1], [0.0, -0.05, 0.5, 0.0]]) {
        m.add(cyl(0.17, 0.17, 0.3, 10, true, true), 0xe8c65a, { p: [x, y - 0.17, z], r: [HALF, rot, 0] });
        m.add(cyl(0.175, 0.175, 0.025, 10), P.woodLight, { p: [x, y - 0.17, z + 0.0], r: [HALF, rot, 0], s: [1, 1, 1] });
      }
      break;
    }
  }
  return m;
}
