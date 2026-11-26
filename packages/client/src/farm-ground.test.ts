import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { bladeClumpGeometry, clodGeometry, furrowHeight, meadowGeometry, soilBedGeometry, soilTint } from './farm-ground.ts';

describe('soil bed', () => {
  it('has two ridges per tile row and troughs on the tile edges, so neighbouring tiles meet at one height', () => {
    assert.ok(Math.abs(furrowHeight(-0.5) - furrowHeight(0.5)) < 1e-9);
    assert.ok(furrowHeight(0.25) > furrowHeight(0) + 0.04 && furrowHeight(-0.25) > furrowHeight(0) + 0.04);
    assert.ok(furrowHeight(0) < furrowHeight(0.25));
  });
  it('is one tile wide and never leaves its cell or rises above the crops', () => {
    const g = soilBedGeometry(); g.computeBoundingBox();
    const b = g.boundingBox!;
    assert.ok(b.min.x >= -0.5 && b.max.x <= 0.5 && b.min.z >= -0.5 && b.max.z <= 0.5);
    assert.ok(b.max.y > 0.05 && b.max.y < 0.1);
  });
  it('pales when dry and darkens when wet', () => {
    const dry = soilTint(0, new THREE.Color()), wet = soilTint(1, new THREE.Color());
    assert.ok(dry.r > 1 && wet.r < 1 && dry.r > wet.r);
    assert.deepEqual(soilTint(-3, new THREE.Color()).toArray(), dry.toArray());
  });
});

describe('meadow and grass', () => {
  it('meadow is a flat slab with its top at ground level', () => {
    const g = meadowGeometry(); g.computeBoundingBox();
    assert.ok(Math.abs(g.boundingBox!.max.y) < 1e-6);
  });
  it('blade and clod geometry is deterministic and small', () => {
    const a = bladeClumpGeometry(), b = bladeClumpGeometry();
    assert.deepEqual([...a.attributes.position.array], [...b.attributes.position.array]);
    assert.ok(a.attributes.position.count <= 8 * 9 + 1);
    a.computeBoundingBox();
    assert.ok(a.boundingBox!.max.y < 0.3);
    assert.ok(clodGeometry().attributes.position.count > 0);
  });
});
