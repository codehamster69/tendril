import * as THREE from 'three';
import { CROP_COLORS } from './fallback-models.ts';

export interface MinimapTile { x: number; y: number; tilled: number; crop: number; stage: number }
export interface MinimapBot { x: number; z: number; color: number }

const YOUNG = new THREE.Color(0x5fae5a);
const GRASS = '#2f6a46';
const SOIL = '#5a3d31';
const PATH = '#d1b98a';

/**
 * Canvas minimap of the owned land. Only touched tiles are drawn, so the cost
 * follows what the player built, never the farm's bounding box.
 */
export class FarmMinimap {
  private context: CanvasRenderingContext2D;
  private dragging = false;
  private terrain: HTMLCanvasElement;
  private terrainTiles: MinimapTile[] | null = null;
  private bounds = { x0: 0, x1: 0, z0: 0, z1: 0 };

  constructor(private canvas: HTMLCanvasElement, private onNavigate: (x: number, z: number) => void) {
    this.context = canvas.getContext('2d')!;
    this.terrain = canvas.ownerDocument.createElement('canvas');
    canvas.addEventListener('pointerdown', this.pointerDown);
    canvas.addEventListener('pointermove', this.pointerMove);
    canvas.addEventListener('pointerup', this.pointerUp);
  }

  private scale(): number { return (this.canvas.width - 20) / Math.max(this.bounds.x1 - this.bounds.x0, this.bounds.z1 - this.bounds.z0, 1); }

  setBounds(bounds: { x0: number; x1: number; z0: number; z1: number }): void {
    if (bounds.x0 !== this.bounds.x0 || bounds.x1 !== this.bounds.x1 || bounds.z0 !== this.bounds.z0 || bounds.z1 !== this.bounds.z1) this.terrainTiles = null;
    this.bounds = { ...bounds };
  }

  update(tiles: MinimapTile[], bots: MinimapBot[], viewport: ([number, number] | null)[], selected: { x: number; y: number } | null): void {
    const context = this.context, size = this.canvas.width, pad = 10;
    const inner = size - pad * 2;
    const span = Math.max(this.bounds.x1 - this.bounds.x0, this.bounds.z1 - this.bounds.z0, 1);
    const scale = inner / span;
    const ox = pad - this.bounds.x0 * scale, oz = pad - this.bounds.z0 * scale;
    if (this.terrainTiles !== tiles || this.terrain.width !== size || this.terrain.height !== this.canvas.height) {
      this.terrain.width = size;
      this.terrain.height = this.canvas.height;
      const terrain = this.terrain.getContext('2d')!;
      terrain.fillStyle = '#0b2226';
      terrain.fillRect(0, 0, size, size);
      terrain.fillStyle = '#2b5f43';
      terrain.fillRect(ox - scale / 2, oz - scale / 2, inner + scale, inner + scale);
      const step = scale >= 1 ? 1 : 4;
      const pixel = Math.max(scale * step, 2.5);
      for (const tile of tiles) {
        if (step > 1 && (tile.x % step !== 0 || tile.y % step !== 0)) continue;
        terrain.fillStyle = tile.x === 0 && tile.y === 0 ? PATH
          : tile.crop ? '#' + new THREE.Color(YOUNG).lerp(new THREE.Color(CROP_COLORS[tile.crop] ?? 0x8fbf6a), (tile.stage / 3) ** 2).getHexString()
            : tile.tilled ? SOIL : GRASS;
        terrain.fillRect(ox + tile.x * scale - (pixel - scale) / 2, oz + tile.y * scale - (pixel - scale) / 2, pixel, pixel);
      }
      this.terrainTiles = tiles;
    }
    context.drawImage(this.terrain, 0, 0);
    const points = viewport.filter((p): p is [number, number] => p !== null);
    if (points.length === 4) {
      context.save();
      context.beginPath();
      points.forEach(([x, z], i) => { const px = ox + x * scale, py = oz + z * scale; if (i) context.lineTo(px, py); else context.moveTo(px, py); });
      context.closePath();
      context.strokeStyle = '#f2c260';
      context.lineWidth = 3;
      context.fillStyle = 'rgba(242,194,96,0.08)';
      context.fill();
      context.stroke();
      context.restore();
    }
    for (const bot of bots) {
      context.fillStyle = '#' + new THREE.Color(bot.color).getHexString();
      context.beginPath();
      context.arc(ox + bot.x * scale, oz + bot.z * scale, 5, 0, 6.3);
      context.fill();
      context.strokeStyle = '#06161a';
      context.lineWidth = 2;
      context.stroke();
    }
    if (selected) {
      context.strokeStyle = '#fff';
      context.lineWidth = 2;
      const edge = Math.max(5, scale);
      context.strokeRect(ox + selected.x * scale - edge / 2, oz + selected.y * scale - edge / 2, edge, edge);
    }
  }

  private navigate(event: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const scale = this.scale();
    const x = ((event.clientX - rect.left) / rect.width * this.canvas.width - 10) / scale + this.bounds.x0;
    const z = ((event.clientY - rect.top) / rect.height * this.canvas.height - 10) / scale + this.bounds.z0;
    this.onNavigate(x, z);
  }

  private pointerDown = (event: PointerEvent): void => { this.canvas.setPointerCapture(event.pointerId); this.dragging = true; this.navigate(event); };
  private pointerMove = (event: PointerEvent): void => { if (this.dragging) this.navigate(event); };
  private pointerUp = (): void => { this.dragging = false; };

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.pointerDown);
    this.canvas.removeEventListener('pointermove', this.pointerMove);
    this.canvas.removeEventListener('pointerup', this.pointerUp);
  }
}
