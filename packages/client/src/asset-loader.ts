import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface AssetPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
}
export interface AssetModel { parts: AssetPart[] }
export interface AssetStatus {
  state: 'loading' | 'ready' | 'fallback' | 'partial' | 'error';
  loaded: number;
  missing: number;
  errors: string[];
}

// The manifest and its files share the same base, including Electron's relative base.
const MODEL_BASE = new URL(`${import.meta.env.BASE_URL}models/`, document.baseURI);

export function disposeModels(models: Iterable<AssetModel>): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  for (const model of models) for (const part of model.parts) {
    geometries.add(part.geometry);
    for (const material of Array.isArray(part.material) ? part.material : [part.material]) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    }
  }
  geometries.forEach((geometry) => geometry.dispose());
  textures.forEach((texture) => {
    // GLTFLoader can use ImageBitmap, whose CPU storage also needs releasing.
    if (typeof ImageBitmap !== 'undefined' && texture.image instanceof ImageBitmap) texture.image.close();
    texture.dispose();
  });
  materials.forEach((material) => material.dispose());
}

function sceneParts(gltf: GLTF): AssetModel {
  const originals: AssetPart[] = [];
  for (const scene of gltf.scenes) scene.traverse((object) => {
    if (object instanceof THREE.Mesh) originals.push({ geometry: object.geometry, material: object.material });
  });
  const parts: AssetPart[] = [];
  try {
    gltf.scene.updateMatrixWorld(true);
    const compatible = new Map<string, { geometries: THREE.BufferGeometry[]; materials: THREE.Material[] }>();
    gltf.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      if (object instanceof THREE.SkinnedMesh || Object.keys(object.geometry.morphAttributes).length) {
        throw new Error('Animated meshes are not supported by the farm asset contract');
      }
      const geometry: THREE.BufferGeometry = object.geometry.clone().applyMatrix4(object.matrixWorld);
      parts.push({ geometry, material: object.material });
      // Combine compatible primitives, retaining each original material group/palette.
      const signature = JSON.stringify({
        indexed: !!geometry.index,
        attributes: Object.entries(geometry.attributes).sort(([a], [b]) => a.localeCompare(b)).map(([name, a]) =>
          [name, a.itemSize, a.normalized, a.array.constructor.name]),
      });
      let bucket = compatible.get(signature);
      if (!bucket) { bucket = { geometries: [], materials: [] }; compatible.set(signature, bucket); }
      const source = Array.isArray(object.material) ? object.material : [object.material];
      const indices = source.map((material) => {
        let index = bucket!.materials.indexOf(material);
        if (index < 0) { index = bucket!.materials.length; bucket!.materials.push(material); }
        return index;
      });
      if (!geometry.groups.length) geometry.addGroup(0, geometry.index?.count ?? geometry.getAttribute('position').count, 0);
      for (const group of geometry.groups) group.materialIndex = indices[group.materialIndex ?? 0];
      bucket.geometries.push(geometry);
    });
    if (!parts.length) throw new Error('Model contains no renderable meshes');
    const combined: AssetPart[] = [];
    for (const bucket of compatible.values()) {
      const geometry = bucket.geometries.length === 1 ? bucket.geometries[0] : mergeGeometries(bucket.geometries);
      if (!geometry) throw new Error('Model geometry could not be combined');
      // Keep merged geometry in the cleanup set if a subsequent bucket fails.
      parts.push({ geometry, material: bucket.materials });
      if (bucket.geometries.length > 1) {
        let offset = 0;
        for (const source of bucket.geometries) {
          for (const group of source.groups) geometry.addGroup(offset + group.start, group.count, group.materialIndex);
          offset += source.index?.count ?? source.getAttribute('position').count;
          source.dispose();
        }
      }
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      combined.push({ geometry, material: bucket.materials.length === 1 ? bucket.materials[0] : bucket.materials });
    }
    // Source geometry is no longer needed; materials/textures belong to the returned model.
    new Set(originals.map((part) => part.geometry)).forEach((geometry) => geometry.dispose());
    return { parts: combined };
  } catch (error) {
    disposeModels([{ parts: [...originals, ...parts] }]);
    throw error;
  }
}

