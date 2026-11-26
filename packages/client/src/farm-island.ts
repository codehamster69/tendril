import * as THREE from 'three';

/**
 * The island body, built from the land the player owns (client only, nothing here touches the sim).
 * One signed-distance field over the owned tiles plus a wild rim drives everything: the lofted body (grass lip, cliff,
 * craggy taper), the roots and hanging moss, the rim dressing and the cloud sea. All placement uses world-space hashes,
 * so the same land always dresses the same way and a bigger farm keeps what it had where it still fits.
 * The field never has more than about 110 cells a side, so the cost follows the screen, not the size of the farm.
 */
export interface Bounds { x0: number; x1: number; z0: number; z1: number }
export interface Ownership { count: number; each(cb: (x: number, y: number) => void): void; has(x: number, y: number): boolean }

/** Width of the wild rim around the owned land, in tiles. */
export const RIM = 1.5;
const PAD = RIM + 3;
const TOP_Y = -0.015;
const LIP = 0.12;

export function hash(i: number, j: number, k: number): number {
  let h = (Math.imul(Math.floor(i) | 0, 374761393) + Math.imul(Math.floor(j) | 0, 668265263) + Math.imul(k, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
/** Smooth value noise in 0..1. */
export function vnoise(x: number, z: number, k = 0): number {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz, k), b = hash(ix + 1, iz, k), c = hash(ix, iz + 1, k), d = hash(ix + 1, iz + 1, k);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const smooth = (a: number, b: number, x: number): number => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export interface Field { ox: number; oz: number; step: number; nx: number; nz: number; sdf: Float32Array; dOut: Float32Array }

function chamfer(d: Float32Array, nx: number, nz: number): void {
  const at = (i: number, j: number): number => (i < 0 || j < 0 || i >= nx || j >= nz ? Infinity : d[j * nx + i]!);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    d[j * nx + i] = Math.min(d[j * nx + i]!, at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + Math.SQRT2, at(i + 1, j - 1) + Math.SQRT2);
  }
  for (let j = nz - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
    d[j * nx + i] = Math.min(d[j * nx + i]!, at(i + 1, j) + 1, at(i, j + 1) + 1, at(i + 1, j + 1) + Math.SQRT2, at(i - 1, j + 1) + Math.SQRT2);
  }
}

function blur(f: Float32Array, nx: number, nz: number): void {
  const tmp = new Float32Array(f.length);
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) tmp[j * nx + i] = (f[j * nx + Math.max(0, i - 1)]! + f[j * nx + i]! + f[j * nx + Math.min(nx - 1, i + 1)]!) / 3;
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) f[j * nx + i] = (tmp[Math.max(0, j - 1) * nx + i]! + tmp[j * nx + i]! + tmp[Math.min(nz - 1, j + 1) * nx + i]!) / 3;
  }
}

/** Signed distance (tiles, negative on land) to the edge of the owned land grown by the rim, with a craggy outline. */
export function buildField(b: Bounds, own: Ownership): Field {
  const w = b.x1 - b.x0, d = b.z1 - b.z0;
  const step = Math.max(0.5, (Math.max(w, d) + 2 * PAD) / 110);
  const ox = b.x0 - PAD, oz = b.z0 - PAD;
  const nx = Math.ceil((w + 2 * PAD) / step) + 1, nz = Math.ceil((d + 2 * PAD) / step) + 1;
  const dOut = new Float32Array(nx * nz).fill(Infinity);
  const span = (c: number, o: number): [number, number] => {
    const a = Math.ceil((c - 0.5 - o) / step - 1e-6), b = Math.floor((c + 0.5 - o) / step + 1e-6);
    return b < a ? [Math.round((c - o) / step), Math.round((c - o) / step)] : [a, b];
  };
  own.each((x, y) => {
    const [i0, i1] = span(x, ox), [j0, j1] = span(y, oz);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (i >= 0 && j >= 0 && i < nx && j < nz) dOut[j * nx + i] = 0;
  });
  chamfer(dOut, nx, nz);
  for (let k = 0; k < dOut.length; k++) dOut[k] = Number.isFinite(dOut[k]!) ? dOut[k]! * step : 1e3;
  // Distance to the edge from inside the land.
  const inside = new Float32Array(nx * nz);
  for (let k = 0; k < inside.length; k++) inside[k] = dOut[k]! >= RIM ? 0 : Infinity;
  chamfer(inside, nx, nz);
  const sdf = new Float32Array(nx * nz);
  for (let k = 0; k < sdf.length; k++) sdf[k] = dOut[k]! >= RIM ? dOut[k]! - RIM : -Math.max(step * 0.5, inside[k]! * step - step * 0.5);
  blur(sdf, nx, nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const x = ox + i * step, z = oz + j * step;
    // Craggy outline: stronger in the rim, none right at the owned land.
    const k = Math.min(1, Math.max(0, (dOut[j * nx + i]! - 0.3) / 0.9));
    sdf[j * nx + i] = sdf[j * nx + i]! + k * ((vnoise(x * 0.42, z * 0.42, 1) - 0.5) * 0.9 + (vnoise(x * 1.1, z * 1.1, 2) - 0.5) * 0.35);
  }
  return { ox, oz, step, nx, nz, sdf, dOut };
}

