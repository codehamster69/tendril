import * as THREE from 'three';
import './farm-market.css';
import { CROP_COLORS, ITEM_NAMES } from './fallback-models';
import { bestItem, buildCard, formatCountdown, multLabel, multiplierTable, popupText, secondsToUtcMidnight, type CardModel, type MarketData } from './farm-market-format';
export type { MarketData };

const MAX_POPUPS = 8;
const POPUP_GAP_MS = 90;
const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;

/** Shared market in the farm view: DOM card, price multipliers for the lens, stall with a sign, harvest popups. */
export class FarmMarket {
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly head: HTMLButtonElement;
  private lastKind: CardModel['kind'] = 'base';
  private readonly bestEl: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly layer: HTMLElement;
  private readonly pool: HTMLElement[] = [];
  private active = 0;
  private lastPop = 0;
  private hidden = false;
  private card: CardModel = buildCard(null);
  private mults: number[] | null = null;
  private clock = 0;
  private stall: THREE.Group | null = null;
  private readonly signCanvas = document.createElement('canvas');
  private readonly signTex: THREE.CanvasTexture;
  private readonly scene: THREE.Scene;
  private readonly timers = new Set<number>();
  private disposed = false;

  constructor(private readonly stage: HTMLElement, scene: THREE.Scene) {
    this.scene = scene;
    this.signCanvas.width = 256; this.signCanvas.height = 128;
    this.signTex = new THREE.CanvasTexture(this.signCanvas);
    this.signTex.colorSpace = THREE.SRGBColorSpace;

    this.root = document.createElement('section');
    this.root.className = 'farm-market';
    this.root.setAttribute('aria-label', 'Shared market');
    this.root.dataset.testid = 'farm-market';
    const head = document.createElement('button');
    head.type = 'button'; head.className = 'farm-market-head';
    head.setAttribute('aria-expanded', 'false');
    this.head = head;
    const title = document.createElement('span'); title.className = 'farm-market-title'; title.textContent = 'Shared market';
    this.bestEl = document.createElement('span'); this.bestEl.className = 'farm-market-best';
    head.append(title, this.bestEl);
    head.addEventListener('click', () => this.setExpanded(this.root.classList.contains('collapsed')));
    this.body = document.createElement('div'); this.body.className = 'farm-market-body';
    this.countEl = document.createElement('span');
    this.root.append(head, this.body);
    // A small pill until a market day starts; hidden when there is no market (sandbox, live, campaign).
    this.root.classList.add('collapsed');
    this.root.hidden = true;
    this.layer = document.createElement('div'); this.layer.className = 'farm-pop-layer'; this.layer.setAttribute('aria-hidden', 'true');
    stage.append(this.root, this.layer);
    this.render();
  }

  /** 0.5..2 per item id for the price lens, or null at base prices. */
  get multipliers(): number[] | null { return this.mults; }

  setMarket(m: MarketData | null, opts?: { opensInDays?: number }): void {
    const days = opts?.opensInDays ?? 0;
    this.card = buildCard(m, days);
    this.mults = days > 0 ? null : multiplierTable(m);
    this.render();
    const kind = this.card.kind;
    this.root.hidden = kind === 'base';
    // Expand when a market day starts; the player's own collapse then stays until the next day.
    if (kind === 'open' && this.lastKind !== 'open') this.setExpanded(true);
    else if (kind !== 'open') this.setExpanded(false);
    this.lastKind = kind;
    this.drawSign();
  }

  private setExpanded(open: boolean): void {
    this.root.classList.toggle('collapsed', !open);
    this.head.setAttribute('aria-expanded', String(open));
  }

  /** Little stall next to the barn, sign facing the camera default. */
  setStallAt(x: number, z: number): void {
    if (!this.stall) this.stall = this.buildStall();
    this.stall.position.set(x, 0, z);
    if (!this.stall.parent) this.scene.add(this.stall);
    this.drawSign();
  }

  /** Floating "+coins xN" over tile (x, z). Pooled, rate limited, skipped when off screen or while hidden (Map LOD). */
  popup(camera: THREE.Camera, x: number, z: number, coins: number, multiplier: number): void {
    if (this.hidden || this.disposed || this.active >= MAX_POPUPS) return;
    const now = performance.now();
    if (now - this.lastPop < POPUP_GAP_MS) return;
    const v = new THREE.Vector3(x, 0.9, z).project(camera);
    if (v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) return;
    this.lastPop = now;
    const el = this.pool.pop() ?? document.createElement('div');
    el.className = `farm-pop${multiplier < 1 ? ' low' : ''}`;
    el.textContent = popupText(coins, multiplier);
    el.style.left = `${((v.x + 1) / 2) * this.stage.clientWidth}px`;
    el.style.top = `${((1 - v.y) / 2) * this.stage.clientHeight}px`;
    this.layer.appendChild(el);
    this.active++;
    const id = window.setTimeout(() => {
      this.timers.delete(id); el.remove(); this.active--; this.pool.push(el);
    }, 1000);
    this.timers.add(id);
  }

