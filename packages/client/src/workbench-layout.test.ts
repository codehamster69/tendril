import test from 'node:test';
import assert from 'node:assert/strict';
import { PANEL_IDS, PRESETS, clampSplit, decodeLayout, encodeLayout, firstPanel, isPhone, leaves, sizesOf, stepsOf, type PresetId } from './workbench-layout.ts';

{ // presets
  for (const id of Object.keys(PRESETS) as PresetId[]) {
    test(`${id} places every panel once and keeps farm and code`, () => {
      const tree = PRESETS[id].tree();
      const ids = leaves(tree);
      assert.equal(new Set(ids).size, ids.length);
      assert.ok(ids.includes('farm'));
      assert.ok(ids.includes('code'));
      const steps = stepsOf(tree);
      assert.deepEqual(steps.map((s) => s.id).sort(), [...ids].sort());
      assert.equal(steps[0]!.ref, null);
      // A step may only point at a panel that an earlier step placed.
      const placed = new Set<string>();
      for (const s of steps) { if (s.ref) assert.equal(placed.has(s.ref), true); placed.add(s.id); }
    });
  }
  test('farm first puts the farm in the left column over the console', () => {
    const steps = stepsOf(PRESETS.farm.tree());
    assert.deepEqual(steps[0], { id: 'farm', ref: null, dir: 'right' });
    assert.deepEqual(steps.find((s) => s.id === 'code'), { id: 'code', ref: 'farm', dir: 'right' }); // the right column's head splits the whole row
    assert.deepEqual(steps.find((s) => s.id === 'console'), { id: 'console', ref: 'farm', dir: 'below' });
    assert.deepEqual(steps.find((s) => s.id === 'settings'), { id: 'settings', ref: 'code', dir: 'within' });
  });
  test('sizes follow the weights', () => {
    const sizes = sizesOf(PRESETS.code.tree(), 1000, 600);
    assert.deepEqual(sizes[0], { id: 'code', width: 600 });
    assert.deepEqual(sizes[1], { id: 'farm', width: 400 });
    assert.equal(firstPanel(PRESETS.wide.tree()), 'reference');
  });
}

{ // saved layout
  const ok = encodeLayout({ grid: {} }, ['farm', 'code', 'console']);
  test('round-trips', () => {
    assert.deepEqual(decodeLayout(ok), { v: 1, layout: { grid: {} }, panels: ['farm', 'code', 'console'] });
  });
  test('falls back to null on bad data', () => {
    assert.equal(decodeLayout(null), null);
    assert.equal(decodeLayout('{nope'), null);
    assert.equal(decodeLayout('[]'), null);
    assert.equal(decodeLayout(JSON.stringify({ v: 2, layout: {}, panels: ['farm', 'code'] })), null);
    assert.equal(decodeLayout(JSON.stringify({ v: 1, layout: {}, panels: ['farm', 'code', 'ghost'] })), null);
    assert.equal(decodeLayout(JSON.stringify({ v: 1, layout: {}, panels: ['farm', 'code', 'code'] })), null);
    assert.equal(decodeLayout(JSON.stringify({ v: 1, layout: {}, panels: ['farm', 'console'] })), null); // no code panel
    assert.equal(decodeLayout(JSON.stringify({ v: 1, layout: null, panels: ['farm', 'code'] })), null);
  });
  test('knows every panel the menu can reopen', () => {
    assert.equal(PANEL_IDS.length, 11);
  });
}

{ // phone
  test('switches below 760px', () => {
    assert.equal(isPhone(390), true);
    assert.equal(isPhone(759), true);
    assert.equal(isPhone(760), false);
  });
  test('keeps the divider in a usable range', () => {
    assert.equal(clampSplit(0.05), 0.2);
    assert.equal(clampSplit(0.95), 0.7);
    assert.equal(clampSplit(Number.NaN), 0.4);
    assert.equal(clampSplit(0.5), 0.5);
  });
}
