import * as THREE from 'three';
import type { AssetModel } from './asset-loader';
import { bladeClumpGeometry } from './farm-ground';
import { buildBody, buildField, buildMoss, buildRoots, cloudPuffs, keelDepth, rimBlades, rimProps, rectOwnership, wallStones, type Bounds, type Field, type Ownership } from './farm-island';
import type { Snapshot } from './sim-types';

/** Survey stakes per farm, capped so a huge perimeter stays one instanced draw call. */
const MAX_STAKES = 160;
const UP = new THREE.Vector3(0, 1, 0);

export type Placement = { x: number; z: number; rotation?: number; scale?: number; depth?: number };
export type { Bounds, Ownership };
export { rectOwnership };

export function tileBounds(tiles: Snapshot['tiles']): Bounds | null {
  if (!tiles.length) return null;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const tile of tiles) { x0 = Math.min(x0, tile.x - 0.5); x1 = Math.max(x1, tile.x + 0.5); z0 = Math.min(z0, tile.y - 0.5); z1 = Math.max(z1, tile.y + 0.5); }
  return { x0, x1, z0, z1 };
}

/** Legacy placements (terrace walls, trees, rocks). The island (`FarmIsland`) replaces the walls and the meadow plane: the integration should ignore the `tile_terrace_wall` list. Terrace walls around the owned land, plus sparse trees and rocks wholly outside its bounding rectangle. */
export function sceneryPlacements(tiles: Snapshot['tiles'], { x0, x1, z0, z1 }: Bounds, owned: (x: number, y: number) => boolean): Map<string, Placement[]> {
  const walls: Placement[] = [];
  for (const tile of tiles) {
    for (const [dx, dz] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      if (!owned(tile.x + dx, tile.y + dz)) {
        // AT's riser is a full 1x1 tile, so narrow its depth and place it
        // wholly outside the playable edge, below the unchanged ground plane.
        walls.push({ x: tile.x + dx * 0.54, z: tile.y + dz * 0.54, rotation: dx ? Math.PI / 2 : 0, depth: 0.08 });
      }
    }
  }
  const trees: Placement[] = [], rocks: Placement[] = [];
  for (const fraction of [0.18, 0.76]) {
    trees.push({ x: x0 - 3, z: z0 + (z1 - z0) * fraction, scale: 0.9 }, { x: x1 + 3.2, z: z0 + (z1 - z0) * fraction, scale: 1.1 },
      { x: x0 + (x1 - x0) * fraction, z: z0 - 3, scale: 0.8 });
    rocks.push({ x: x0 - 2, z: z1 + fraction, rotation: fraction * 4 }, { x: x1 + 2, z: z1 - fraction, scale: 0.8 });
  }
  return new Map([['tile_terrace_wall', walls], ['prop_tree', trees], ['prop_rocks', rocks]]);
}

/* ------------------------------------------------------------------ the living island */

const GLSL_NOISE = `
float ih(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float inz(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(ih(i), ih(i + vec2(1.0, 0.0)), f.x), mix(ih(i + vec2(0.0, 1.0)), ih(i + vec2(1.0, 1.0)), f.x), f.y); }`;

