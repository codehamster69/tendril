import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.VITE_BASE ?? './',
  esbuild: { target: 'esnext' },
  build: { chunkSizeWarningLimit: 6000, outDir: process.env.VITE_OUT ?? 'dist' },
  worker: { format: 'es' },
  server: {
    host: '127.0.0.1',
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
  preview: { proxy: { '/api': 'http://127.0.0.1:8787' } },
});
