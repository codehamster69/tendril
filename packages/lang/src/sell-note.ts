import { sellPlotRefusal, silosActive } from '@tendril/sim/src/index.ts';
import type { World } from '@tendril/sim/src/index.ts';
import type { OutputLine } from './interpreter.ts';

/** After a sell_plot that paid 0: say why in the console. The same reason repeats at most every 200 ticks, so 33 bots do not flood it. */
export function explainSellRefusal(output: OutputLine[], memo: Map<string, number>, w: World, bot: number, px: number, py: number): void {
  if (!silosActive(w)) return; // before rules v5 the command is a plain no-op
  const why = sellPlotRefusal(w, px, py);
  if (why === null || output.length >= 2000) return;
  const seen = memo.get(why);
  if (seen !== undefined && w.tick - seen < 200) return;
  memo.set(why, w.tick);
  output.push({ bot, tick: w.tick, text: `sell_plot ${px}, ${py} paid nothing. ${why}` });
}
