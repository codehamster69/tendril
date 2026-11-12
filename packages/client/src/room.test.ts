import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoomClock, pickPlayers, rankOrder, ROOM_MAX } from './room-core.ts';

const row = (n: number, value = 100 - n) => ({ entryId: `e${n}`, login: `p${n}`, displayName: `P${n}`, value });
const duel = (hostN: number | null) => ({
  id: 'x-abcd1234', seed: 1, ticks: 3000,
  challenger: hostN == null ? null : { login: `p${hostN}`, displayName: `P${hostN}` },
  entry: hostN == null ? null : { entryId: `e${hostN}`, netWorth: 5 },
});

describe('rankOrder', () => {
  it('sorts by net worth, highest first, and seats the host first in a tie', () => {
    assert.deepEqual(rankOrder([10, 30, 20], 0), [1, 2, 0]);
    assert.deepEqual(rankOrder([5, 5, 5], 2), [2, 0, 1]);
    assert.deepEqual(rankOrder([], -1), []);
  });
});

describe('pickPlayers', () => {
  it('caps the room at 16', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(i));
    assert.equal(pickPlayers(duel(0), rows).length, ROOM_MAX);
  });
  it('keeps the host when sixteen others beat them', () => {
    const rows = Array.from({ length: 16 }, (_, i) => row(i));
    const players = pickPlayers(duel(99), rows);
    assert.equal(players.length, ROOM_MAX);
    assert.deepEqual(players.filter((p) => p.host).map((p) => p.entryId), ['e99']);
  });
  it('has no host seat when the duel has no posted score', () => {
    assert.equal(pickPlayers(duel(null), [row(1)]).some((p) => p.host), false);
  });
});

describe('RoomClock', () => {
  it('draws at most 30 times a second', () => {
    const c = new RoomClock(3000);
    let draws = 0;
    for (let t = 0; t < 1000; t += 1000 / 144) if (c.due(t)) draws++;
    assert.ok(draws <= 30);
    assert.ok(draws >= 28);
  });
  it('runs 10 ticks a second at 1x and stops at the end', () => {
    const c = new RoomClock(25);
    c.speed = 1;
    c.play(0);
    c.advance(1000);
    assert.equal(c.tick, 10);
    c.advance(10_000);
    assert.equal(c.tick, 25);
    assert.equal(c.playing, false);
  });
});
