/** Replay clip export: records a time-lapse of the replay panes plus a caption bar, all in the browser. */

export interface ClipOptions {
  /** Farm canvases to draw, left to right (one run, or two for a race). */
  canvases: HTMLCanvasElement[];
  /** Names shown over each pane. */
  names: string[];
  /** Moves every pane to this tick and renders it. */
  seek(tick: number): void;
  total: number;
  /** Caption line, e.g. "Daily #1 · alice · 12,345". */
  caption: string;
  site?: string;
  /** Clip length in ms. The last second holds the final frame. */
  durationMs?: number;
  onProgress?(fraction: number): void;
}

export interface ClipResult { blob: Blob; mime: string; extension: 'webm' | 'mp4' }

const W = 1280, H = 720, BAR = 76, FPS = 30;
const TYPES: [string, 'webm' | 'mp4'][] = [
  ['video/webm;codecs=vp9', 'webm'], ['video/webm;codecs=vp8', 'webm'], ['video/webm', 'webm'], ['video/mp4', 'mp4'],
];

/** Returns the best recordable type, or null when this browser cannot record a canvas (older Safari). */
export function clipSupport(): { mime: string; extension: 'webm' | 'mp4' } | null {
  if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) return null;
  for (const [mime, extension] of TYPES) if (MediaRecorder.isTypeSupported(mime)) return { mime, extension };
  return null;
}

export const UNSUPPORTED_MESSAGE = 'Clip export is not supported in this browser. Try Chrome, Edge or Firefox.';

export async function exportClip(opts: ClipOptions): Promise<ClipResult> {
  const support = clipSupport();
  if (!support) throw new Error(UNSUPPORTED_MESSAGE);
  const duration = opts.durationMs ?? 10_000;
  const play = duration - 1000; // time-lapse part; the rest holds the final frame
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const g = out.getContext('2d')!;
  const stream = out.captureStream(FPS);
  const recorder = new MediaRecorder(stream, { mimeType: support.mime, videoBitsPerSecond: 3_500_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });

  const n = opts.canvases.length;
  const paneW = W / n, paneH = H - BAR;
  const draw = (tick: number): void => {
    opts.seek(tick);
    g.fillStyle = '#0F2C31';
    g.fillRect(0, 0, W, H);
    opts.canvases.forEach((c, i) => {
      // Cover-fit the farm canvas into its pane.
      const s = Math.max(paneW / c.width, paneH / c.height);
      const sw = paneW / s, sh = paneH / s;
      g.drawImage(c, (c.width - sw) / 2, (c.height - sh) / 2, sw, sh, i * paneW, 0, paneW, paneH);
      if (n > 1) {
        g.fillStyle = 'rgba(15,44,49,0.75)';
        g.fillRect(i * paneW, 0, paneW, 34);
        g.fillStyle = '#EAF2E3';
        g.font = '700 20px system-ui, sans-serif';
        g.textAlign = 'center';
        g.fillText(opts.names[i] ?? '', i * paneW + paneW / 2, 24);
      }
    });
    g.fillStyle = '#0F2C31';
    g.fillRect(0, paneH, W, BAR);
    g.fillStyle = '#FFD66A';
    g.fillRect(0, paneH, W, 3);
    g.textAlign = 'left';
    g.fillStyle = '#EAF2E3';
    g.font = '700 30px system-ui, sans-serif';
    g.fillText(opts.caption, 24, paneH + 48);
    g.textAlign = 'right';
    g.fillStyle = '#FFD66A';
    g.fillText(opts.site ?? location.host, W - 24, paneH + 48);
    // Thin progress line so a viewer sees the time-lapse advance.
    g.fillStyle = '#9DB8B0';
    g.fillRect(0, H - 4, W * (tick / Math.max(1, opts.total)), 4);
  };

  draw(0);
  recorder.start(250);
  const start = performance.now();
  // The FarmView render loop registered its rAF first, so this callback runs after it in every frame
  // and the WebGL canvases still hold the frame just drawn.
  await new Promise<void>((resolve) => {
    const frame = (now: number): void => {
      const t = now - start;
      draw(Math.min(opts.total, Math.round(opts.total * Math.min(1, t / play))));
      opts.onProgress?.(Math.min(1, t / duration));
      if (t >= duration) resolve(); else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  recorder.stop();
  await stopped;
  stream.getTracks().forEach((t) => t.stop());
  return { blob: new Blob(chunks, { type: support.mime.split(';')[0] }), mime: support.mime, extension: support.extension };
}

export function downloadClip(result: ClipResult, name: string): void {
  const url = URL.createObjectURL(result.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.${result.extension}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
