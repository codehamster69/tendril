// Builds the publishable CLI package into packages/lang/dist-npm.
// The workspace package stays private; this stages a self-contained copy (one bundled JS file, no dependencies).
// Usage: node scripts/pack-cli.mjs [--name tendril-cli] [--version 0.2.2]   then: npm publish packages/lang/dist-npm
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'packages/lang/dist-npm');
const arg = (flag, fallback) => { const i = process.argv.indexOf(flag); return i < 0 ? fallback : process.argv[i + 1] ?? fallback; };
const name = arg('--name', 'tendril-cli');
const version = arg('--version', JSON.parse(readFileSync(join(root, 'packages/client/package.json'), 'utf8')).version);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(root, 'packages/lang/src/cli.ts')],
  outfile: join(out, 'cli.js'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'warning',
});
chmodSync(join(out, 'cli.js'), 0o755);
copyFileSync(join(root, 'LICENSE'), join(out, 'LICENSE'));

writeFileSync(join(out, 'package.json'), JSON.stringify({
  name, version,
  license: 'AGPL-3.0-or-later',
  description: 'Command-line runner for Tendril: run Sprout farm programs locally, play the daily challenge and submit verified runs.',
  type: 'module',
  bin: { tendril: 'cli.js' },
  files: ['cli.js', 'README.md', 'LICENSE'],
  engines: { node: '>=22' },
  homepage: 'https://tendril.hokora.xyz/docs/cli/',
  repository: { type: 'git', url: 'git+https://github.com/codehamster69/tendril.git', directory: 'packages/lang' },
  keywords: ['tendril', 'sprout', 'farming', 'programming-game', 'cli'],
}, null, 2) + '\n');

writeFileSync(join(out, 'README.md'), `# ${name}

The terminal client for [Tendril](https://tendril.hokora.xyz), a daily coding puzzle where the server replays every move.

\`\`\`
npm install -g ${name}
tendril run my.sprout --seed 42 --ticks 3000   # run a Sprout program locally
tendril login                                  # sign in through the browser
tendril daily my.sprout                        # play today's challenge
tendril submit                                 # send the last run for verification
\`\`\`

Needs Node 22 or newer. Licensed under AGPL-3.0-or-later. See the [CLI docs](https://tendril.hokora.xyz/docs/cli/).
`);
console.log(`Staged ${name}@${version} in ${out}`);
