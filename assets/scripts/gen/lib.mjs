// Minimal low-poly toolkit and binary glTF 2.0 writer for the Tendril "living island" art pass.
// Art license: CC BY-NC-SA 4.0 (see LICENSE-ART.md). Original shapes, no third-party meshes.
//
// Conventions (same as the old Blender export): glTF Y up, 1 unit = 1 tile, origin on the tile centre at ground
// level (y = 0), tiles fill y in [-depth, 0], everything else stands on y = 0. Faces are flat shaded (one normal per
// triangle, no index buffer). Colours are authored as sRGB hex and stored as linear COLOR_0 vertex colours; every
// model has one white material per surface kind ("matte", plus "glow" with an emissive factor for lanterns), so a
// loader that swaps materials keeps the palette as long as it enables vertexColors.

import { writeFile } from 'node:fs/promises';

// ---------------------------------------------------------------- colour
export const hex = (c) => [(c >> 16 & 255) / 255, (c >> 8 & 255) / 255, (c & 255) / 255];
const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
export const linear = (c) => hex(c).map(lin);
export const mix = (a, b, t) => {
  const A = hex(a), B = hex(b), m = A.map((v, i) => Math.round((v + (B[i] - v) * t) * 255));
  return m[0] << 16 | m[1] << 8 | m[2];
};

// ---------------------------------------------------------------- transforms
// Euler XYZ like three.js: v' = Rx * Ry * Rz * (S v) + p.
export function xf({ p = [0, 0, 0], r = [0, 0, 0], s = [1, 1, 1] } = {}) {
  const [cx, cy, cz] = r.map(Math.cos), [sx, sy, sz] = r.map(Math.sin);
  const S = typeof s === 'number' ? [s, s, s] : s;
  return (v) => {
    let x = v[0] * S[0], y = v[1] * S[1], z = v[2] * S[2], t;
    t = x * cz - y * sz; y = x * sz + y * cz; x = t;      // Rz
    t = x * cy + z * sy; z = -x * sy + z * cy; x = t;     // Ry
    t = y * cx - z * sx; z = y * sx + z * cx; y = t;      // Rx
    return [x + p[0], y + p[1], z + p[2]];
  };
}

// ---------------------------------------------------------------- primitives: { v: [[x,y,z]], i: [a,b,c, ...] } CCW seen from outside
export function box(w, h, d, y0 = 0) {
  const x = w / 2, z = d / 2, y = y0, Y = y0 + h;
  const v = [[-x, y, -z], [x, y, -z], [x, Y, -z], [-x, Y, -z], [-x, y, z], [x, y, z], [x, Y, z], [-x, Y, z]];
  const i = [4, 5, 6, 4, 6, 7, 1, 0, 3, 1, 3, 2, 5, 1, 2, 5, 2, 6, 0, 4, 7, 0, 7, 3, 3, 7, 6, 3, 6, 2, 0, 1, 5, 0, 5, 4];
  return { v, i };
}

/** Cone or frustum from y = 0 up to y = h (rt = 0 gives a cone). Caps are optional. */
export function cyl(rt, rb, h, seg = 6, capTop = false, capBot = false) {
  const v = [], i = [];
  for (let k = 0; k < seg; k++) {
    const a = k / seg * Math.PI * 2;
    v.push([Math.sin(a) * rb, 0, Math.cos(a) * rb]);
  }
  for (let k = 0; k < seg; k++) {
    const a = k / seg * Math.PI * 2;
    v.push([Math.sin(a) * rt, h, Math.cos(a) * rt]);
  }
  for (let k = 0; k < seg; k++) {
    const n = (k + 1) % seg;
    if (rt > 1e-6) i.push(k, n + seg, k + seg, k, n, n + seg);
    else i.push(k, n, k + seg);
  }
  if (capTop && rt > 1e-6) { v.push([0, h, 0]); const c = v.length - 1; for (let k = 0; k < seg; k++) i.push(c, seg + k, seg + (k + 1) % seg); }
  if (capBot) { v.push([0, 0, 0]); const c = v.length - 1; for (let k = 0; k < seg; k++) i.push(c, (k + 1) % seg, k); }
  return { v, i };
}

/** UV sphere centred at the origin; w segments around, h rings (2 w (h - 1) triangles). */
export function sphere(r, w = 8, h = 5) {
  const v = [[0, r, 0]], i = [];
  for (let j = 1; j < h; j++) {
    const phi = j / h * Math.PI;
    for (let k = 0; k < w; k++) { const a = k / w * Math.PI * 2; v.push([Math.sin(phi) * Math.sin(a) * r, Math.cos(phi) * r, Math.sin(phi) * Math.cos(a) * r]); }
  }
  v.push([0, -r, 0]);
  const bottom = v.length - 1;
  for (let k = 0; k < w; k++) i.push(0, 1 + k, 1 + (k + 1) % w);
  for (let j = 0; j < h - 2; j++) for (let k = 0; k < w; k++) {
    const a = 1 + j * w + k, b = 1 + j * w + (k + 1) % w, c = a + w, d = b + w;
    i.push(a, c, d, a, d, b);
  }
  const last = 1 + (h - 2) * w;
  for (let k = 0; k < w; k++) i.push(bottom, last + (k + 1) % w, last + k);
  return { v, i };
}

export function icosa(r) {
  const t = (1 + Math.sqrt(5)) / 2, n = Math.hypot(1, t);
  const raw = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
  const v = raw.map((p) => p.map((c) => c / n * r));
  const i = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
  return { v, i };
}