/** Bilinear sample of a field array at a world position; outside the field it returns `outside`. */
export function sampleField(f: Field, arr: Float32Array, x: number, z: number, outside: number): number {
  const fx = (x - f.ox) / f.step, fz = (z - f.oz) / f.step;
  if (fx < 0 || fz < 0 || fx > f.nx - 1 || fz > f.nz - 1) return outside;
  const i = Math.min(f.nx - 2, Math.floor(fx)), j = Math.min(f.nz - 2, Math.floor(fz)), u = fx - i, v = fz - j;
  const a = arr[j * f.nx + i]!, b = arr[j * f.nx + i + 1]!, c = arr[(j + 1) * f.nx + i]!, d = arr[(j + 1) * f.nx + i + 1]!;
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export const sdfAt = (f: Field, x: number, z: number): number => sampleField(f, f.sdf, x, z, 99);
export const outAt = (f: Field, x: number, z: number): number => sampleField(f, f.dOut, x, z, 99);

/** How deep the island hangs for a field of this size (tiles). */
export function keelDepth(b: Bounds): number {
  const w = b.x1 - b.x0 + 2 * RIM, d = b.z1 - b.z0 + 2 * RIM;
  const size = Math.min((w + d) / 2, Math.min(w, d) * 2 + 2);
  return Math.min(48, Math.max(3, size * 0.4));
}

const topY = (f: number, bump: number): number => TOP_Y - LIP * smooth(-0.4, 0, f) + bump;
function depthBelow(t: number, H: number, x: number, z: number): number {
  const cliff = LIP + 0.85 * Math.pow(Math.min(1, t / 0.4), 0.7);
  const taper = (H - 1) * (1 - Math.exp(-Math.max(0, t - 0.4) / Math.max(1.6, H * 0.5)));
  const crag = 1 + (vnoise(x * 0.5, z * 0.5, 3) - 0.5) * 0.8 * smooth(0.4, 2, t) + (vnoise(x * 1.7, z * 1.7, 4) - 0.5) * 0.3 * smooth(0.2, 1.5, t);
  return (cliff + taper) * crag;
}

/** The lofted body: top surface and underside share the same outline; outside vertices are pulled onto the contour so the two meet. */
export function buildBody(f: Field, H: number): THREE.BufferGeometry {
  const { nx, nz, step, ox, oz, sdf } = f;
  const idx = new Int32Array(nx * nz).fill(-1);
  const px: number[] = [], pz: number[] = [], pf: number[] = [], bump: number[] = [];
  const grad = (i: number, j: number): [number, number] => {
    const g = (a: number, b: number): number => sdf[Math.min(nz - 1, Math.max(0, b)) * nx + Math.min(nx - 1, Math.max(0, a))]!;
    return [(g(i + 1, j) - g(i - 1, j)) / (2 * step), (g(i, j + 1) - g(i, j - 1)) / (2 * step)];
  };
  const need = (i: number, j: number): number => {
    const k = j * nx + i;
    if (idx[k]! >= 0) return idx[k]!;
    let x = ox + i * step, z = oz + j * step, fv = sdf[k]!;
    if (fv > 0) {
      const [gx, gz] = grad(i, j), gl = gx * gx + gz * gz;
      if (gl > 1e-6) { x -= (fv * gx) / gl; z -= (fv * gz) / gl; }
      fv = 0;
    }
    const lift = 0.08 * (vnoise(x * 2.3, z * 2.3, 5) - 0.3) * smooth(0.5, 1.3, outAt(f, x, z));
    idx[k] = px.length; px.push(x); pz.push(z); pf.push(fv); bump.push(lift);
    return idx[k]!;
  };
  const tris: number[] = [];
  for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = sdf[j * nx + i]!, b = sdf[j * nx + i + 1]!, c = sdf[(j + 1) * nx + i]!, d = sdf[(j + 1) * nx + i + 1]!;
    if (a >= 0 && b >= 0 && c >= 0 && d >= 0) continue;
    const ia = need(i, j), ib = need(i + 1, j), ic = need(i, j + 1), id = need(i + 1, j + 1);
    // Split along the diagonal that keeps both triangles on the land side.
    if (a + d < b + c) tris.push(ia, ic, id, ia, id, ib); else tris.push(ia, ic, ib, ib, ic, id);
  }
  const n = px.length;
  const pos = new Float32Array(n * 2 * 3);
  for (let k = 0; k < n; k++) {
    const t = Math.max(0, -pf[k]!);
    pos.set([px[k]!, topY(pf[k]!, bump[k]!), pz[k]!], k * 3);
    pos.set([px[k]!, -depthBelow(t, H, px[k]!, pz[k]!), pz[k]!], (n + k) * 3);
  }
  const index: number[] = [];
  for (let t = 0; t < tris.length; t += 3) {
    index.push(tris[t]!, tris[t + 1]!, tris[t + 2]!); // top faces up
    index.push(n + tris[t]!, n + tris[t + 2]!, n + tris[t + 1]!); // underside faces down
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** Geometry accumulator for tapered tubes and ribbons with vertex colours. */
export class Strands {
  pos: number[] = []; col: number[] = []; idx: number[] = [];
  get count(): number { return this.idx.length / 3; }
  /** A tube along points with a radius per point (5 sides). */
  tube(pts: THREE.Vector3[], radii: number[], c0: THREE.Color, c1: THREE.Color): void {
    const sides = 5, base = this.pos.length / 3, tan = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Color();
    for (let s = 0; s < pts.length; s++) {
      tan.copy(pts[Math.min(pts.length - 1, s + 1)]!).sub(pts[Math.max(0, s - 1)]!).normalize();
      a.set(0, 0, 1).cross(tan); if (a.lengthSq() < 1e-4) a.set(1, 0, 0).cross(tan);
      a.normalize(); b.copy(tan).cross(a);
      c.copy(c0).lerp(c1, s / (pts.length - 1));
      for (let k = 0; k < sides; k++) {
        const th = (k / sides) * Math.PI * 2, r = radii[s]!;
        this.pos.push(pts[s]!.x + (a.x * Math.cos(th) + b.x * Math.sin(th)) * r, pts[s]!.y + (a.y * Math.cos(th) + b.y * Math.sin(th)) * r, pts[s]!.z + (a.z * Math.cos(th) + b.z * Math.sin(th)) * r);
        this.col.push(c.r, c.g, c.b);
      }
    }
    for (let s = 0; s < pts.length - 1; s++) for (let k = 0; k < sides; k++) {
      const p = base + s * sides + k, q = base + s * sides + ((k + 1) % sides), r = p + sides, t = q + sides;
      this.idx.push(p, r, q, q, r, t);
    }
  }
  /** A flat strand of two triangles per segment, width `w` tapering to a point, facing the +x/z diagonal (two-sided material). */
  ribbon(pts: THREE.Vector3[], w: number, c0: THREE.Color, c1: THREE.Color, yaw: number): void {
    const base = this.pos.length / 3, sx = Math.cos(yaw), sz = Math.sin(yaw), c = new THREE.Color();
    for (let s = 0; s < pts.length; s++) {
      const u = s / (pts.length - 1), hw = w * (1 - u) * 0.5;
      c.copy(c0).lerp(c1, u);
      this.pos.push(pts[s]!.x - sx * hw, pts[s]!.y, pts[s]!.z - sz * hw, pts[s]!.x + sx * hw, pts[s]!.y, pts[s]!.z + sz * hw);
      this.col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
    for (let s = 0; s < pts.length - 1; s++) { const p = base + s * 2; this.idx.push(p, p + 2, p + 1, p + 1, p + 2, p + 3); }
  }
  geometry(): THREE.BufferGeometry | null {
    if (!this.idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

/** Where the underside is at a world position (negative y), so roots start on the surface. */
export function undersideY(f: Field, H: number, x: number, z: number): number {
  return -depthBelow(Math.max(0, -sdfAt(f, x, z)), H, x, z);
}

const BARK0 = new THREE.Color(0x3a281b), BARK1 = new THREE.Color(0x6a4d34), MOSS0 = new THREE.Color(0x4d7a34), MOSS1 = new THREE.Color(0x7aa447);

/** Bark roots: tapered tubes that leave the underside, curl as they hang, with rootlets. At most `max` roots. */
export function buildRoots(f: Field, H: number, max = 36): THREE.BufferGeometry | null {
  const s = new Strands(), cell = 2.4;
  const reach = Math.min(26, Math.max(2, H * 0.9));
  const bx0 = Math.floor(f.ox / cell), bx1 = Math.floor((f.ox + (f.nx - 1) * f.step) / cell), bz0 = Math.floor(f.oz / cell), bz1 = Math.floor((f.oz + (f.nz - 1) * f.step) / cell);
  const picks: { x: number; z: number; t: number; h: number }[] = [];
  for (let bz = bz0; bz <= bz1; bz++) for (let bx = bx0; bx <= bx1; bx++) {
    if (hash(bx, bz, 11) > 0.55) continue;
    const x = (bx + hash(bx, bz, 12)) * cell, z = (bz + hash(bx, bz, 13)) * cell, t = -sdfAt(f, x, z);
    if (t > 0.9 && t < 4.5) picks.push({ x, z, t, h: hash(bx, bz, 14) });
  }
  // Keep a spread of roots when a huge farm has too many candidates.
  const keep = picks.length > max ? picks.filter((_, k) => k % Math.ceil(picks.length / max) === 0) : picks;
  for (const p of keep) {
    const y0 = undersideY(f, H, p.x, p.z) + 0.08, len = 1.4 + p.h * reach * (0.4 + 0.6 * smooth(0.9, 4, p.t));
    const steps = 12, ph = p.h * 40, pts: THREE.Vector3[] = [], radii: number[] = [];
    // Hang down, leaning out along the edge normal, wandering a little.
    const ex = sdfAt(f, p.x + 0.3, p.z) - sdfAt(f, p.x - 0.3, p.z), ez = sdfAt(f, p.x, p.z + 0.3) - sdfAt(f, p.x, p.z - 0.3), el = Math.hypot(ex, ez) || 1;
    const r0 = 0.06 + p.h * 0.05;
    for (let k = 0; k <= steps; k++) {
      const u = k / steps;
      pts.push(new THREE.Vector3(p.x + (ex / el) * 0.35 * u * u * len * 0.2 + Math.sin(u * 4 + ph) * 0.18 * u, y0 - u * len, p.z + (ez / el) * 0.35 * u * u * len * 0.2 + Math.cos(u * 3.4 + ph) * 0.18 * u));
      radii.push(r0 * (k === 0 ? 1.7 : 1) * Math.pow(1 - u, 0.9) + 0.006);
    }
    s.tube(pts, radii, BARK0, BARK1);
    for (let r = 0; r < 3; r++) {
      const at = Math.floor(2 + hash(p.x, p.z, 20 + r) * (steps - 5)), a = hash(p.x, p.z, 30 + r) * Math.PI * 2, rl = 0.4 + hash(p.x, p.z, 40 + r) * Math.min(1.4, len * 0.3);
      const q: THREE.Vector3[] = [], qr: number[] = [];
      for (let k = 0; k <= 5; k++) {
        const u = k / 5;
        q.push(new THREE.Vector3(pts[at]!.x + Math.cos(a) * u * rl * 0.7, pts[at]!.y - u * rl * 0.8, pts[at]!.z + Math.sin(a) * u * rl * 0.7));
        qr.push(Math.max(0.005, radii[at]! * 0.55 * (1 - u)));
      }
      s.tube(q, qr, BARK0, BARK1);
    }
  }
  return s.geometry();
}

/** Moss that hangs from the grass lip: short tapering strands, thicker where the noise is high. */
export function buildMoss(f: Field, max = 700): THREE.BufferGeometry | null {
  const s = new Strands(), cell = 0.55, spots: { x: number; z: number; h: number }[] = [];
  const bx0 = Math.floor(f.ox / cell), bx1 = Math.floor((f.ox + (f.nx - 1) * f.step) / cell), bz0 = Math.floor(f.oz / cell), bz1 = Math.floor((f.oz + (f.nz - 1) * f.step) / cell);
  for (let bz = bz0; bz <= bz1; bz++) for (let bx = bx0; bx <= bx1; bx++) {
    const x = (bx + hash(bx, bz, 51)) * cell, z = (bz + hash(bx, bz, 52)) * cell, fv = sdfAt(f, x, z);
    if (fv < -0.1 || fv > 0.02) continue; // the contour itself
    if (vnoise(x * 0.8, z * 0.8, 9) < 0.42) continue;
    spots.push({ x, z, h: hash(bx, bz, 53) });
  }
  const keep = spots.length > max ? spots.filter((_, k) => k % Math.ceil(spots.length / max) === 0) : spots;
  for (const p of keep) {
    const gx = sdfAt(f, p.x + 0.2, p.z) - sdfAt(f, p.x - 0.2, p.z), gz = sdfAt(f, p.x, p.z + 0.2) - sdfAt(f, p.x, p.z - 0.2), gl = Math.hypot(gx, gz) || 1;
    const len = 0.25 + p.h * 0.7, pts: THREE.Vector3[] = [];
    for (let k = 0; k <= 3; k++) pts.push(new THREE.Vector3(p.x + (gx / gl) * 0.04 * k, -0.1 - (k / 3) * len, p.z + (gz / gl) * 0.04 * k));
    s.ribbon(pts, 0.07 + p.h * 0.05, MOSS0, MOSS1, Math.atan2(gz, gx) + Math.PI / 2);
  }
  return s.geometry();
}

export interface Prop { name: string; x: number; z: number; rotation: number; scale: number }
/** Meadow clumps on the rim: where the land is wild (past the wall, inside the outline), on a jittered lattice in world space. */
export function rimBlades(f: Field, max = 7000): { x: number; z: number; rotation: number; scale: number; tone: number }[] {
  const cell = 0.42, out: { x: number; z: number; rotation: number; scale: number; tone: number }[] = [];
  const bx0 = Math.floor(f.ox / cell), bx1 = Math.floor((f.ox + (f.nx - 1) * f.step) / cell), bz0 = Math.floor(f.oz / cell), bz1 = Math.floor((f.oz + (f.nz - 1) * f.step) / cell);
  for (let bz = bz0; bz <= bz1; bz++) for (let bx = bx0; bx <= bx1; bx++) {
    const x = (bx + hash(bx, bz, 61)) * cell, z = (bz + hash(bx, bz, 62)) * cell;
    if (outAt(f, x, z) < 0.55 || sdfAt(f, x, z) > -0.08) continue;
    if (hash(bx, bz, 63) > 0.38 + 0.4 * vnoise(x * 0.5, z * 0.5, 7)) continue;
    out.push({ x, z, rotation: hash(bx, bz, 64) * 6.28, scale: 0.8 + hash(bx, bz, 65) * 0.7, tone: 0.82 + hash(bx, bz, 66) * 0.36 });
  }
  return out.length > max ? out.filter((_, k) => k % Math.ceil(out.length / max) === 0) : out;
}

/** Trees, bushes, rocks and flowers on the rim, one candidate per 0.9-tile bucket, clear of the wall. */
export function rimProps(f: Field, max = 900): Prop[] {
  const cell = 0.9, out: Prop[] = [];
  const bx0 = Math.floor(f.ox / cell), bx1 = Math.floor((f.ox + (f.nx - 1) * f.step) / cell), bz0 = Math.floor(f.oz / cell), bz1 = Math.floor((f.oz + (f.nz - 1) * f.step) / cell);
  for (let bz = bz0; bz <= bz1; bz++) for (let bx = bx0; bx <= bx1; bx++) {
    const roll = hash(bx, bz, 71);
    if (roll > 0.6) continue;
    const x = (bx + 0.15 + hash(bx, bz, 72) * 0.7) * cell, z = (bz + 0.15 + hash(bx, bz, 73) * 0.7) * cell;
    const o = outAt(f, x, z), s = sdfAt(f, x, z);
    if (o < 0.8 || s > -0.2) continue;
    // Trees stay off the thin parts of the rim and keep their canopy inside the lip.
    const name = roll < 0.07 && s < -0.35 ? 'prop_tree' : roll < 0.2 ? 'prop_bush' : roll < 0.3 ? 'prop_rocks' : 'prop_flowers';
    const r74 = hash(bx, bz, 74), sc = name === 'prop_tree' ? 0.85 + r74 * 0.45 : name === 'prop_flowers' ? 0.9 + r74 * 0.4 : name === 'prop_rocks' ? 0.4 + r74 * 0.3 : 0.6 + r74 * 0.4;
    out.push({ name, x, z, rotation: hash(bx, bz, 75) * 6.28, scale: sc });
  }
  return out.length > max ? out.filter((_, k) => k % Math.ceil(out.length / max) === 0) : out;
}

export interface WallStone { x: number; y: number; z: number; sx: number; sy: number; sz: number; rotation: number; tone: number }
/** Dry-stone wall on the owned edge: two courses of uneven stones, with a gap now and then. Skipped on very large farms (it would be a speck). */
export function wallStones(own: Ownership, maxEdges = 3000): WallStone[] {
  const out: WallStone[] = [];
  let edges = 0;
  own.each((x, y) => {
    if (edges > maxEdges) return;
    for (const [dx, dz] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
      if (own.has(x + dx, y + dz)) continue;
      edges++;
      if (hash(x * 4 + dx, y * 4 + dz, 81) < 0.1) continue; // a gap in the wall
      const cx = x + dx * 0.6, cz = y + dz * 0.6, along = dx ? [0, 1] : [1, 0], yaw = dx ? Math.PI / 2 : 0;
      for (let course = 0; course < 2; course++) {
        const n = course ? 2 : 3;
        for (let k = 0; k < n; k++) {
          const u = ((k + 0.5) / n - 0.5) * 1.22 + (hash(x, y, 90 + k + course * 4 + dx * 2 + dz) - 0.5) * 0.06;
          const len = 1.22 / n * (0.9 + hash(x + dx, y + dz, 100 + k) * 0.18);
          out.push({
            x: cx + along[0]! * u, z: cz + along[1]! * u, y: course ? 0.17 : 0.07,
            sx: len, sy: course ? 0.1 : 0.13, sz: 0.2 - course * 0.03 + hash(x, y, 110 + k) * 0.03,
            rotation: yaw + (hash(x, y, 120 + k + course) - 0.5) * 0.12, tone: 0.62 + hash(x * 3 + k, y * 3 + dx, 130 + course) * 0.6,
          });
        }
      }
    }
  });
  return edges > maxEdges ? [] : out;
}

export interface Puff { x: number; y: number; z: number; r: number; flat: number }
/** The cloud sea: soft puffs under and around the island, clear of the land. */
export function cloudPuffs(f: Field, b: Bounds, H: number): Puff[] {
  const w = b.x1 - b.x0, d = b.z1 - b.z0, size = Math.max(w, d), cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
  const rad = Math.min(8, Math.max(1.5, size * 0.06)), out: Puff[] = [];
  const clusters = 13, reach = size * 0.7 + 4 + rad * 2;
  for (let k = 0; k < clusters; k++) {
    const a = hash(k, 1, 141) * Math.PI * 2, rr = (0.3 + 0.7 * Math.sqrt(hash(k, 2, 142))) * reach;
    const x0 = cx + Math.cos(a) * rr * (w >= d ? 1.2 : 0.9), z0 = cz + Math.sin(a) * rr * (d >= w ? 1.2 : 0.9);
    // A sea below the island with a few banks climbing its far sides.
    const y0 = -H * 0.7 - 2.2 - hash(k, 4, 144) * Math.max(2, H * 0.5) + hash(k, 5, 145) * H * 0.3 * smooth(reach * 0.55, reach, rr);
    const n = 3 + Math.floor(hash(k, 7, 147) * 3);
    for (let j = 0; j < n; j++) {
      const r = rad * (0.5 + hash(k, 10 + j, 143) * 0.6) * (j === 0 ? 1.25 : 1);
      const x = x0 + (j === 0 ? 0 : (hash(k, 20 + j, 148) - 0.5) * rad * 2.4), z = z0 + (j === 0 ? 0 : (hash(k, 30 + j, 149) - 0.5) * rad * 1.8), y = y0 + (j === 0 ? 0 : hash(k, 40 + j, 150) * r * 0.5);
      // Under the island the keel hangs here: keep puffs below it or clear of the land.
      if (sdfAt(f, x, z) < r * 1.1 && y + r * 0.5 > undersideY(f, H, x, z)) continue;
      out.push({ x, y, z, r, flat: 0.6 + hash(k, 50 + j, 146) * 0.2 });
    }
  }
  return out;
}

/** A full rectangle of land, for callers that only know the bounds. */
export function rectOwnership(b: Bounds): Ownership {
  const x0 = Math.round(b.x0 + 0.5), x1 = Math.round(b.x1 - 0.5), z0 = Math.round(b.z0 + 0.5), z1 = Math.round(b.z1 - 0.5);
  return {
    count: (x1 - x0 + 1) * (z1 - z0 + 1),
    each: (cb) => { for (let y = z0; y <= z1; y++) for (let x = x0; x <= x1; x++) cb(x, y); },
    has: (x, y) => x >= x0 && x <= x1 && y >= z0 && y <= z1,
  };
}
