import * as THREE from 'three';
import { describeMarket, type MarketView } from '@tendril/sim/src/index.ts';

export interface MarketTableInput { prices: readonly number[]; multipliers: readonly number[]; shares: readonly number[] | null }

export function todayUTC(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** The board for today: a countdown before MARKET_EPOCH, rows once a table exists. */
export function marketView(date = todayUTC(), table?: MarketTableInput | null): MarketView | null {
  return describeMarket(date, table ?? null);
}

const LENS_LO = new THREE.Color(0x3b6fa8);
const LENS_MID = new THREE.Color(0xcfe0c8);
const LENS_HI = new THREE.Color(0xff8a2e);

/** Price lens: permille multiplier (500..2000) to cool-blue → neutral → hot-orange. */
export function lensColor(multiplierPermille: number, out: THREE.Color): THREE.Color {
  const t = THREE.MathUtils.clamp((Math.log(multiplierPermille / 1000) - Math.log(0.5)) / Math.log(4), 0, 1);
  return t < 0.5 ? out.copy(LENS_LO).lerp(LENS_MID, t * 2) : out.copy(LENS_MID).lerp(LENS_HI, (t - 0.5) * 2);
}

/**
 * The shared-market pill on the stage. Before 2026-12-08 it counts the days down;
 * afterwards it lists today's rows when a table is supplied. Absent host: no-op.
 */
export class MarketCard {
  private timer = 0;
  private table: MarketTableInput | null = null;

  constructor(private host: HTMLElement | null) {
    if (!host) return;
    this.render();
    this.timer = window.setInterval(this.render, 60_000);
  }

  setTable(table: MarketTableInput | null): void {
    this.table = table;
    this.render();
  }

  private render = (): void => {
    if (!this.host) return;
    const view = marketView(todayUTC(), this.table);
    if (!view) { this.host.hidden = true; return; }
    this.host.hidden = false;
    this.host.textContent = view.kind === 'soon' ? `Shared market · ${view.text.toLowerCase()}` : view.text;
    this.host.title = view.kind === 'soon' ? 'Daily prices start on 2026-12-08; until then every day sells at base price.' : view.rows.map((row) => `${row.name} ${row.price} (${row.change})`).join(', ');
  };

  dispose(): void {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = 0;
  }
}
