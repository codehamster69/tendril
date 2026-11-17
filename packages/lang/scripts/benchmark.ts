// Throughput benchmark: `pnpm --filter @tendril/lang test:perf [bots] [plots] [ticks] [engine]`.
// Runs the client's stress-farm program on a fixed seed and reports ticks/s.
import { createWorld } from '@tendril/sim/src/index.ts';
import { createRun } from '../src/index.ts';

const [bots = '55', plots = '37', ticks = '4000', engine = 'compiled'] = process.argv.slice(2);
const B = Number(bots), P = Number(plots), T = Number(ticks), WIDTH = Math.ceil(Math.sqrt(P));
export const stressSource = (b: number, p: number, w: number): string => `repeat forever:
    if my_id() == 0:
        while bots() < ${b} and coins() >= bot_cost():
            buy_bot
        while len(plots()) < ${p} and coins() >= plot_cost():
            n = len(plots())
            buy_plot n % ${w}, (n - n % ${w}) / ${w}
    for each tile in tiles():
        if tile.x % bots() == my_id():
            go_to tile
            if scan().ripe:
                harvest
            if scan().empty:
                till
                plant carrot
    go_to barn
    deposit
    sell carrot, all
    wait 5
`;
const world = createWorld({ id: 'bench', seed: 20261116 }, { coins: 100_000_000 });
const run = createRun(world, stressSource(B, P, WIDTH), { engine: engine as 'compiled' | 'reference' });
for (let i = 0; i < 1500; i++) run.step(1);
run.takeLog();
const orig = world.tick;
const t0 = performance.now();
for (let done = 0; done < T; done += 250) run.step(Math.min(250, T - done));
const total = performance.now() - t0;
console.log(JSON.stringify({ engine, bots: world.bots.length, plots: world.plots.length, ticks: world.tick - orig, ticksPerSecond: Math.round(((world.tick - orig) / total) * 1000), msPerTick: +(total / (world.tick - orig)).toFixed(3), steps: run.steps }));
