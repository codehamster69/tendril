import * as THREE from 'three';
import type { Snapshot } from './sim-types';

export type Placement = { x: number; z: number; rotation?: number; scale?: number; depth?: number };
export type Bounds = { x0: number; x1: number; z0: number; z1: number };

export function tileBounds(tiles: Snapshot['tiles']): Bounds | null {
  if (!tiles.length) return null;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const tile of tiles) { x0 = Math.min(x0, tile.x - 0.5); x1 = Math.max(x1, tile.x + 0.5); z0 = Math.min(z0, tile.y - 0.5); z1 = Math.max(z1, tile.y + 0.5); }
  return { x0, x1, z0, z1 };
}

const seeded = (seed: number): (() => number) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

export interface Island {
  rebuild(bounds: Bounds): void;
  pulse(time: number): void;
  dispose(): void;
}

/**
 * The living island: a floating slab of soil strata over a faceted stone keel,
 * with glowing tendrils hanging from the rim and a pulsing frontier edge where
 * the next plots are bought. Replaces the old meadow plane and terrace walls.
 */
export function createIsland(scene: THREE.Scene): Island {
  const group = new THREE.Group();
  scene.add(group);
  const frontier = [0, 1, 2, 3].map(() => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 0.02, 1), new THREE.MeshBasicMaterial({ color: 0x4fd1b0, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
    scene.add(mesh);
    return mesh;
  });
  let bounds: Bounds | null = null;

  const rebuild = (next: Bounds): void => {
    bounds = next;
    for (const child of [...group.children]) {
      group.remove(child);
      if (child instanceof THREE.Mesh) { child.geometry.dispose(); (child.material as THREE.Material).dispose(); }
    }
    const spanX = next.x1 - next.x0, spanZ = next.z1 - next.z0;
    const cx = (next.x0 + next.x1) / 2, cz = (next.z0 + next.z1) / 2;
    const WX = spanX + 0.1, WZ = spanZ + 0.1;
    const material = (color: number): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({ color, roughness: 0.95, flatShading: true });
    const add = (geometry: THREE.BufferGeometry, color: number, y: number): THREE.Mesh => {
      const mesh = new THREE.Mesh(geometry, material(color));
      mesh.position.set(cx, y, cz);
      mesh.receiveShadow = true;
      group.add(mesh);
      return mesh;
    };
    add(new THREE.BoxGeometry(WX, 0.22, WZ), 0x33231f, -0.41);
    add(new THREE.BoxGeometry(WX + 0.06, 0.32, WZ + 0.06), 0x7a5a45, -0.68);
    add(new THREE.BoxGeometry(WX + 0.02, 0.3, WZ + 0.02), 0xa07f5e, -0.99);
    const short = Math.min(WX, WZ);
    const keelHeight = Math.min(16, Math.max(2.6, short * 0.35));
    add(new THREE.ConeGeometry(Math.SQRT1_2, keelHeight, 4).rotateY(Math.PI / 4).rotateX(Math.PI).scale(WX, 1, WZ), 0x586a70, -1.14 - keelHeight / 2);
    const tendrilMaterial = new THREE.MeshStandardMaterial({ color: 0x3fb596, emissive: 0x1d6b58, roughness: 0.7 });
    const random = seeded(7);
    const count = Math.min(60, Math.round(8 + (WX + WZ) * 0.35));
    for (let k = 0; k < count; k++) {
      const side = (k * 7) % 4;
      const alongX = side < 2;
      const t = random() * (alongX ? WX : WZ) - (alongX ? WX : WZ) / 2;
      const edge = (alongX ? WZ : WX) / 2 + 0.02;
      let x0: number, z0: number, dx: number, dz: number;
      if (side === 0) { x0 = t; z0 = -edge; dx = 0; dz = -1; }
      else if (side === 1) { x0 = t; z0 = edge; dx = 0; dz = 1; }
      else if (side === 2) { x0 = -edge; z0 = t; dx = -1; dz = 0; }
      else { x0 = edge; z0 = t; dx = 1; dz = 0; }
      const length = 1.2 + random() * Math.min(18, Math.max(1.5, short * 0.14));
      const points: THREE.Vector3[] = [];
      const phase = random() * 6;
      for (let s = 0; s <= 10; s++) {
        const u = s / 10, curl = Math.max(0, u - 0.65) / 0.35;
        points.push(new THREE.Vector3(
          cx + x0 + dx * (0.12 + 0.25 * Math.sin(u * 3 + phase) + curl * 0.28 * Math.cos(curl * 7)),
          -0.7 - u * length,
          cz + z0 + dz * (0.12 + 0.25 * Math.cos(u * 2.6 + phase) + curl * 0.28 * Math.sin(curl * 7))));
      }
      group.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 24, 0.035, 5), tendrilMaterial));
    }
  };

  const pulse = (time: number): void => {
    if (!bounds) return;
    const { x0, x1, z0, z1 } = bounds;
    const width = 0.16;
    const edges: [number, number, number, number][] = [
      [(x0 + x1) / 2, z0, x1 - x0, width], [(x0 + x1) / 2, z1, x1 - x0, width],
      [x0, (z0 + z1) / 2, width, z1 - z0], [x1, (z0 + z1) / 2, width, z1 - z0]];
    const opacity = 0.45 + 0.3 * Math.sin(time * 2);
    frontier.forEach((mesh, i) => {
      const [x, z, sx, sz] = edges[i]!;
      mesh.position.set(x, 0.06, z);
      mesh.scale.set(Math.max(0.14, sx), 1, Math.max(0.14, sz));
      mesh.material.opacity = opacity;
    });
  };

  const dispose = (): void => {
    for (const child of [...group.children]) {
      group.remove(child);
      if (child instanceof THREE.Mesh) { child.geometry.dispose(); (child.material as THREE.Material).dispose(); }
    }
    for (const mesh of frontier) { scene.remove(mesh); mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); }
    scene.remove(group);
  };

  return { rebuild, pulse, dispose };
}
