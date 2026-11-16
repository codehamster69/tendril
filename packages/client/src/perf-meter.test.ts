import assert from 'node:assert/strict';
import test from 'node:test';
import { frameStats } from './perf-meter.ts';

test('frameStats reports fps, average and worst frame time over the last 2 seconds', () => {
  const times = [0, 16, 32, 48, 98, 114]; // one 50 ms hitch
  const s = frameStats(times, 114);
  assert.equal(Math.round(s.avg * 10) / 10, 22.8);
  assert.equal(s.worst, 50);
  assert.equal(Math.round(s.fps), 44);
});

test('frameStats ignores frames older than 2 seconds and handles too few frames', () => {
  assert.deepEqual(frameStats([], 5000), { fps: 0, avg: 0, worst: 0 });
  assert.deepEqual(frameStats([100], 100), { fps: 0, avg: 0, worst: 0 });
  assert.equal(frameStats([0, 500, 3000, 3016, 3032], 3032).worst, 16);
});