/** Triangular prism, ridge along z: cross-section width w, height h, length d, base at y = 0. */
export function prism(w, h, d) {
  const x = w / 2, z = d / 2;
  const v = [[-x, 0, -z], [x, 0, -z], [0, h, -z], [-x, 0, z], [x, 0, z], [0, h, z]];
  const i = [3, 4, 5, 1, 0, 2, 0, 3, 5, 0, 5, 2, 4, 1, 2, 4, 2, 5, 0, 1, 4, 0, 4, 3];
  return { v, i };
}

/** Flat quad (a,b,c,d counter-clockwise seen from the front). */
export const quad = (a, b, c, d) => ({ v: [a, b, c, d], i: [0, 1, 2, 0, 2, 3] });
/** Horizontal square on the ground facing up; side w, d, at height y. */
export const floor = (w, d, y = 0) => quad([-w / 2, y, d / 2], [w / 2, y, d / 2], [w / 2, y, -d / 2], [-w / 2, y, -d / 2]);

// ---------------------------------------------------------------- model
export class Model {
  constructor(name, group) {
    this.name = name; this.group = group;
    this.buckets = new Map(); // material -> { pos: [], nor: [], col: [] }
  }

  /** Add a primitive with an optional transform spec ({p, r, s}) and a colour, into the "matte" or "glow" material. */
  add(g, color, t = {}, material = 'matte') {
    const f = xf(t), c = linear(color);
    let b = this.buckets.get(material);
    if (!b) this.buckets.set(material, b = { pos: [], nor: [], col: [] });
    const v = g.v.map(f);
    for (let k = 0; k < g.i.length; k += 3) {
      const A = v[g.i[k]], B = v[g.i[k + 1]], C = v[g.i[k + 2]];
      const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], w = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
      let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const len = Math.hypot(...n);
      if (len < 1e-12) continue; // degenerate (a collapsed cone side)
      n = n.map((x) => x / len);
      for (const P of [A, B, C]) { b.pos.push(...P); b.nor.push(...n); b.col.push(...c); }
    }
    return this;
  }

  get tris() { let n = 0; for (const b of this.buckets.values()) n += b.pos.length / 9; return n; }

  bounds() {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const b of this.buckets.values()) for (let k = 0; k < b.pos.length; k += 3) for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], b.pos[k + a]); max[a] = Math.max(max[a], b.pos[k + a]);
    }
    return { min, max };
  }

  /** Binary glTF 2.0 buffer. */
  glb() {
    const chunks = [], views = [], accessors = [], prims = [], materials = [];
    let offset = 0;
    const push = (arr) => { const buf = Buffer.from(new Float32Array(arr).buffer); views.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, target: 34962 }); chunks.push(buf); offset += buf.length; return views.length - 1; };
    for (const [mat, b] of this.buckets) {
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let k = 0; k < b.pos.length; k += 3) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], b.pos[k + a]); max[a] = Math.max(max[a], b.pos[k + a]); }
      const count = b.pos.length / 3, base = accessors.length;
      accessors.push({ bufferView: push(b.pos), componentType: 5126, count, type: 'VEC3', min, max });
      accessors.push({ bufferView: push(b.nor), componentType: 5126, count, type: 'VEC3' });
      accessors.push({ bufferView: push(b.col), componentType: 5126, count, type: 'VEC3' });
      const m = { name: mat, pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: mat === 'glow' ? 0.4 : 0.85 } };
      if (mat === 'glow') m.emissiveFactor = linear(0xffc65a).map((v) => v * 0.9);
      materials.push(m);
      prims.push({ attributes: { POSITION: base, NORMAL: base + 1, COLOR_0: base + 2 }, material: materials.length - 1, mode: 4 });
    }
    const bin = Buffer.concat(chunks);
    const json = {
      asset: { version: '2.0', generator: 'tendril assets/scripts/gen (CC BY-NC-SA 4.0)' },
      scene: 0, scenes: [{ name: 'Scene', nodes: [0] }], nodes: [{ mesh: 0, name: this.name }],
      materials, meshes: [{ name: this.name, primitives: prims }], accessors, bufferViews: views, buffers: [{ byteLength: bin.length }],
    };
    let js = Buffer.from(JSON.stringify(json));
    js = Buffer.concat([js, Buffer.alloc((4 - js.length % 4) % 4, 0x20)]);
    const bn = Buffer.concat([bin, Buffer.alloc((4 - bin.length % 4) % 4, 0)]);
    const head = Buffer.alloc(12), jh = Buffer.alloc(8), bh = Buffer.alloc(8);
    head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + bn.length, 8);
    jh.writeUInt32LE(js.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
    bh.writeUInt32LE(bn.length, 0); bh.writeUInt32LE(0x004e4942, 4);
    return Buffer.concat([head, jh, js, bh, bn]);
  }

  /** Sidecar in the old convention: size is [x, depth, height] (Blender axes: depth = glTF z, height = glTF y). */
  meta(budgets) {
    const { min, max } = this.bounds();
    const size = [max[0] - min[0], max[2] - min[2], max[1] - min[1]].map((s) => Math.round(s * 1000) / 1000);
    return { name: this.name, group: this.group, tris: this.tris, budget: budgets[this.group], size };
  }
}

export const BUDGETS = { tile: 300, crop: 300, bot: 1500, building: 3000, prop: 1500 };

export async function save(model, dir) {
  const meta = model.meta(BUDGETS);
  if (meta.tris > meta.budget) throw new Error(`${model.name}: ${meta.tris} triangles exceeds ${model.group} budget ${meta.budget}`);
  await writeFile(`${dir}/${model.name}.glb`, model.glb());
  await writeFile(`${dir}/${model.name}.json`, JSON.stringify(meta));
  return meta;
}

/** Deterministic random in [0, 1). */
export const rng = (seed) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;
