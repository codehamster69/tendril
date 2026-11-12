// Build-time lookup for Blender art copied by scripts/copy-renders.mjs. Returns null when an image is missing.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(process.cwd(), 'public', 'art');
export function art(name: string): string | null {
  return existsSync(join(root, `${name}.png`)) ? `/art/${name}.png` : null;
}
