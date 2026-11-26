import * as THREE from 'three';
import type { Snapshot } from './sim-types.ts';
import { matte } from './fallback-models.ts';
import { dropUnit, type DropDistances } from './drop-distance.ts';

/** `grid` draws only the tile outlines (the Grid lens); the others tint the tiles. */
export type FarmOverlay = 'none' | 'grid' | 'moisture' | 'nitrogen' | 'fatigue' | 'growth' | 'drop';
const OVERLAYS = {
  moisture: [new THREE.Color('#e0bb79'), new THREE.Color('#287caf')],
  nitrogen: [new THREE.Color('#e0c898'), new THREE.Color('#468653')],
  fatigue: [new THREE.Color('#8fc3a4'), new THREE.Color('#bf6650')],
  growth: [new THREE.Color('#9aa98c'), new THREE.Color('#f2b84b')],
  // Near a drop: tendril teal. Far from every barn and silo: clay.
  drop: [new THREE.Color('#4fd1b0'), new THREE.Color('#c86a3a')],
};
/** Lens plates sit just above the furrow crests so they cover the soil. */
const TOP = 0.068;
export const unit = (value: number): number => THREE.MathUtils.clamp(value / 100, 0, 1);
/** Most instances any one mesh holds (a hard cap, whatever the farm size). */
export const MAX_OVERLAY = 20000;

/** The lens colour of one tile (used per cell when tiles are merged at Map zoom). `far` is the drop lens's 0..1 distance. */
export function overlayColor(overlay: Exclude<FarmOverlay, 'none' | 'grid'>, tile: Snapshot['tiles'][number], out: THREE.Color, far = 0): THREE.Color {
  const [low, high] = OVERLAYS[overlay];
  const k = overlay === 'drop' ? far : overlay === 'growth' ? (tile.crop ? tile.stage / 3 : 0) : unit(tile[overlay]);
  return out.copy(low).lerp(high, k);
}

/** The soil-lens colour layer and the faint tile guides, both one instanced mesh each. */
export class OverlayLayer {
  mesh: THREE.InstancedMesh | null = null;
  private guides: THREE.InstancedMesh | null = null;
  private capacity = 0;
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();

  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) { this.scene = scene; }

  private flat(x: number, y: number, z: number): THREE.Matrix4 {
    this.dummy.position.set(x, y, z);
    this.dummy.rotation.set(0, 0, 0); this.dummy.scale.setScalar(1); this.dummy.updateMatrix();
    return this.dummy.matrix;
  }

  private drop(): void {
    for (const mesh of [this.mesh, this.guides]) {
      if (!mesh) continue;
      this.scene.remove(mesh); mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); mesh.dispose();
    }
    this.mesh = this.guides = null; this.capacity = 0;
  }

  /**
   * Draws `tiles` (the visible ones, at most MAX_OVERLAY of them). `guides` false hides the faint tile outlines
   * (Map zoom). Returns the first sixteen assigned colours, for diagnostics.
   */
  update(all: Snapshot['tiles'], overlay: FarmOverlay, guideLines = true, dist: DropDistances | null = null): { x: number; y: number; color: string }[] {
    const tiles = all.length > MAX_OVERLAY ? all.slice(0, MAX_OVERLAY) : all;
    if (tiles.length > this.capacity) {
      this.drop();
      this.capacity = Math.max(64, Math.min(MAX_OVERLAY, tiles.length * 2));
      this.guides = new THREE.InstancedMesh(
        new THREE.RingGeometry(0.475 * Math.SQRT2, 0.495 * Math.SQRT2, 4).rotateZ(Math.PI / 4).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0xece2d0, transparent: true, opacity: 0.55, depthWrite: false }), this.capacity);
      this.scene.add(this.guides);
      this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.95, 0.012, 0.95), matte(0xffffff), this.capacity);
      this.mesh.receiveShadow = true;
      this.scene.add(this.mesh);
    }
    const mesh = this.mesh, guides = this.guides;
    if (!mesh || !guides) return [];
    guides.visible = guideLines && overlay === 'grid';
    guides.count = tiles.length;
    tiles.forEach((tile, index) => guides.setMatrixAt(index, this.flat(tile.x, TOP + 0.004, tile.y)));
    guides.instanceMatrix.needsUpdate = true;
    guides.computeBoundingSphere();
    mesh.visible = overlay !== 'none' && overlay !== 'grid';
    const colors: { x: number; y: number; color: string }[] = [];
    if (overlay !== 'none' && overlay !== 'grid') {
      tiles.forEach((tile, index) => {
        mesh.setMatrixAt(index, this.flat(tile.x, TOP, tile.y));
        overlayColor(overlay, tile, this.color, dropUnit(dist, tile.x, tile.y));
        mesh.setColorAt(index, this.color);
        if (index < 16) colors.push({ x: tile.x, y: tile.y, color: this.color.getHexString() });
      });
      mesh.count = tiles.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
    return colors;
  }

  dispose(): void { this.drop(); }
}
