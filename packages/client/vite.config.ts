import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  base: process.env.VITE_BASE ?? './',
  define: { __APP_VERSION__: JSON.stringify(version) },
  esbuild: { target: 'esnext' },
  build: {
    chunkSizeWarningLimit: 6000,
    outDir: process.env.VITE_OUT ?? 'dist',
    rollupOptions: { input: { main: fileURLToPath(new URL('./index.html', import.meta.url)), replay: fileURLToPath(new URL('./replay.html', import.meta.url)), room: fileURLToPath(new URL('./room.html', import.meta.url)) } },
  },
  worker: { format: 'es' },
  server: {
    host: '127.0.0.1',
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
  preview: { proxy: { '/api': 'http://127.0.0.1:8787' } },
});
