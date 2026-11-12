# B6 terminal play (CLI)
Changed: packages/lang/src/cli.ts (new commands, shebang), src/arena-cli.ts (login, daily, challenge, submit, token store), test/cli-arena.test.ts, packages/site/src/pages/docs/cli.mdx.
Decisions: token in `$TENDRIL_CONFIG_DIR` or `~/.config/tendril/auth.json` (dir 0700, file 0600); last run in last-run.json; `TENDRIL_API`/`TENDRIL_TOKEN` env. Score is recomputed locally with replayWithPar, same as the server.
Verification: the test runs the CLI against a real local server (in-memory DB); submitted net worth equals the printed one; file modes checked.
Blocker: npm publish waits for Rohan. `@tendril/lang` is still private and `bin` points at a .ts file needing `--experimental-transform-types`, so `npx` needs a build step or published JS before release.
