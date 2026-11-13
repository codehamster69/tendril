import { COST, OP } from '@tendril/sim/src/index.ts';

export interface ApiEntry {
  name: string; kind: 'action' | 'farm' | 'query' | 'utility' | 'constant' | 'keyword';
  signature: string; doc: string; ticks: number | 'n'; example: string; feature: string;
}
export const KEYWORDS = 'if elif else while repeat forever times for each in from to step define def return break continue pass stop and or not is true false none set global'.split(' ');
export const CONSTANTS = 'north east south west carrot wheat clover pumpkin berry apple honey compost hive composter satchel barn all shared'.split(' ');
/** Actions and statement helpers are written as commands (`move east`), so the reference shows that form first. */
const command = (name: string, args: string): string => (args === '' ? name : `${name} ${args}`);
const COMMAND_UTILITIES = ['go_to', 'say', 'print', 'append', 'insert', 'remove'];
const actions: [string, keyof typeof OP, string, string, string][] = [
  ['move', 'move', 'direction', 'Move one tile on owned land; returns true on success.', 'move east'],
  ['till', 'till', '', 'Prepare an empty tile for planting. The barn and buildings cannot be tilled.', 'till'],
  ['plant', 'plant', 'crop', 'Plant a researched crop on empty, tilled soil.', 'plant carrot'],
  ['water', 'water', '', 'Add 30 moisture, up to 100.', 'water'],
  ['harvest', 'harvest', '', 'Harvest produce or ready hive honey; returns the units carried.', 'harvest'],
  ['deposit', 'deposit', '', 'Move carried produce into barn stock. Compost stays carried.', 'deposit'],
  ['wait', 'wait', 'ticks', 'Wait at least one tick. Long waits split into 1,000-tick actions.', 'wait 100'],
  ['sell', 'sell', 'item, units', 'Sell barn stock at today\u2019s price (the base price outside market days); use all for the whole stock of an item.', 'sell carrot, all'],
  ['deliver', 'deliver', 'order', 'At the barn, fulfil a contract using stock; returns its coin reward.', 'deliver orders()[0]'],
  ['build', 'build', 'kind', 'Build a researched hive or composter on empty grass, paying its coin price.', 'build hive'],
  ['clear', 'clear', '', 'Remove a crop, tilled soil or building. No refund or produce is returned.', 'clear'],
  ['compost', 'compost', '', 'At a composter, convert four carried crop units into one compost.', 'compost'],
  ['fertilize', 'fertilize', '', 'Use one carried compost: add 25 nitrogen and remove 20 fatigue.', 'fertilize'],
  ['buy_plot', 'buyPlot', 'px, py', 'Buy an edge-adjacent 8×8 plot; returns true on success.', 'buy_plot 1, 0'],
  ['buy_bot', 'buyBot', '', 'Buy a new bot at the barn. Returns its zero-based id, or none.', 'buy_bot'],
  ['unlock', 'unlock', 'name', 'Pay the research price for a crop, building or satchel.', 'unlock wheat'],
];
export const API: ApiEntry[] = actions.map(([name, op, args, doc, example]) => ({
  name, kind: ['buy_plot', 'buy_bot', 'unlock'].includes(name) ? 'farm' : 'action',
  signature: command(name, args), doc, example, ticks: name === 'wait' ? 'n' : COST[OP[op]]!,
  feature: ['build', 'clear', 'compost', 'fertilize'].includes(name) ? 'buildings' : ['sell'].includes(name) ? 'market' : name === 'deliver' ? 'orders' : ['buy_plot', 'unlock'].includes(name) ? 'farm' : name === 'buy_bot' ? 'crew' : 'commands',
}));
const queries: [string, string, string, string][] = [
  ['scan', '', 'Inspect the tile below this bot; includes ripe, empty, crop, soil and building.', 'queries'],
  ['scan_at', 'x, y', 'Inspect an owned tile, or return none for unowned land.', 'queries'],
  ['position', '', 'Return this bot’s {x, y} position.', 'queries'], ['my_id', '', 'This bot’s zero-based id.', 'crew'],
  ['load', '', 'Return carried units by item name.', 'queries'], ['carried', '', 'Total carried units.', 'queries'],
  ['capacity', '', 'The carrying capacity: 20, or 30 with a satchel.', 'queries'], ['tick', '', 'Current farm tick.', 'queries'],
  ['owns', 'x, y', 'Whether the tile belongs to your farm.', 'queries'], ['plots', '', 'Owned plots in purchase order.', 'queries'],
  ['tiles', '', 'Owned tile positions, in plot order then row order.', 'for'],
  ['forecast', 'ticks', 'Rain and frost segments overlapping the next ticks.', 'weather'], ['weather', '', 'clear, rain or frost.', 'weather'],
  ['orders', '', 'Open contracts with crop, quantity, reward and deadline.', 'orders'], ['stock', '', 'Barn units by item name.', 'market'],
  ['coins', '', 'Current coin balance.', 'market'], ['plot_cost', '', 'Price of the next plot.', 'farm'],
  ['bot_cost', '', 'Price of the next bot.', 'crew'], ['bots', '', 'Number of bots on your farm.', 'crew'],
  ['unlocked', 'name', 'Whether the named research is unlocked.', 'farm'], ['unlock_cost', 'name', 'Price of named research.', 'farm'],
  ['price', 'item', 'Selling price of an item. On a market day it is today\u2019s price in hundredths of a coin (200 means 2 coins); otherwise the base price in whole coins.', 'market'],
];
for (const [name, args, doc, feature] of queries) API.push({ name, kind: 'query', signature: `${name}(${args})`, doc, ticks: 0, example: name === 'scan_at' ? 'say scan_at(1, 1)' : name === 'forecast' ? 'say forecast(500)' : ['unlocked', 'unlock_cost', 'price'].includes(name) ? `say ${name}(carrot)` : name === 'owns' ? 'say owns(1, 1)' : `say ${name}()`, feature });
const utilities: [string, string, string, string][] = [
  ['go_to', 'position / x, y', 'Walk east/west first, then north/south. Every move takes two ticks.', 'go_to barn'],
  ['say', 'values…', 'Print values to the console, tagged with this bot and tick.', 'say "Hello from bot", my_id()'],
  ['print', 'values…', 'Print values, like say.', 'print "hello"'],
  ['len', 'value', 'Length of a list, record or string.', 'say len(tiles())'],
  ['abs', 'n', 'Absolute value.', 'say abs(-3)'], ['min', 'values…', 'Smallest value; accepts a list.', 'say min(2, 5)'], ['max', 'values…', 'Largest value; accepts a list.', 'say max(2, 5)'],
  ['range', 'end / start, end', 'A list of integers, excluding end.', 'for each n in range(4):\n    say n'],
  ['append', 'list, value', 'Add a value to the list’s end.', 'xs = []\nappend xs, 1'], ['pop', 'list', 'Remove and return the last item.', 'xs = [1, 2]\nsay pop(xs)'],
  ['insert', 'list, index, value', 'Insert a value at an index.', 'xs = [1]\ninsert xs, 0, 2'], ['remove', 'list, index', 'Remove the item at an index.', 'xs = [1, 2]\nremove xs, 0'],
  ['contains', 'collection, value', 'Test membership.', 'say contains([1, 2], 2)'], ['keys', 'record', 'Return record keys.', 'say keys({x: 1})'],
  ['sorted', 'list', 'Return a sorted copy of integers or strings.', 'say sorted([3, 1])'], ['reversed', 'list', 'Return a reversed copy.', 'say reversed([1, 2])'],
  ['str', 'value', 'Convert a value to readable text.', 'say str(42)'], ['int', 'value', 'Convert a decimal string to an integer, or none.', 'say int("42")'],
  ['random', 'upper', 'Seeded random integer from zero to upper minus one.', 'say random(4)'], ['distance', 'a, b', 'Manhattan distance between tile positions.', 'say distance(position(), barn)'],
];
for (const [name, args, doc, example] of utilities) API.push({ name, kind: 'utility', signature: COMMAND_UTILITIES.includes(name) ? command(name, args) : `${name}(${args})`, doc, ticks: name === 'go_to' ? 'n' : 0, example, feature: name === 'go_to' || name === 'say' || name === 'print' ? 'commands' : 'utilities' });
for (const name of CONSTANTS.filter((n) => n !== 'compost')) API.push({ name, kind: 'constant', signature: name, doc: name === 'shared' ? 'One record visible to every bot. Not stored in the farm checkpoint.' : name === 'barn' ? 'The position {x: 0, y: 0}.' : `The name ${name}.`, ticks: 0, example: name === 'shared' ? 'shared.ready = true' : `say ${name}`, feature: name === 'shared' ? 'crew' : 'commands' });
export function monarchTokens(): object {
  return { keywords: KEYWORDS, constants: CONSTANTS, builtins: API.filter((a) => a.kind !== 'constant').map((a) => a.name), tokenizer: { root: [
    [/#.*$/, 'comment'], [/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/, 'string'], [/\d[\d_]*/, 'number'],
    [/[a-zA-Z_]\w*/, { cases: { '@keywords': 'keyword', '@constants': 'constant', '@builtins': 'predefined', '@default': 'identifier' } }],
    [/[()[\]{}]/, '@brackets'], [/[+\-*/%<>=!]+/, 'operator'], [/[,:.]/, 'delimiter'],
  ] } };
}
