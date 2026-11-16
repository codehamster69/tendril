import test from 'node:test';
import assert from 'node:assert/strict';
import { botsAt, deadlineTrack, placeCard, tileInfo, ticksToRipe, type Tile } from './tile-info.ts';
import type { Snapshot } from '@tendril/sim/src/index.ts';

const tile = (o: Partial<Tile> = {}): Tile => ({ x: 2, y: 3, tilled: 1, crop: 2, stage: 1, moisture: 40, nitrogen: 55, fatigue: 7, building: 0, honey: 0, ...o });
const snap = (bots: Snapshot['bots'] = []): Snapshot => ({ tick: 100, coins: 0, netWorth: 0, weather: 'clear', unlocks: 0, capacity: 20, plots: [], tiles: [], bots, stock: [], orders: [], plotCost: 0, botCost: 0 });

test('ripe time is the stages left times the stage length', () => {
  assert.equal(ticksToRipe(2, 1), 180);
  assert.equal(ticksToRipe(2, 3), 0);
  assert.equal(ticksToRipe(0, 0), 0);
});
test('tile info names the crop, growth and soil, and the Sprout expressions', () => {
  const i = tileInfo(snap(), tile());
  assert.equal(i.title, 'Wheat');
  assert.deepEqual(i.rows.find((r) => r[0] === 'Ripe'), ['Ripe', 'in up to 180 ticks']);
  assert.deepEqual(i.rows.find((r) => r[0] === 'Water'), ['Water', '40']);
  assert.ok(i.exprs.includes('scan_at(2, 3).moisture'));
  assert.ok(i.exprs.includes('scan_at(2, 3).ripe'));
});
test('empty ground offers the empty expression and a ripe crop says now', () => {
  assert.ok(tileInfo(snap(), tile({ crop: 0, stage: 0, tilled: 0 })).exprs.includes('scan_at(2, 3).empty'));
  assert.equal(tileInfo(snap(), tile({ stage: 3 })).rows.find((r) => r[0] === 'Ripe')![1], 'now');
  assert.equal(tileInfo(snap(), tile({ x: 0, y: 0, crop: 0 })).title, 'Barn');
});
test('bots on or near the tile are listed with what they are doing', () => {
  const bots: Snapshot['bots'] = [{ x: 2, y: 3, busyUntil: 130, load: 0, items: [], op: 3 }, { x: 3, y: 3, busyUntil: 0, load: 0, items: [], op: null }, { x: 9, y: 9, busyUntil: 0, load: 0, items: [], op: null }];
  const found = botsAt(snap(bots), 2, 3);
  assert.deepEqual(found.map((b) => [b.id, b.here]), [[0, true], [1, false]]);
  assert.match(found[0]!.doing, /30t left/);
  assert.equal(found[1]!.doing, 'idle');
});
test('cards stay inside the viewport', () => {
  assert.deepEqual(placeCard(100, 100, 200, 100, 1000, 800), { x: 116, y: 116 });
  const p = placeCard(950, 780, 200, 100, 1000, 800);
  assert.ok(p.x + 200 <= 992 && p.y + 100 <= 792);
});
test('deadline sits on the day, or on the contract life without a day', () => {
  assert.deepEqual(deadlineTrack({ opensAt: 0, deadline: 500 }, 250, 1000), { now: 0.25, due: 0.5 });
  assert.deepEqual(deadlineTrack({ opensAt: 100, deadline: 300 }, 200, null), { now: 0.5, due: 1 });
});
