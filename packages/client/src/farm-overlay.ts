import * as THREE from 'three';
import type { Snapshot } from './sim-types';
import { matte } from './fallback-models';

export type FarmOverlay = 'none' | 'moisture' | 'nitrogen' | 'fatigue';
const OVERLAYS = {
  moisture: [new THREE.Color('#e0bb79'), new THREE.Color('#287caf')],
  nitrogen: [new THREE.Color('#e0c898'), new THREE.Color('#468653')],
  fatigue: [new THREE.Color('#8fc3a4'), new THREE.Color('#bf6650')],
};
export const unit = (value: number): number => THREE.MathUtils.clamp(value / 100, 0, 1);

/** The soil-lens colour layer and the faint tile guides, both one instanced mesh each. */
export class OverlayLayer {
  mesh: THREE.InstancedMesh | null = null;
  private guides: THREE.InstancedMesh | null = null;
  private capacity = 0;
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();

  constructor(private scene: THREE.Scene) {}

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
  }

  /** Returns the first sixteen assigned colours, for diagnostics. */
  update(tiles: Snapshot['tiles'], overlay: FarmOverlay): { x: number; y: number; color: string }[] {
    if (tiles.length > this.capacity) {
      this.drop();
      this.capacity = Math.max(64, tiles.length * 2);
      this.guides = new THREE.InstancedMesh(
        new THREE.RingGeometry(0.475 * Math.SQRT2, 0.495 * Math.SQRT2, 4).rotateZ(Math.PI / 4).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0x36462f, transparent: true, opacity: 0.16, depthWrite: false }), this.capacity);
      this.scene.add(this.guides);
      this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.95, 0.012, 0.95), matte(0xffffff), this.capacity);
      this.mesh.receiveShadow = true;
      this.scene.add(this.mesh);
    }
    const mesh = this.mesh, guides = this.guides;
    if (!mesh || !guides) return [];
    guides.count = tiles.length;
    tiles.forEach((tile, index) => guides.setMatrixAt(index, this.flat(tile.x, 0.003, tile.y)));
    guides.instanceMatrix.needsUpdate = true;
    guides.computeBoundingSphere();
    mesh.visible = overlay !== 'none';
    const colors: { x: number; y: number; color: string }[] = [];
    if (overlay !== 'none') {
      const [low, high] = OVERLAYS[overlay];
      tiles.forEach((tile, index) => {
        mesh.setMatrixAt(index, this.flat(tile.x, 0.01, tile.y));
        this.color.copy(low).lerp(high, unit(tile[overlay]));
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

  dispose(): void { this.mesh?.dispose(); this.guides?.dispose(); }
}
