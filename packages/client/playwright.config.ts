import { defineConfig } from '@playwright/test';

// PW_PORT and PW_OUT let several agents run E2E at once without sharing a port or a build folder.
const port = Number(process.env.PW_PORT ?? 4173);
const out = process.env.PW_OUT ?? 'dist';

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  // Software GL and the farm worker boot slowly on a 2-core runner; waits are generous, assertions stay exact.
  timeout: process.env.CI ? 90_000 : 30_000,
  expect: { timeout: process.env.CI ? 30_000 : 15_000 },
  // Two browsers on two cores starve each other (worker boot, frame-rate and clip-length specs), so CI runs one at a time.
  workers: process.env.CI ? 1 : undefined,
  use: { baseURL: `http://localhost:${port}`, launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } },
  webServer: {
    command: `pnpm exec vite build --outDir ${out} --emptyOutDir && pnpm exec vite preview --outDir ${out} --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
