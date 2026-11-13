import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, migrate } from '../src/index.ts';
import type { Db } from '../src/index.ts';
import { DAY_MS } from '../src/game.ts';
import {
  LEGACY_GRACE_MS, LEGACY_QUIET_MS, LEGACY_SUNSET_AT_LATEST, LEGACY_SUNSET_NOT_BEFORE,
  legacyGraceMs, legacySunsetDue, noteLegacySubmit, refreshLegacyGrace, resetLegacyGrace,
} from '../src/arena.ts';

let db: Db;
beforeEach(async () => { resetLegacyGrace(); db = createDb({ url: ':memory:' }); await migrate(db); });
afterEach(() => db.close());

describe('legacy grace sunset', () => {
  it('rule: needs the not-before date and 30 quiet days, or the hard date', () => {
    expect(legacySunsetDue(LEGACY_SUNSET_NOT_BEFORE - 1, 0)).toBe(false);
    expect(legacySunsetDue(LEGACY_SUNSET_NOT_BEFORE, LEGACY_SUNSET_NOT_BEFORE - LEGACY_QUIET_MS)).toBe(true);
    expect(legacySunsetDue(LEGACY_SUNSET_NOT_BEFORE, LEGACY_SUNSET_NOT_BEFORE - LEGACY_QUIET_MS + 1)).toBe(false);
    expect(legacySunsetDue(LEGACY_SUNSET_AT_LATEST, LEGACY_SUNSET_AT_LATEST)).toBe(true);
  });

  it('keeps the grace while 0.1.x still submits, ends it after a quiet month, and never undoes it', async () => {
    const start = LEGACY_SUNSET_NOT_BEFORE - 10 * DAY_MS;
    expect((await refreshLegacyGrace(db, start)).ended).toBe(false); // telemetry starts here
    expect(legacyGraceMs()).toBe(LEGACY_GRACE_MS);
    await noteLegacySubmit(db, LEGACY_SUNSET_NOT_BEFORE + 5 * DAY_MS); // a straggler
    expect((await refreshLegacyGrace(db, LEGACY_SUNSET_NOT_BEFORE + 20 * DAY_MS)).ended).toBe(false);
    const done = await refreshLegacyGrace(db, LEGACY_SUNSET_NOT_BEFORE + 36 * DAY_MS);
    expect(done.ended).toBe(true);
    expect(legacyGraceMs()).toBe(0);
    await noteLegacySubmit(db, LEGACY_SUNSET_NOT_BEFORE + 40 * DAY_MS); // too late: ignored
    resetLegacyGrace(); // a new instance reads the stored decision
    expect((await refreshLegacyGrace(db, LEGACY_SUNSET_NOT_BEFORE + 41 * DAY_MS)).ended).toBe(true);
    expect(legacyGraceMs()).toBe(0);
  });

  it('writes the stamp at most once an hour per instance', async () => {
    const t = 10_000_000_000;
    await noteLegacySubmit(db, t);
    await noteLegacySubmit(db, t + 1_000);
    const [row] = await db.query<{ value: string }>("SELECT value FROM arena_meta WHERE key = 'legacy_submit_last'");
    expect(row?.value).toBe(String(10_000_000_000));
  });
});