/** Island body shader: grass on the lip and up-facing top, banded earth, clay and stone by depth with noise, moss on up-facing ledges. Colours come from world position, so a rebuilt body never changes look. */
function bodyMaterial(uniforms: { uBand: { value: number } }): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96, flatShading: true });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uBand = uniforms.uBand;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWP;\nuniform float uBand;\n${GLSL_NOISE}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  float up = inverseTransformDirection(normal, viewMatrix).y;
  float depth = -vWP.y;
  float dd = (depth + (inz(vWP.xz * 0.9 + vWP.y * 0.4) - 0.5) * 0.55 + (inz(vWP.xz * 3.1 + vWP.y * 2.3) - 0.5) * 0.14) / uBand;
  vec3 top = vec3(0.38, 0.24, 0.15), earth = vec3(0.58, 0.37, 0.22), clay = vec3(0.86, 0.55, 0.31), clay2 = vec3(0.95, 0.74, 0.46), stone = vec3(0.55, 0.57, 0.58), stone2 = vec3(0.72, 0.73, 0.72);
  float band = 0.5 + 0.5 * sin(dd * 8.0 + inz(vWP.xz * 0.6) * 3.0);
  vec3 c = mix(top, earth, smoothstep(0.1, 0.8, dd));
  c = mix(c, mix(earth, clay, band), smoothstep(0.9, 1.7, dd));
  c = mix(c, mix(clay, clay2, band), smoothstep(2.2, 3.4, dd));
  c = mix(c, mix(stone, stone2, band), smoothstep(3.6, 5.2, dd));
  c *= 0.86 + 0.28 * inz(vWP.xz * 2.2 + vWP.y * 1.7);
  float n = inz(vWP.xz * 1.1) * 0.65 + inz(vWP.xz * 3.63) * 0.35;
  vec3 g = vec3(0.373, 0.553, 0.243) * 0.94 * (0.86 + 0.28 * n);
  float s = smoothstep(0.58, 0.78, inz(vWP.xz * 0.33 + 7.0));
  g = mix(g, g * vec3(1.28, 1.12, 0.62), s * 0.8);
  float grass = max(smoothstep(0.45, 0.7, up) * step(-0.4, vWP.y), (1.0 - smoothstep(0.06, 0.2, depth)) * smoothstep(-0.2, 0.25, up));
  float moss = smoothstep(0.3, 0.6, up) * smoothstep(0.35, 0.55, inz(vWP.xz * 2.0 + vWP.y)) * smoothstep(0.3, 0.6, depth) * (1.0 - grass);
  vec3 mc = vec3(0.26, 0.43, 0.17) * (0.8 + 0.4 * inz(vWP.xz * 4.0));
  c = mix(c, mc, moss * 0.9);
  diffuseColor.rgb = pow(mix(c, g, grass), vec3(2.2));
}`);
  };
  m.customProgramCacheKey = () => 'island-body';
  return m;
}

/** The floating island under the farm, lofted from the owned land plus a wild rim: grass lip, banded cliff with moss, bark roots, hanging moss, dry-stone wall, meadow and props on the rim, and a cloud sea below. The tile ground itself is drawn by the world view. A plain line marks where land can grow. Everything is static between plot changes and its size is capped, so cost never follows the size of the farm. */
export class FarmIsland {
  private group = new THREE.Group();
  private dressing = new THREE.Group();
  /** Land for sale: survey stakes with carrot flags, a string line round the owned land, and a price board on the edge facing the camera. */
  private frontier = new THREE.Group();
  private frontierMat = new THREE.MeshBasicMaterial({ color: 0xece2d0, transparent: true, opacity: 0.6, depthWrite: false });
  private frontierBars: THREE.Mesh[] = [];
  private stakeMat = new THREE.MeshStandardMaterial({ color: 0x6b5238, roughness: 1, flatShading: true });
  private flagMat = new THREE.MeshBasicMaterial({ color: 0xf08a3a, side: THREE.DoubleSide });
  private stakeGeo = new THREE.BoxGeometry(0.05, 0.5, 0.05).translate(0, 0.25, 0);
  private flagGeo = new THREE.PlaneGeometry(0.24, 0.14).translate(0.12, 0.43, 0);
  private stakes = new THREE.InstancedMesh(this.stakeGeo, this.stakeMat, MAX_STAKES);
  private flags = new THREE.InstancedMesh(this.flagGeo, this.flagMat, MAX_STAKES);
  private board = new THREE.Group();
  private boardPost = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.72, 0.07).translate(0, 0.36, 0), this.stakeMat);
  private boardMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  private boardGeo = new THREE.PlaneGeometry(1.5, 0.62).translate(0, 0.92, 0.04);
  private boardTex: THREE.CanvasTexture | null = null;
  private price: number | null = null;
  private viewAt = { x: 0, z: 0 };
  private unitBox = new THREE.BoxGeometry(1, 1, 1);
  private bodyUniforms = { uBand: { value: 1 } };
  private bodyMat = bodyMaterial(this.bodyUniforms);
  private rootMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
  private mossMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, side: THREE.DoubleSide });
  private stoneMat = new THREE.MeshStandardMaterial({ color: 0x817c70, roughness: 1, flatShading: true });
  private bladeGeo = bladeClumpGeometry();
  private bladeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide });
  private cloudGeo = new THREE.IcosahedronGeometry(1, 2);
  private cloudMat = new THREE.MeshLambertMaterial({ color: 0xdde3ea });
  private built: THREE.Object3D[] = [];
  private bounds: Bounds | null = null;
  private own: Ownership | null = null;
  private field: Field | null = null;
  private boundsKey = '';
  private disposed = false;
  /** Counters for the tests and perf notes. */
  stats = { bodyTriangles: 0, roots: 0, wallStones: 0, props: 0, blades: 0, puffs: 0 };

  constructor(private scene: THREE.Scene, private models: ((name: string) => AssetModel) | null = null) {
    for (let i = 0; i < 4; i++) {
      const bar = new THREE.Mesh(this.unitBox, this.frontierMat);
      bar.frustumCulled = false; bar.renderOrder = 2;
      this.frontier.add(bar); this.frontierBars.push(bar);
    }
    this.stakes.count = 0; this.flags.count = 0;
    this.stakes.frustumCulled = this.flags.frustumCulled = false;
    this.frontier.add(this.stakes, this.flags, this.board);
    this.board.add(this.boardPost, new THREE.Mesh(this.boardGeo, this.boardMat));
    this.group.visible = false;
    this.frontier.visible = false;
    scene.add(this.group, this.dressing, this.frontier);
  }

  /** Call when the snapshot changes (not per frame). Rebuilds only when the owned land changes. `price` is the cost of the next plot. */
  update(bounds: Bounds | null, own: Ownership | null = null, price: number | null = null): void {
    if (this.disposed) return;
    this.bounds = bounds; this.own = own;
    this.group.visible = this.dressing.visible = this.frontier.visible = !!bounds;
    if (!bounds) { this.boundsKey = ''; this.clear(); return; }
    const key = `${bounds.x0},${bounds.x1},${bounds.z0},${bounds.z1}|${own?.count ?? 0}`;
    if (key !== this.boundsKey) { this.boundsKey = key; this.rebuild(); this.layoutFrontier(); }
    if (price !== this.price) { this.price = price; this.drawBoard(); }
  }

  /** Each frame is cheap: the board moves to whichever outer edge is nearest the camera (only rebuilt when that edge changes). */
  faceCamera(x: number, z: number): void {
    if (this.disposed || !this.bounds || (x === this.viewAt.x && z === this.viewAt.z)) return;
    this.viewAt = { x, z };
    this.placeBoard();
  }

  /** Models arrived or changed: dress the rim again with the real ones. */
  refreshModels(): void {
    if (this.disposed || !this.bounds || !this.field) return;
    this.rebuild();
  }

  private clear(): void {
    for (const o of this.built) {
      o.parent?.remove(o);
      if (o instanceof THREE.Mesh && o.userData.own) o.geometry.dispose();
      if (o instanceof THREE.InstancedMesh) o.dispose();
    }
    this.built = [];
  }

  private add(o: THREE.Object3D, parent: THREE.Object3D = this.group): void { parent.add(o); this.built.push(o); }

  private rebuild(): void {
    this.clear();
    const b = this.bounds!, own = this.own ?? rectOwnership(b);
    const field = this.field = buildField(b, own), H = keelDepth(b);
    this.bodyUniforms.uBand.value = Math.min(3, Math.max(0.5, H / 5));
    const mesh = (geo: THREE.BufferGeometry | null, mat: THREE.Material, shadow = false): void => {
      if (!geo) return;
      const m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false; m.receiveShadow = true; m.castShadow = shadow; m.userData.own = true;
      this.add(m);
    };
    const body = buildBody(field, H);
    this.stats.bodyTriangles = (body.index?.count ?? 0) / 3;
    mesh(body, this.bodyMat);
    const roots = buildRoots(field, H); this.stats.roots = roots ? roots.index!.count / 3 : 0;
    mesh(roots, this.rootMat);
    mesh(buildMoss(field), this.mossMat);

    const dummy = new THREE.Object3D(), col = new THREE.Color();
    const instanced = (geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], n: number, cast: boolean, parent: THREE.Object3D = this.dressing): THREE.InstancedMesh => {
      const im = new THREE.InstancedMesh(geo, mat, Math.max(1, n));
      im.frustumCulled = false; im.castShadow = cast; im.receiveShadow = true; im.count = 0;
      this.add(im, parent);
      return im;
    };
    // Dry-stone wall.
    const stones = wallStones(own); this.stats.wallStones = stones.length;
    if (stones.length) {
      const im = instanced(this.unitBox, this.stoneMat, stones.length, true);
      stones.forEach((st, i) => {
        dummy.position.set(st.x, st.y + st.sy / 2, st.z); dummy.rotation.set(0, st.rotation, 0); dummy.scale.set(st.sx, st.sy, st.sz); dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix); im.setColorAt(i, col.setRGB(st.tone, st.tone * 0.98, st.tone * 0.92));
      });
      im.count = stones.length; im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
    // Meadow clumps on the rim.
    const blades = rimBlades(field); this.stats.blades = blades.length;
    if (blades.length) {
      const im = instanced(this.bladeGeo, this.bladeMat, blades.length, false);
      blades.forEach((bl, i) => {
        dummy.position.set(bl.x, 0, bl.z); dummy.rotation.set(0, bl.rotation, 0); dummy.scale.setScalar(bl.scale); dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix); im.setColorAt(i, col.setRGB(bl.tone, bl.tone, bl.tone * 0.92));
      });
      im.count = blades.length; im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
    // Props from the existing models, placed from world-space hashes.
    const props = this.models ? rimProps(field) : [];
    this.stats.props = props.length;
    for (const name of new Set(props.map((p) => p.name))) {
      const model = this.models!(name), list = props.filter((p) => p.name === name);
      for (const part of model.parts) {
        const im = instanced(part.geometry, part.material, list.length, name === 'prop_tree' || name === 'prop_rocks');
        list.forEach((p, i) => {
          dummy.position.set(p.x, 0, p.z); dummy.rotation.set(0, p.rotation, 0); dummy.scale.setScalar(p.scale); dummy.updateMatrix();
          im.setMatrixAt(i, dummy.matrix);
        });
        im.count = list.length; im.instanceMatrix.needsUpdate = true;
      }
    }
    // Cloud sea: no shadows, one draw call.
    const puffs = cloudPuffs(field, b, H); this.stats.puffs = puffs.length;
    if (puffs.length) {
      const im = instanced(this.cloudGeo, this.cloudMat, puffs.length, false, this.group);
      im.receiveShadow = false;
      puffs.forEach((p, i) => {
        dummy.position.set(p.x, p.y, p.z); dummy.rotation.set(0, i * 1.7, 0); dummy.scale.set(p.r * 1.35, p.r * p.flat, p.r); dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix);
      });
      im.count = puffs.length; im.instanceMatrix.needsUpdate = true;
    }
  }

  private layoutFrontier(): void {
    const b = this.bounds;
    if (!b) return;
    const T = 0.022, Y = 0.42, w = b.x1 - b.x0, d = b.z1 - b.z0, cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
    // The string line runs along the top of the stakes, one thin bar per side.
    const [n, s, wst, e] = this.frontierBars as [THREE.Mesh, THREE.Mesh, THREE.Mesh, THREE.Mesh];
    n.position.set(cx, Y, b.z0); n.scale.set(w + T, T, T);
    s.position.set(cx, Y, b.z1); s.scale.set(w + T, T, T);
    wst.position.set(b.x0, Y, cz); wst.scale.set(T, T, d + T);
    e.position.set(b.x1, Y, cz); e.scale.set(T, T, d + T);
    // Stakes every ~2 tiles along the perimeter, capped so a huge farm stays one draw call.
    const perimeter = 2 * (w + d), step = Math.max(2, perimeter / (MAX_STAKES - 8));
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
    let k = 0;
    const put = (x: number, z: number, yaw: number): void => {
      if (k >= MAX_STAKES) return;
      q.setFromAxisAngle(UP, yaw);
      p.set(x, 0, z); m.compose(p, q, sc); this.stakes.setMatrixAt(k, m); this.flags.setMatrixAt(k, m); k++;
    };
    const edge = (x0: number, z0: number, x1: number, z1: number, yaw: number): void => {
      const segs = Math.max(1, Math.round(Math.hypot(x1 - x0, z1 - z0) / step));
      for (let i = 0; i <= segs; i++) put(x0 + ((x1 - x0) * i) / segs, z0 + ((z1 - z0) * i) / segs, yaw);
    };
    edge(b.x0, b.z0, b.x1, b.z0, 0); edge(b.x0, b.z1, b.x1, b.z1, 0);
    edge(b.x0, b.z0, b.x0, b.z1, Math.PI / 2); edge(b.x1, b.z0, b.x1, b.z1, Math.PI / 2);
    this.stakes.count = this.flags.count = k;
    this.stakes.instanceMatrix.needsUpdate = true; this.flags.instanceMatrix.needsUpdate = true;
    this.placeBoard();
  }

  /** The board sits just outside the outer edge whose midpoint is nearest the camera, turned to face the view. */
  private placeBoard(): void {
    const b = this.bounds;
    if (!b) return;
    const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2, reach = 0.6;
    const sides = [
      { x: cx, z: b.z0 - reach, nx: 0, nz: -1 }, { x: cx, z: b.z1 + reach, nx: 0, nz: 1 },
      { x: b.x0 - reach, z: cz, nx: -1, nz: 0 }, { x: b.x1 + reach, z: cz, nx: 1, nz: 0 },
    ];
    let best = sides[1]!;
    for (const sd of sides) if (Math.hypot(sd.x - this.viewAt.x, sd.z - this.viewAt.z) < Math.hypot(best.x - this.viewAt.x, best.z - this.viewAt.z)) best = sd;
    this.board.position.set(best.x, 0, best.z);
    this.board.rotation.y = Math.atan2(best.nx, best.nz);
  }

  /** Draws the price board text (a plot price in coins, or a hint when there is nothing left to buy). */
  private drawBoard(): void {
    if (this.disposed) return;
    const c = document.createElement('canvas');
    c.width = 384; c.height = 160;
    const g = c.getContext('2d');
    if (!g) return;
    g.fillStyle = '#18130e'; g.fillRect(0, 0, c.width, c.height);
    g.strokeStyle = '#5c4835'; g.lineWidth = 4; g.strokeRect(4, 4, c.width - 8, c.height - 8);
    g.fillStyle = '#a99881'; g.font = '600 26px sans-serif'; g.textBaseline = 'middle';
    g.fillText('LAND FOR SALE', 22, 40);
    g.fillStyle = '#f08a3a'; g.font = '700 54px sans-serif';
    g.fillText(this.price === null ? 'Ask the farmer' : `${this.price} coins`, 22, 102);
    g.fillStyle = '#ece2d0'; g.font = '500 22px sans-serif';
    g.fillText('next plot', 22, 138);
    this.boardTex?.dispose();
    this.boardTex = new THREE.CanvasTexture(c);
    this.boardTex.colorSpace = THREE.SRGBColorSpace;
    this.boardMat.map = this.boardTex;
    this.boardMat.needsUpdate = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.scene.remove(this.group, this.dressing, this.frontier);
    for (const g of [this.unitBox, this.bladeGeo, this.cloudGeo, this.stakeGeo, this.flagGeo, this.boardGeo, this.boardPost.geometry]) g.dispose();
    for (const m of [this.frontierMat, this.bodyMat, this.rootMat, this.mossMat, this.stoneMat, this.bladeMat, this.cloudMat, this.stakeMat, this.flagMat, this.boardMat]) m.dispose();
    this.stakes.dispose(); this.flags.dispose(); this.boardTex?.dispose();
  }
}