function manifestEntries(value: unknown): [string, string][] {
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 ||
      !('assets' in value) || !value.assets || typeof value.assets !== 'object' || Array.isArray(value.assets)) {
    throw new Error('Expected a version 1 asset manifest');
  }
  return Object.entries(value.assets).map(([name, entry]) => {
    if (!/^[a-z][a-z0-9_]*$/.test(name) || !entry || typeof entry !== 'object' ||
        !('file' in entry) || typeof entry.file !== 'string' || !/^[a-zA-Z0-9_-]+\.glb$/.test(entry.file)) {
      throw new Error(`Invalid asset entry: ${name.slice(0, 60)}`);
    }
    return [name, entry.file];
  });
}

export class AssetLoader {
  readonly models = new Map<string, AssetModel>();
  readonly status: AssetStatus = { state: 'loading', loaded: 0, missing: 0, errors: [] };
  private controller = new AbortController();
  private disposed = false;
  private started = false;
  private gltf = new GLTFLoader();

  constructor(private changed: (status: AssetStatus) => void) {}

  private notify(): void { if (!this.disposed) this.changed({ ...this.status, errors: [...this.status.errors] }); }
  private problem(message: string): void {
    if (this.status.errors.length < 4) this.status.errors.push(message);
  }

  async load(): Promise<void> {
    if (this.disposed || this.started) return;
    this.started = true;
    this.notify();
    let entries: [string, string][];
    try {
      const response = await fetch(new URL('manifest.json', MODEL_BASE), { signal: this.controller.signal });
      if ([404, 410, 204].includes(response.status)) {
        this.status.state = 'fallback'; this.notify(); return;
      }
      if (!response.ok) throw new Error(`Manifest request failed (${response.status})`);
      const text = await response.text();
      // Vite's SPA fallback returns index.html when assets have not been copied yet.
      if (/^\s*(?:<!doctype html|<html[\s>])/i.test(text)) {
        this.status.state = 'fallback'; this.notify(); return;
      }
      try { entries = manifestEntries(JSON.parse(text)); }
      catch { throw new Error('Asset manifest is invalid; check JSON and version 1 asset entries'); }
    } catch (error) {
      if (this.disposed) return;
      this.problem(error instanceof Error ? error.message : 'Unable to read asset manifest');
      this.status.state = 'error'; this.notify(); return;
    }
    let cursor = 0;
    const next = async (): Promise<void> => {
      while (!this.disposed && cursor < entries.length) {
        const [name, file] = entries[cursor++];
        try {
          const response = await fetch(new URL(file, MODEL_BASE), { signal: this.controller.signal });
          if ([404, 410, 204].includes(response.status)) { this.status.missing++; continue; }
          if (!response.ok) throw new Error(`request failed (${response.status})`);
          if (response.headers.get('content-type')?.includes('text/html')) { this.status.missing++; continue; }
          const buffer = await response.arrayBuffer();
          if (this.disposed) return;
          const parsed = await this.gltf.parseAsync(buffer, MODEL_BASE.href);
          const model = sceneParts(parsed); // glTF is already Y-up; do not rotate or recenter it.
          if (this.disposed) { disposeModels([model]); return; }
          this.models.set(name, model);
          this.status.loaded = this.models.size;
          this.notify();
        } catch (error) {
          if (this.disposed) return;
          this.problem(`${name}: ${error instanceof Error ? error.message : 'Unable to parse model'}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, entries.length) }, next));
    if (this.disposed) return;
    this.status.state = this.status.errors.length ? (this.models.size ? 'partial' : 'error')
      : this.status.missing ? (this.models.size ? 'partial' : 'fallback')
      : entries.length ? 'ready' : 'fallback';
    this.notify();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort();
    disposeModels(this.models.values());
    this.models.clear();
  }
}
