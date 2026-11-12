import { execSync } from 'node:child_process';
import { cpSync, rmSync, existsSync } from 'node:fs';

const run = (cmd, env = {}) => execSync(cmd, { stdio: 'inherit', env: { ...process.env, ...env } });
run('node scripts/build-api.mjs');
run('pnpm --filter @tendril/client build', { VITE_BASE: '/play/', VITE_OUT: 'dist-web' });
run('pnpm --filter @tendril/site build');
const out = 'packages/site/dist/play';
if (existsSync(out)) rmSync(out, { recursive: true });
cpSync('packages/client/dist-web', out, { recursive: true });
console.log('web build ready: packages/site/dist (game at /play/)');
