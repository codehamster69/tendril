import { describe, expect, it } from 'vitest';
import { createRun } from '../src/index.ts';
import { createWorld, snapshot } from '@tendril/sim/src/index.ts';
import { LESSONS } from '../../client/src/lessons.ts';

describe('Shorter trips lesson', () => {
  it('its solution builds a silo and deposits at the drop', () => {
    const lesson = LESSONS.find((l) => l.title === 'Shorter trips')!;
    const world = createWorld({ id: 'lesson', seed: lesson.seed }, lesson.setup);
    const run = createRun(world, lesson.solution);
    run.step(lesson.tickLimit);
    expect(run.errors).toEqual([]);
    expect(lesson.check(snapshot(world), run.pending)).toBe(true);
  });
});
