import * as THREE from 'three';
import type { AssetModel } from './asset-loader';
import { ITEM_NAMES } from './fallback-models';
import type { SnapshotBot } from '@tendril/sim';

interface Kind { model: AssetModel; meshes: THREE.InstancedMesh[]; capacity: number; count: number }

/**
 * One small marker per kind of item a drone carries, stacked above it. Instanced per item kind, so cost follows the
 * number of drones (a handful), never the size of the farm.
 */
export class FarmCarried {
  private kinds = new Map<string, Kind>();
  private dummy = new THREE.Object3D();

  constructor(private scene: THREE.Scene, private models: (name: string) => AssetModel) {}

  /** Place the markers. `hover` is the hull height of a drone. Returns the live instance count per `carry:item_x`. */
  update(bots: readonly SnapshotBot[], position: (id: number) => { x: number; z: number } | null, hover: number): Record<string, number> {
    const need = new Map<string, number>();
    const list: { name: string; x: number; z: number; level: number; item: number }[] = [];
    bots.forEach((bot, id) => {
      const p = position(id);
      if (!p) return;
      let level = 0;
      bot.items.forEach((n, item) => {
        const base = item > 0 && n > 0 ? ITEM_NAMES[item] : undefined;
        if (!base) return;
        const name = `item_${base}`;
        need.set(name, (need.get(name) ?? 0) + 1);
        list.push({ name, x: p.x, z: p.z, level: level++, item });
      });
    });
    for (const [name, kind] of this.kinds) if (!need.has(name)) { kind.count = 0; this.flush(kind); }
    for (const [name, n] of need) {
      const kind = this.kind(name, n);
      kind.count = 0;
      for (const m of list) {
        if (m.name !== name || kind.count >= kind.capacity) continue;
        this.dummy.position.set(m.x, hover + 0.05 + m.level * 0.17, m.z);
        this.dummy.rotation.set(0, m.item, 0);
        this.dummy.updateMatrix();
        for (const mesh of kind.meshes) mesh.setMatrixAt(kind.count, this.dummy.matrix);
        kind.count++;
      }
      this.flush(kind);
    }
    const out: Record<string, number> = {};
    for (const [name, kind] of this.kinds) if (kind.count > 0) out[`carry:${name}`] = kind.count;
    return out;
  }

  private flush(kind: Kind): void {
    for (const mesh of kind.meshes) {
      mesh.count = kind.count;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  private kind(name: string, need: number): Kind {
    const model = this.models(name);
    let kind = this.kinds.get(name);
    if (kind && (kind.model !== model || kind.capacity < need)) { this.drop(kind); this.kinds.delete(name); kind = undefined; }
    if (!kind) {
      const capacity = Math.max(8, 2 ** Math.ceil(Math.log2(Math.max(1, need))));
      const meshes = model.parts.map((part) => {
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, capacity);
        mesh.name = name;
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.castShadow = true;
        this.scene.add(mesh);
        return mesh;
      });
      kind = { model, meshes, capacity, count: 0 };
      this.kinds.set(name, kind);
    }
    return kind;
  }

  private drop(kind: Kind): void {
    for (const mesh of kind.meshes) { this.scene.remove(mesh); mesh.dispose(); }
  }

  dispose(): void {
    for (const kind of this.kinds.values()) this.drop(kind);
    this.kinds.clear();
  }
}
