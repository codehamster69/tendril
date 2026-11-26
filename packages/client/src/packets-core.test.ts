import test from 'node:test';
import assert from 'node:assert/strict';
import { isBlank, parsePacketId, plantRefusal, recallParent, rememberParent, shareRefusal } from './packets-core.ts';

const store = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; };

  test('plants only in Endless and sandbox, with a plain reason elsewhere', () => {
    assert.equal(plantRefusal('live'), null);
    assert.equal(plantRefusal('sandbox'), null);
    assert.match(plantRefusal('daily') ?? '', /daily or season is open/);
    assert.match(plantRefusal('campaign') ?? '', /Campaign/);
  });
  test('shares only from Endless and sandbox', () => {
    assert.equal(shareRefusal('live'), null);
    assert.match(shareRefusal('daily') ?? '', /once that daily has closed/);
  });
  test('remembers the packet it was planted from', () => {
    const s = store();
    assert.equal(recallParent(s), null);
    rememberParent({ id: 'abcDEF12_-x', name: 'Carrot snake' }, s);
    assert.deepEqual(recallParent(s), { id: 'abcDEF12_-x', name: 'Carrot snake' });
    s.setItem('tendril.packetParent', '{"id":"<script>"}');
    assert.equal(recallParent(s), null);
    rememberParent(null, s);
    assert.equal(recallParent(s), null);
  });
  test('reads ids and links', () => {
    assert.equal(parsePacketId('abcDEF12_-x'), 'abcDEF12_-x');
    assert.equal(parsePacketId('https://tendril.hokora.xyz/packets/abcDEF12_-x'), 'abcDEF12_-x');
    assert.equal(parsePacketId(''), null);
    assert.equal(parsePacketId('no'), null);
  });
  test('knows a blank editor', () => { assert.equal(isBlank(' \n '), true); assert.equal(isBlank('go_to barn'), false); });
