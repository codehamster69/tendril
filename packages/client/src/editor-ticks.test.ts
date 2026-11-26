import test from 'node:test';
import assert from 'node:assert/strict';
import { COST, OP } from '@tendril/sim/src/index.ts';
import { attributeTicks, hotLines, lineActions, RunTicks, totalsOf } from './editor-ticks.ts';
import { oneEditApart, suggestFix, userNames } from './editor-fix.ts';
import { inlineValues } from './editor-inline.ts';
import { normalizePrefs } from './editor-prefs.ts';

const SRC = 'repeat forever:\n    till\n    plant carrot\n    wait 5\n    move east # till later\n';

test('lineActions finds actions, ignores strings, comments and definitions', () => {
  const a = lineActions('say "till"\ndefine move(x):\n    pass\nwait 12\nmove east # till\n');
  assert.equal(a.has(1), false);
  assert.equal(a.has(2), false);
  assert.deepEqual(a.get(4), [{ op: OP.wait, waitTicks: 12 }]);
  assert.deepEqual(a.get(5), [{ op: OP.move }]);
});

test('an action only one line can produce lands on that line exactly', () => {
  const log = [[0, 0, OP.till], [2, 0, OP.till], [4, 0, OP.plant], [6, 0, OP.wait, 5]];
  const t = attributeTicks(SRC, totalsOf(log), []);
  assert.equal(t.get(2), 2 * COST[OP.till]!);
  assert.equal(t.get(3), COST[OP.plant]);
  assert.equal(t.get(4), 5); // wait costs its own length
  assert.equal(t.has(5), false);
});

test('an action shared by lines is split by how often each line ran', () => {
  const src = 'move east\nmove west\n';
  const log = [[0, 0, OP.move], [1, 0, OP.move], [2, 0, OP.move], [3, 0, OP.move]]; 
  const c = COST[OP.move]!;
  const t = attributeTicks(src, totalsOf(log), [[1, 3], [2, 1]]);
  assert.equal(t.get(1), Math.round(c * 3));
  assert.equal(t.get(2), Math.round(c));
});

test('hotLines picks the costliest tenth, at least one, and nothing when all are equal', () => {
  const m = new Map<number, number>();
  for (let i = 1; i <= 20; i++) m.set(i, i);
  assert.deepEqual([...hotLines(m)].sort((a, b) => a - b), [19, 20]);
  assert.deepEqual([...hotLines(new Map([[1, 5], [2, 9], [3, 1]]))], [2]);
  assert.equal(hotLines(new Map([[1, 4], [2, 4]])).size, 0);
  assert.equal(hotLines(new Map()).size, 0);
});

test('RunTicks skips the log an earlier run left behind', () => {
  const rt = new RunTicks();
  const src = 'till\n';
  const first = [[0, 0, OP.till], [2, 0, OP.till]];
  const c = COST[OP.till]!;
  assert.equal(rt.feed(src, first, [[1, 10]]).get(1), 2 * c);
  const log = [...first, [4, 0, OP.till]];
  assert.equal(rt.feed(src, log, [[1, 2]]).get(1), c); // heat dropped: a new run began after the first two
  assert.equal(rt.feed(src, [], []).size, 0); // farm reset
});

test('oneEditApart covers insert, delete, change and swap', () => {
  assert.ok(oneEditApart('carot', 'carrot'));
  assert.ok(oneEditApart('carrrot', 'carrot'));
  assert.ok(oneEditApart('wheet', 'wheat'));
  assert.ok(oneEditApart('harvset', 'harvest'));
  assert.ok(!oneEditApart('cat', 'carrot'));
  assert.ok(!oneEditApart('till', 'till'));
});

test('suggestFix gives one obvious fix and refuses ambiguous or unrelated names', () => {
  const msg = "I don't know what `carot` means. Did you mean `carrot`?";
  const fix = suggestFix(msg, '    plant carot', ['plant', 'carrot', 'wheat']);
  assert.deepEqual(fix, { from: 10, to: 15, replacement: 'carrot', label: 'Change to carrot' });
  assert.equal(suggestFix("I don't know what `mov` means.", 'mov east', ['move', 'mow']), null); // two candidates
  assert.equal(suggestFix("I don't know what `banana` means.", 'banana', ['carrot']), null);
  assert.equal(suggestFix('Move north, east, south or west.', 'move up', ['north']), null);
  assert.equal(suggestFix(msg, '    plant carrots', ['carrot']), null); // the name is not on the line as a whole word
});

test('userNames sees functions, parameters, loop and assigned variables', () => {
  const names = userNames('define fetch(a, b):\n    n = 1\n    n += 2\nfor each tile in tiles():\n    pass\nset total to 3\nfor i from 0 to 3:\n    pass\n');
  for (const n of ['fetch', 'a', 'b', 'n', 'tile', 'total', 'i']) assert.ok(names.includes(n), n);
});

test('inlineValues shows values on lines that mention a variable', () => {
  const m = inlineValues('x = 3\nsay x + y # z\nmove east\n', [{ name: 'x', value: '3' }, { name: 'y', value: '[1, 2]' }, { name: 'z', value: '0' }]);
  assert.equal(m.get(1), 'x = 3');
  assert.equal(m.get(2), 'x = 3, y = [1, 2]'); // z is only in a comment
  assert.equal(m.has(3), false);
  assert.equal(inlineValues('x\n', []).size, 0);
});

test('normalizePrefs repairs anything stored', () => {
  assert.deepEqual(normalizePrefs({ theme: 'neon', tabWidth: 3, tickColumn: 'yes' }), { theme: 'bark', tabWidth: 4, tickColumn: true });
  assert.deepEqual(normalizePrefs({ theme: 'field', tabWidth: 2, tickColumn: false }), { theme: 'field', tabWidth: 2, tickColumn: false });
  assert.deepEqual(normalizePrefs(null), { theme: 'bark', tabWidth: 4, tickColumn: true });
});
