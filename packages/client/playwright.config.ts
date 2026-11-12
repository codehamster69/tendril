import { defineConfig } from '@playwright/test';

// PW_PORT and PW_OUT let several agents run E2E at once without sharing a port or a build folder.
const port = Number(process.env.PW_PORT ?? 4173);
const out = process.env.PW_OUT ?? 'dist';

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  // Software GL and the farm worker boot slowly when workers share few cores; waits are generous, assertions stay exact.
  expect: { timeout: 15_000 },
  use: { baseURL: `http://localhost:${port}`, launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } },
  webServer: {
    command: `pnpm exec vite build --outDir ${out} --emptyOutDir && pnpm exec vite preview --outDir ${out} --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