  /** Integration calls this with true at Map LOD: popups are dropped there. */
  setPopupsHidden(h: boolean): void { this.hidden = h; }

  update(dt: number): void {
    this.clock += dt;
    if (this.clock < 1) return;
    this.clock = 0;
    this.countEl.textContent = formatCountdown(secondsToUtcMidnight(Date.now()));
  }

  dispose(): void {
    this.disposed = true;
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    this.root.remove(); this.layer.remove();
    if (this.stall) {
      this.scene.remove(this.stall);
      this.stall.traverse((o) => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); const m = o.material as THREE.Material; m.dispose(); } });
      this.stall = null;
    }
    this.signTex.dispose();
  }

  private render(): void {
    const c = this.card;
    const body = this.body;
    body.replaceChildren();
    this.bestEl.textContent = c.best ? `${c.best.name} ${c.best.mult}` : c.kind === 'soon' ? 'soon' : 'base';
    if (c.rows.length) {
      const list = document.createElement('ul'); list.className = 'farm-market-rows';
      for (const r of c.rows) {
        const li = document.createElement('li'); li.className = 'farm-market-row';
        li.dataset.item = String(r.item);
        const dot = document.createElement('i'); dot.className = 'farm-market-dot'; dot.style.background = hex(CROP_COLORS[r.item] ?? 0x8fbf6a);
        const name = document.createElement('span'); name.className = 'farm-market-name'; name.textContent = ITEM_NAMES[r.item] ?? r.name;
        const gauge = document.createElement('div'); gauge.className = 'farm-market-gauge';
        gauge.setAttribute('role', 'img'); gauge.setAttribute('aria-label', `${r.name} price ${r.mult}, ${r.change} against base`);
        const mark = document.createElement('b'); mark.style.left = `${r.gauge.toFixed(1)}%`; gauge.append(mark);
        const val = document.createElement('span'); val.className = `farm-market-val ${r.trend === 'flat' ? '' : r.trend}`; val.textContent = `${r.mult} ${r.arrow}`;
        val.title = `${r.price} coins (${r.change})`;
        li.append(dot, name, gauge, val);
        if (r.share) { const s = document.createElement('span'); s.className = 'farm-market-share'; s.textContent = `${r.share} of units sold yesterday`; li.append(s); }
        list.append(li);
      }
      body.append(list);
    }
    const note = document.createElement('div'); note.className = 'farm-market-note'; note.textContent = c.note;
    body.append(note);
    if (c.kind === 'open') {
      const foot = document.createElement('div'); foot.className = 'farm-market-foot';
      const l = document.createElement('span'); l.textContent = 'Base 100% · range 50–200%';
      const r = document.createElement('span'); r.append('Next prices in ', this.countEl);
      this.countEl.textContent = formatCountdown(secondsToUtcMidnight(Date.now()));
      foot.append(l, r); body.append(foot);
    }
  }

  private drawSign(): void {
    const g = this.signCanvas.getContext('2d');
    if (!g) return;
    g.fillStyle = '#1b3a3f'; g.fillRect(0, 0, 256, 128);
    g.fillStyle = '#f2c260'; g.font = '600 22px monospace'; g.textBaseline = 'alphabetic';
    const best = this.mults ? bestItem(this.mults) : 0;
    if (best > 0 && this.mults) {
      g.fillText('MARKET', 14, 32);
      g.fillStyle = hex(CROP_COLORS[best] ?? 0x8fbf6a); g.fillRect(14, 56, 22, 22);
      g.fillStyle = '#e4efec'; g.font = '600 28px monospace';
      g.fillText(`${ITEM_NAMES[best] ?? ''} ${multLabel(this.mults[best]!)}`, 46, 78);
      g.fillStyle = '#8aa9a4'; g.font = '16px monospace'; g.fillText('best price today', 14, 108);
    } else {
      g.fillText('MARKET', 14, 32);
      g.fillStyle = '#e4efec'; g.font = '600 28px monospace'; g.fillText(this.card.kind === 'soon' ? 'opens soon' : 'base prices', 14, 78);
    }
    this.signTex.needsUpdate = true;
  }

  private buildStall(): THREE.Group {
    const g = new THREE.Group(); g.name = 'farm-market-stall'; g.rotation.y = -0.4;
    const wood = new THREE.MeshStandardMaterial({ color: 0x8a5a3a, roughness: 0.9, flatShading: true });
    const awnMat = new THREE.MeshStandardMaterial({ color: 0x4fd1b0, roughness: 0.8 });
    const counter = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.3, 0.3).translate(0, 0.15, 0.15), wood);
    const awn = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.04, 0.5).translate(0, 0.62, 0.12), awnMat); awn.rotation.x = 0.25;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.28).translate(0, 0.8, -0.1), new THREE.MeshBasicMaterial({ map: this.signTex })); sign.rotation.x = -0.15;
    const p1 = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.6, 0.04).translate(-0.36, 0.3, 0.3), wood);
    const p2 = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.6, 0.04).translate(0.36, 0.3, 0.3), wood);
    for (const m of [counter, awn, sign, p1, p2]) { m.castShadow = true; g.add(m); }
    return g;
  }
}
